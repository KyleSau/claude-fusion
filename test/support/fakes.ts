import type { Backend, CallMetrics, JsonCall, SolveCall } from '../../src/core/backend';
import { resolveConfig, type DeepPartial, type FusionConfig } from '../../src/core/config';
import { messageEvents } from '../../src/core/events';
import { ModelRegistry, type ModelInfo } from '../../src/core/models';
import { Orchestrator } from '../../src/core/orchestrator';
import { toParams } from '../../src/core/transcript';
import type { ApiMessage, ContentBlock, Msg, ProgressUpdate, StreamEvent, Tool, TurnOutcome, TurnRequest, TurnSink } from '../../src/core/types';

export class TransientError extends Error {}

export type Reply = { content: ContentBlock[]; stop_reason?: ApiMessage['stop_reason'] } | Error;

let ids = 0;

export const text = (t: string): ContentBlock => ({ type: 'text', text: t, citations: null }) as ContentBlock;
export const toolUse = (name = 'read_file', input: Record<string, unknown> = { path: 'src/app.ts' }): ContentBlock =>
  ({ type: 'tool_use', id: `toolu_${++ids}`, name, input }) as ContentBlock;
export const thinking = (t = '', signature = `sig_${++ids}`): ContentBlock => ({ type: 'thinking', thinking: t, signature }) as ContentBlock;

/** Which review leg a JSON call belongs to, from its system prompt. */
export function jsonRole(call: JsonCall<unknown>): 'route' | 'gate' | 'critique' {
  if (call.system.includes('routing classifier')) return 'route';
  if (call.system.includes('quality gate')) return 'gate';
  return 'critique';
}

export interface FakeOptions {
  solve: (call: SolveCall, n: number) => Reply;
  json?: (call: JsonCall<unknown>, role: 'route' | 'gate' | 'critique') => unknown;
  available?: (model: ModelInfo) => boolean;
}

/** A scripted Backend: records every call and streams scripted replies as real events. */
export class FakeBackend implements Backend {
  readonly provider = 'anthropic' as const;
  readonly solveCalls: SolveCall[] = [];
  readonly jsonCalls: { call: JsonCall<unknown>; role: string }[] = [];

  constructor(private readonly opts: FakeOptions) {}

  available(model: ModelInfo): boolean {
    return this.opts.available?.(model) ?? true;
  }

  async solve(call: SolveCall): Promise<{ message: ApiMessage; metrics: CallMetrics }> {
    this.solveCalls.push(call);
    const reply = this.opts.solve(call, this.solveCalls.length);
    if (reply instanceof Error) throw reply;
    const message = {
      id: `msg_${++ids}`,
      type: 'message',
      role: 'assistant',
      model: call.model.id,
      content: reply.content,
      stop_reason: reply.stop_reason ?? (reply.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as ApiMessage;
    for (const e of messageEvents(message)) {
      if (call.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      call.onEvent?.(e);
    }
    return { message, metrics: metrics(call.model.id, 0.01) };
  }

  async json<T>(call: JsonCall<T>): Promise<{ value: T; metrics: CallMetrics }> {
    const role = jsonRole(call as JsonCall<unknown>);
    this.jsonCalls.push({ call: call as JsonCall<unknown>, role });
    const value = this.opts.json?.(call as JsonCall<unknown>, role) ?? defaultJson(role);
    if (value instanceof Error) throw value;
    return { value: call.schema.parse(value), metrics: metrics(call.model.id, 0.001) };
  }

  isTransient(err: unknown): boolean {
    return err instanceof TransientError;
  }

  /** Models used for solver calls, in order. */
  get solvedBy(): string[] {
    return this.solveCalls.map((c) => c.model.id);
  }
}

function metrics(model: string, costUsd: number): CallMetrics {
  return { usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd, servedBy: model };
}

export function defaultJson(role: 'route' | 'gate' | 'critique'): unknown {
  switch (role) {
    case 'route':
      return { difficulty: 'easy', reasoning: 0, codegen: 2, debugging: 0, toolUse: 2, risk: 'low', needsReview: false, rationale: 'test' };
    case 'gate':
      return { issues: [], confidence: 0.9, accept: true };
    case 'critique':
      return { issues: [], verdict: 'approve' };
  }
}

export function route(difficulty: 'trivial' | 'easy' | 'medium' | 'hard', extra: Record<string, unknown> = {}) {
  return { difficulty, reasoning: 0, codegen: 2, debugging: 0, toolUse: 2, risk: 'low', needsReview: false, rationale: 'test', ...extra };
}

export const TOOLS: Tool[] = [
  { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'edit_file', description: 'Edit a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
];

export function makeOrchestrator(backend: Backend, cfg: DeepPartial<FusionConfig> = {}) {
  const config = resolveConfig(cfg);
  return new Orchestrator({ registry: new ModelRegistry(), backends: [backend], config: () => config });
}

export class RecordingSink implements TurnSink {
  readonly events: StreamEvent[] = [];
  readonly stages: ProgressUpdate[] = [];
  heartbeats = 0;
  event(e: StreamEvent): void {
    this.events.push(e);
  }
  progress(p: ProgressUpdate): void {
    this.stages.push(p);
  }
  heartbeat(): void {
    this.heartbeats++;
  }
  text(): string {
    return this.events
      .map((e) => (e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? e.delta.text : ''))
      .join('');
  }
  count(type: StreamEvent['type']): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

export function request(messages: Msg[], extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    messages,
    tools: TOOLS,
    objective: 'balanced',
    restoreAssistantBlocks: false,
    signal: new AbortController().signal,
    ...extra,
  };
}

/** What a client does between steps: append the assistant turn and the results of its tool calls. */
export function continueWith(messages: Msg[], outcome: TurnOutcome, result = 'ok'): Msg[] {
  const calls = outcome.message.content.filter((b) => b.type === 'tool_use') as { id: string }[];
  return [
    ...messages,
    { role: 'assistant', content: toParams(outcome.message.content) } as Msg,
    { role: 'user', content: calls.map((c) => ({ type: 'tool_result' as const, tool_use_id: c.id, content: result })) },
  ];
}

export const user = (t: string): Msg => ({ role: 'user', content: t });
