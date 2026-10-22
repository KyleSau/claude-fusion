import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import * as z from 'zod/v4';
import type { Backend, CallMetrics, JsonCall, SolveCall } from '../core/backend';
import type { ModelInfo, ModelRegistry, TokenUsage } from '../core/models';
import type { Logger } from '../core/orchestrator';
import { blocksOf } from '../core/transcript';
import type { ApiMessage, ContentBlock, Msg, StreamEvent } from '../core/types';
import { VENDOR } from './provider';

const PREFIX = 'vscode:';

export function vscodeModelId(m: Pick<vscode.LanguageModelChat, 'vendor' | 'id'>): string {
  return `${PREFIX}${m.vendor}/${m.id}`;
}

function familyOf(m: vscode.LanguageModelChat): string {
  const f = `${m.family} ${m.id} ${m.name}`.toLowerCase();
  for (const family of ['claude', 'gpt', 'gemini', 'grok', 'llama', 'mistral', 'qwen', 'deepseek', 'phi']) {
    if (f.includes(family)) return family;
  }
  if (/\bo\d/.test(f)) return 'gpt';
  return m.family || m.vendor;
}

/** Rough token estimate for models that report no usage (about 4 characters per token). */
function estimate(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Uses models that other VS Code extensions provide (for example Copilot's models, or a local
 * model) as members of Fusion's pool. They are billed by their provider, so Fusion reports
 * tokens but no price for them.
 */
export class VsCodeLmBackend implements Backend {
  readonly provider = 'vscode' as const;
  private models = new Map<string, vscode.LanguageModelChat>();

  constructor(
    private readonly registry: ModelRegistry,
    private readonly log: Logger,
  ) {}

  /** Re-reads the models other extensions provide and registers them as `vscode:<vendor>/<id>`. */
  async discover(): Promise<number> {
    const all = await vscode.lm.selectChatModels();
    this.models = new Map(all.filter((m) => m.vendor !== VENDOR).map((m) => [vscodeModelId(m), m]));
    this.registry.removeProvider('vscode');
    for (const [id, m] of this.models) {
      this.registry.add({
        id,
        label: `${m.name} (${m.vendor})`,
        short: m.name,
        provider: 'vscode',
        family: familyOf(m),
        contextWindow: m.maxInputTokens,
        maxOutput: 16_000,
        efforts: [],
        systemMessages: false,
        progressUpdates: false,
        serverFallback: false,
      });
    }
    return this.models.size;
  }

  available(model: ModelInfo): boolean {
    return model.provider === 'vscode' && this.models.has(model.id);
  }

  async solve(call: SolveCall): Promise<{ message: ApiMessage; metrics: CallMetrics }> {
    const lm = this.require(call.model.id);
    const messages = toVsCodeMessages(call.system.map((b) => b.text).join('\n\n'), call.messages);
    const tools: vscode.LanguageModelChatTool[] = call.tools
      .filter((t): t is Extract<typeof t, { input_schema: unknown }> => 'input_schema' in t)
      .map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.input_schema as object }));
    const response = await lm.sendRequest(
      messages,
      { tools, justification: 'Fusion routes part of your request to this model.' },
      tokenFor(call.signal),
    );

    const id = `msg_vscode_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const content: ContentBlock[] = [];
    const emit = (e: StreamEvent) => call.onEvent?.(e);
    const usage = { input_tokens: estimate(JSON.stringify(call.messages).length), output_tokens: 0 };
    emit({
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model: call.model.id, content: [], stop_reason: null, stop_sequence: null, usage },
    } as unknown as StreamEvent);
    let text: { index: number; value: string } | undefined;
    const closeText = () => {
      if (!text) return;
      content.push({ type: 'text', text: text.value, citations: null } as ContentBlock);
      emit({ type: 'content_block_stop', index: text.index } as StreamEvent);
      text = undefined;
    };
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (!part.value) continue;
        if (!text) {
          text = { index: content.length, value: '' };
          emit({ type: 'content_block_start', index: text.index, content_block: { type: 'text', text: '', citations: null } } as StreamEvent);
        }
        text.value += part.value;
        emit({ type: 'content_block_delta', index: text.index, delta: { type: 'text_delta', text: part.value } } as StreamEvent);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        closeText();
        const index = content.length;
        const block = { type: 'tool_use', id: part.callId, name: part.name, input: part.input } as ContentBlock;
        content.push(block);
        emit({ type: 'content_block_start', index, content_block: { ...block, input: {} } } as StreamEvent);
        emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.input ?? {}) } } as StreamEvent);
        emit({ type: 'content_block_stop', index } as StreamEvent);
      }
    }
    closeText();
    usage.output_tokens = estimate(JSON.stringify(content).length);
    const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    emit({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage } as unknown as StreamEvent);
    emit({ type: 'message_stop' } as StreamEvent);
    const message = { id, type: 'message', role: 'assistant', model: call.model.id, content, stop_reason, stop_sequence: null, usage } as unknown as ApiMessage;
    return { message, metrics: this.metrics(call.model.id, usage) };
  }

  async json<T>(call: JsonCall<T>): Promise<{ value: T; metrics: CallMetrics }> {
    const lm = this.require(call.model.id);
    const schema = JSON.stringify(z.toJSONSchema(call.schema));
    let prompt = `${call.system}\n\n${call.prompt}\n\nRespond with a single JSON object that matches this JSON Schema, and nothing else:\n${schema}`;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await lm.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: 'Fusion uses this model to route and review requests.' },
        tokenFor(call.signal),
      );
      let text = '';
      for await (const chunk of response.text) text += chunk;
      const metrics = this.metrics(call.model.id, { input_tokens: estimate(prompt.length), output_tokens: estimate(text.length) });
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      try {
        const value = call.schema.parse(JSON.parse(text.slice(start, end + 1)));
        return { value, metrics };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        prompt += `\n\nYour previous reply was not valid (${lastError.slice(0, 200)}). Reply with the JSON object only.`;
      }
    }
    throw new Error(`${call.model.short} returned no valid JSON: ${lastError.slice(0, 200)}`);
  }

  isTransient(err: unknown): boolean {
    // Another model in the pool is a reasonable substitute for any provider-side failure,
    // except when the user declined access.
    return !(err instanceof vscode.LanguageModelError && err.code === vscode.LanguageModelError.NoPermissions.name);
  }

  private require(id: string): vscode.LanguageModelChat {
    const lm = this.models.get(id);
    if (!lm) throw new Error(`Fusion: model ${id} is not available in VS Code right now`);
    return lm;
  }

  private metrics(model: string, u: { input_tokens: number; output_tokens: number }): CallMetrics {
    const usage: TokenUsage = { input: u.input_tokens, output: u.output_tokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    this.log.info(`vscode model ${model}: ~${u.input_tokens} in / ~${u.output_tokens} out (estimated)`);
    return { usage, servedBy: model };
  }
}

function tokenFor(signal: AbortSignal): vscode.CancellationToken {
  const source = new vscode.CancellationTokenSource();
  if (signal.aborted) source.cancel();
  else signal.addEventListener('abort', () => source.cancel(), { once: true });
  return source.token;
}

/** Messages API history → VS Code chat messages (no system role, no thinking blocks). */
function toVsCodeMessages(system: string, messages: readonly Msg[]): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  if (system) out.push(vscode.LanguageModelChatMessage.User(`<instructions>\n${system}\n</instructions>`));
  for (const m of messages) {
    if (m.role === 'system') {
      const text = blocksOf(m.content).map((b) => b.text ?? '').join('\n');
      if (text) out.push(vscode.LanguageModelChatMessage.User(`<system-reminder>\n${text}\n</system-reminder>`));
      continue;
    }
    if (m.role === 'assistant') {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      for (const b of blocksOf(m.content)) {
        if (b.type === 'text' && b.text) parts.push(new vscode.LanguageModelTextPart(b.text));
        else if (b.type === 'tool_use') parts.push(new vscode.LanguageModelToolCallPart(b.id, b.name, b.input ?? {}));
      }
      if (parts.length) out.push(vscode.LanguageModelChatMessage.Assistant(parts));
      continue;
    }
    const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart> = [];
    for (const b of blocksOf(m.content)) {
      if (b.type === 'text' && b.text) parts.push(new vscode.LanguageModelTextPart(b.text));
      else if (b.type === 'tool_result') {
        const inner = blocksOf(b.content)
          .filter((c) => c.type === 'text')
          .map((c) => new vscode.LanguageModelTextPart(c.text));
        parts.push(new vscode.LanguageModelToolResultPart(b.tool_use_id, inner.length ? inner : [new vscode.LanguageModelTextPart('(no output)')]));
      } else if (b.type === 'image') parts.push(new vscode.LanguageModelTextPart('[image omitted]'));
    }
    if (parts.length) out.push(vscode.LanguageModelChatMessage.User(parts));
  }
  return out;
}
