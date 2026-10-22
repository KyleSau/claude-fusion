import { createHash } from 'node:crypto';
import type { ApiMessage, ContentBlock, Msg } from './types';

// Loose block shape: lets one set of helpers read request params, response blocks and
// converted client messages alike.
type AnyBlock = { type: string; [key: string]: any };

export function blocksOf(content: unknown): AnyBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? (content as AnyBlock[]) : [];
}

export function textOf(content: unknown): string {
  return blocksOf(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function hasToolResults(m: Msg | undefined): boolean {
  return !!m && m.role === 'user' && blocksOf(m.content).some((b) => b.type === 'tool_result');
}

export function toolUseIds(content: unknown): string[] {
  return blocksOf(content)
    .filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use')
    .map((b) => String(b.id));
}

export function hasToolUse(message: Pick<ApiMessage, 'content'>): boolean {
  return message.content.some((b) => b.type === 'tool_use');
}

/** The visible answer text of a response. */
export function finalText(message: Pick<ApiMessage, 'content'>): string {
  return textOf(message.content).trim();
}

/** Index of the latest user message that carries a new request rather than tool results. */
export function lastRequestIndex(messages: readonly Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const blocks = blocksOf(m.content);
    if (blocks.some((b) => b.type === 'tool_result')) continue;
    if (blocks.some((b) => (b.type === 'text' && b.text?.trim()) || b.type === 'image' || b.type === 'document')) return i;
  }
  return -1;
}

const CONTEXT_TAGS = ['system-reminder', 'attachments', 'attachment', 'context', 'reminderInstructions', 'environment_info', 'workspace_info'];

/**
 * Splits a user message into the request itself and the context a client wrapped around it.
 * Copilot puts the request in `<userRequest>`; Claude Code adds `<system-reminder>` blocks.
 */
export function splitRequest(raw: string): { request: string; context: string } {
  const tagged = /<userRequest>([\s\S]*?)<\/userRequest>/i.exec(raw);
  if (tagged) {
    return { request: tagged[1].trim(), context: raw.replace(tagged[0], '').trim() };
  }
  let request = raw;
  const context: string[] = [];
  for (const tag of CONTEXT_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    request = request.replace(re, (m) => {
      context.push(m);
      return '';
    });
  }
  return { request: request.trim(), context: context.join('\n').trim() };
}

export function requestText(messages: readonly Msg[]): { request: string; context: string } {
  const i = lastRequestIndex(messages);
  if (i < 0) return { request: '', context: '' };
  const blocks = blocksOf(messages[i].content);
  const images = blocks.filter((b) => b.type === 'image' || b.type === 'document').length;
  const split = splitRequest(textOf(blocks));
  return images ? { ...split, request: `${split.request}\n[${images} image/document attachment(s)]` } : split;
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - 40);
  const head = Math.ceil(keep * 0.6);
  return `${s.slice(0, head)}\n…[${s.length - keep} chars omitted]…\n${s.slice(s.length - (keep - head))}`;
}

function oneLine(s: string, max: number): string {
  return truncateMiddle(s.replace(/\s+/g, ' ').trim(), max);
}

function resultText(block: AnyBlock): string {
  if (typeof block.content === 'string') return block.content;
  return blocksOf(block.content)
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join(' ');
}

export interface WorkSummary {
  request: string;
  context: string;
  earlier: string;
  log: string;
  steps: number;
}

/**
 * Condenses the current task (everything since the latest user request) into plain text for the
 * tool-less gate and critic: what was asked, what was done, what came back.
 */
