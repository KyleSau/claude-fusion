import * as vscode from 'vscode';
import { stripFooter } from '../core/transcript';
import type { BlockParam, Msg, StreamEvent, TextBlockParam, Tool, TurnSink } from '../core/types';

/** `LanguageModelChatMessageRole.System` from VS Code's proposed API; Copilot Chat sends it. */
const ROLE_SYSTEM = 3;

// Structural part checks: parts can come from newer or proposed API classes than the ones this
// extension was compiled against, so they are matched by shape rather than `instanceof`.
type DataLike = { mimeType: string; data: Uint8Array };
type ToolCallLike = { callId: string; name: string; input: unknown };
type ToolResultLike = { callId: string; content: readonly unknown[] };

function isText(p: unknown): p is { value: string } {
  return p instanceof vscode.LanguageModelTextPart || (typeof (p as any)?.value === 'string' && !('callId' in (p as object)));
}
function isToolCall(p: unknown): p is ToolCallLike {
  return typeof (p as any)?.callId === 'string' && typeof (p as any)?.name === 'string' && 'input' in (p as object);
}
function isToolResult(p: unknown): p is ToolResultLike {
  return typeof (p as any)?.callId === 'string' && Array.isArray((p as any)?.content) && !('name' in (p as object));
}
function isData(p: unknown): p is DataLike {
  return typeof (p as any)?.mimeType === 'string' && (p as any)?.data instanceof Uint8Array;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Tool names must match `^[a-zA-Z0-9_-]{1,128}$` on the Messages API; VS Code allows more. */
export function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'tool';
}

/** Collects the text inside a `@vscode/prompt-tsx` JSON tree (used by some tool results). */
function promptTsxText(value: unknown): string {
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') out.push(node.text);
    if (node.node) walk(node.node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(value);
  return out.join('');
}

function dataBlock(p: DataLike): BlockParam | undefined {
  const mime = p.mimeType.toLowerCase();
  if (IMAGE_TYPES.has(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime as 'image/png', data: Buffer.from(p.data).toString('base64') } };
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    const text = Buffer.from(p.data).toString('utf8');
    return text ? { type: 'text', text } : undefined;
  }
  return undefined; // cache hints, stateful markers and other provider-specific data
}

function toolResultContent(parts: readonly unknown[]): Array<TextBlockParam | BlockParam> {
  const out: Array<TextBlockParam | BlockParam> = [];
  for (const p of parts) {
    if (isText(p)) {
      if (p.value) out.push({ type: 'text', text: p.value });
    } else if (isData(p)) {
      const b = dataBlock(p);
      if (b) out.push(b);
    } else if (p && typeof p === 'object' && 'value' in p) {
      const text = promptTsxText((p as { value: unknown }).value);
      if (text) out.push({ type: 'text', text });
    }
  }
  return out.length ? out : [{ type: 'text', text: '(no output)' }];
}

export interface Converted {
  system: TextBlockParam[];
  messages: Msg[];
}

/** VS Code chat messages → Messages API history. */
export function fromVsCode(messages: readonly vscode.LanguageModelChatRequestMessage[]): Converted {
  const system: TextBlockParam[] = [];
  const out: Msg[] = [];
  for (const m of messages) {
    const role = m.role as number;
    if (role === ROLE_SYSTEM) {
      const text = m.content.filter(isText).map((p) => p.value).join('\n').trim();
      if (!text) continue;
      if (!out.length) system.push({ type: 'text', text });
      else if (out[out.length - 1].role === 'user') out.push({ role: 'system', content: text });
      else out.push({ role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] });
      continue;
    }
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
      const text = stripFooter(m.content.filter(isText).map((p) => p.value).join('')).trim();
      const content: BlockParam[] = text ? [{ type: 'text', text }] : [];
      for (const p of m.content) {
        if (isToolCall(p)) content.push({ type: 'tool_use', id: p.callId, name: safeToolName(p.name), input: (p.input ?? {}) as Record<string, unknown> });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    const results: BlockParam[] = [];
    const rest: BlockParam[] = [];
    for (const p of m.content) {
      if (isToolResult(p)) results.push({ type: 'tool_result', tool_use_id: p.callId, content: toolResultContent(p.content) as any });
      else if (isText(p)) {
        if (p.value) rest.push({ type: 'text', text: p.value });
      } else if (isData(p)) {
        const b = dataBlock(p);
        if (b) rest.push(b);
      }
    }
    // The Messages API wants tool results first in their user turn.
    const content = [...results, ...rest];
    if (content.length) out.push({ role: 'user', content });
  }
  return { system, messages: out };
}

export function toolsFromVsCode(tools: readonly vscode.LanguageModelChatTool[] | undefined): { tools: Tool[]; names: Map<string, string> } {
  const names = new Map<string, string>();
  const out: Tool[] = [];
  for (const t of tools ?? []) {
    const name = safeToolName(t.name);
    names.set(name, t.name);
    const schema = (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {}) as Record<string, unknown>;
    out.push({
      name,
      description: t.description || t.name,
      input_schema: { ...schema, type: 'object', properties: (schema.properties as Record<string, unknown>) ?? {} },
    });
  }
  return { tools: out, names };
}

interface OpenBlock {
  type: string;
  id?: string;
  name?: string;
  json: string;
  thinking: string;
}

/**
 * Streams a Fusion turn into VS Code's chat: text as it arrives, tool calls only once the whole
 * message has completed (so a failed or truncated step never reaches the editor as a partial edit).
 */
export class VsCodeSink implements TurnSink {
  private readonly open = new Map<number, OpenBlock>();
  private readonly calls: vscode.LanguageModelToolCallPart[] = [];
  private pendingNotes: string[] = [];
  private stopReason: string | null = null;
  wroteText = false;

  constructor(
    private readonly progressPart: vscode.Progress<vscode.LanguageModelResponsePart>,
    private readonly toolNames: Map<string, string>,
    private readonly showNotes: boolean,
    private readonly onProgress?: TurnSink['progress'],
  ) {}

  progress: TurnSink['progress'] = (p) => this.onProgress?.(p);

  event(e: StreamEvent): void {
    switch (e.type) {
      case 'message_start':
        this.open.clear();
        this.calls.length = 0;
        this.pendingNotes = [];
        this.stopReason = null;
        break;
      case 'content_block_start': {
        const b = e.content_block as { type: string; id?: string; name?: string };
        this.open.set(e.index, { type: b.type, id: b.id, name: b.name, json: '', thinking: '' });
        if (b.type === 'tool_use') this.flushNotes();
        break;
      }
      case 'content_block_delta': {
        const block = this.open.get(e.index);
        const d = e.delta;
        if (d.type === 'text_delta' && d.text) this.text(d.text);
        else if (d.type === 'input_json_delta' && block) block.json += d.partial_json;
        else if (d.type === 'thinking_delta' && block) block.thinking += d.thinking;
        break;
      }
      case 'content_block_stop': {
        const block = this.open.get(e.index);
        if (block?.type === 'tool_use' && block.id && block.name) {
          let input: object = {};
          try {
            input = block.json ? JSON.parse(block.json) : {};
          } catch {
            throw new Error(`Fusion: the model produced malformed arguments for ${block.name}`);
          }
          this.calls.push(new vscode.LanguageModelToolCallPart(block.id, this.toolNames.get(block.name) ?? block.name, input));
        } else if (block?.type === 'thinking' && this.showNotes && block.thinking.trim()) {
          // Progress notes ("updates" display) are shown only before tool calls, never on a final answer.
          this.pendingNotes.push(block.thinking.trim());
        }
        break;
      }
      case 'message_delta':
        this.stopReason = e.delta.stop_reason ?? this.stopReason;
        break;
      case 'message_stop':
        this.flushCalls();
        break;
    }
  }

  private text(value: string): void {
    this.wroteText = true;
    this.progressPart.report(new vscode.LanguageModelTextPart(value));
  }

  private flushNotes(): void {
    if (!this.pendingNotes.length) return;
    const notes = this.pendingNotes.map((n) => `_${n.replace(/\s+/g, ' ')}_`).join('\n\n');
    this.pendingNotes = [];
    this.text(`${this.wroteText ? '\n\n' : ''}${notes}\n\n`);
  }

  private flushCalls(): void {
    if (!this.calls.length) return;
    if (this.stopReason === 'max_tokens') {
      this.calls.length = 0;
      throw new Error('Fusion: the response hit the output token limit in the middle of a tool call. Ask again or raise the limit.');
    }
    for (const call of this.calls.splice(0)) this.progressPart.report(call);
  }
}