export function condenseWork(messages: readonly Msg[], maxChars = 24_000): WorkSummary {
  const start = lastRequestIndex(messages);
  const { request, context } = requestText(messages);

  const earlierRequests: string[] = [];
  for (let i = start - 1; i >= 0 && earlierRequests.length < 2; i--) {
    const m = messages[i];
    if (m.role === 'user' && !hasToolResults(m)) {
      const t = splitRequest(textOf(m.content)).request;
      if (t) earlierRequests.unshift(`- ${oneLine(t, 400)}`);
    }
  }

  const entries: string[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    for (const b of blocksOf(m.content)) {
      if (m.role === 'assistant') {
        if (b.type === 'text' && b.text?.trim()) entries.push(`assistant: ${oneLine(b.text, 600)}`);
        else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
          entries.push(`call ${b.name}(${oneLine(JSON.stringify(b.input ?? {}), 400)})`);
        }
      } else if (m.role === 'user') {
        if (b.type === 'tool_result') entries.push(`result${b.is_error ? ' [error]' : ''}: ${oneLine(resultText(b), 500)}`);
        else if (b.type === 'text' && b.text?.trim()) entries.push(`user: ${oneLine(splitRequest(b.text).request || b.text, 400)}`);
      }
    }
  }

  let log = entries.map((e, n) => `${n + 1}. ${e}`).join('\n');
  if (log.length > maxChars) {
    const head = entries.slice(0, 6).map((e, n) => `${n + 1}. ${e}`);
    const tail: string[] = [];
    let used = head.join('\n').length + 60;
    for (let k = entries.length - 1; k >= 6; k--) {
      const line = `${k + 1}. ${entries[k]}`;
      if (used + line.length + 1 > maxChars) break;
      tail.unshift(line);
      used += line.length + 1;
    }
    const omitted = entries.length - head.length - tail.length;
    log = [...head, `…[${omitted} steps omitted]…`, ...tail].join('\n');
  }

  return {
    request: truncateMiddle(request, 8_000),
    context: truncateMiddle(context, 4_000),
    earlier: earlierRequests.join('\n'),
    log,
    steps: entries.length,
  };
}

/**
 * Appends an orchestrator note as operator text at the end of a request: a new mid-conversation
 * system message after a user turn, or an extra block on a trailing system message (Claude Code
 * ends a conversation's first request with one). Returns undefined when no valid position exists.
 */
export function appendNote(messages: readonly Msg[], note: string): Msg[] | undefined {
  const last = messages[messages.length - 1];
  if (last?.role === 'user') return [...messages, { role: 'system', content: note }];
  if (last?.role === 'system') {
    if (blocksOf(last.content).some((b) => b.type === 'text' && b.text === note)) return [...messages];
    const merged = { ...last, content: [...blocksOf(last.content), { type: 'text', text: note }] } as Msg;
    return [...messages.slice(0, -1), merged];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Turn fingerprints. Fusion recognises its own assistant turns when the client replays history,
// so it can put back what the client cannot store (injected review notes, thinking blocks).

const FOOTER_RE = /\n*---\n\*Fusion · [^\n]*\*\s*$/;

export function footerLine(summary: string): string {
  return `\n\n---\n*Fusion · ${summary.replace(/\*/g, '')}*`;
}

export function stripFooter(text: string): string {
  return text.replace(FOOTER_RE, '');
}

export function assistantFingerprint(content: unknown): string | undefined {
  const ids = toolUseIds(content);
  if (ids.length) return `tu:${ids.join(',')}`;
  const text = stripFooter(textOf(content)).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return `tx:${createHash('sha256').update(text).digest('hex').slice(0, 40)}`;
}

/** Response blocks in the shape the API accepts back, following the fallback echo rules. */
export function toParams(content: readonly ContentBlock[]): AnyBlock[] {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') lastFallback = i;
  });
  const out: AnyBlock[] = [];
  content.forEach((block, i) => {
    const b = block as AnyBlock;
    if (b.type === 'fallback') return;
    // Before a mid-output fallback, only text (and paired server tool blocks) is echoed back.
    if (i < lastFallback && ['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(b.type)) return;
    switch (b.type) {
      case 'text':
        out.push(b.citations?.length ? { type: 'text', text: b.text, citations: b.citations } : { type: 'text', text: b.text });
        break;
      case 'thinking':
        out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        break;
      case 'redacted_thinking':
        out.push({ type: 'redacted_thinking', data: b.data });
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        break;
      default:
        out.push(b);
    }
  });
  return out;
}
