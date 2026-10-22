import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Backend, CallMetrics, JsonCall, SolveCall } from '../core/backend';
import { addUsage, costOf, ZERO_USAGE, type ModelInfo, type ModelRegistry, type TokenUsage } from '../core/models';
import { blocksOf } from '../core/transcript';
import type { ApiMessage, Msg, TextBlockParam, Tool, ToolChoice } from '../core/types';

export interface AnthropicCredentials {
  apiKey?: string;
  authToken?: string;
}

export interface AnthropicBackendOptions {
  /** Resolved on every call, so a key set at runtime (e.g. from VS Code secret storage) takes effect immediately. */
  credentials: () => AnthropicCredentials | undefined;
  baseURL?: string;
  /** Let the SDK resolve credentials itself (env vars, `ant auth login` profiles) when none are given. */
  allowDefaultCredentials?: boolean;
  maxRetries?: number;
}

/**
 * Fusion has no key of its own. Deliberately not an API authentication error: a client such as
 * Claude Code would take that to mean its own login failed.
 */
export class MissingCredentialsError extends Error {
  constructor() {
    super(
      'Fusion needs an Anthropic API key for its own model calls. In VS Code run "Fusion: Set Anthropic API Key"; for the command-line gateway set ANTHROPIC_API_KEY. A claude.ai login cannot be used for these calls.',
    );
    this.name = 'MissingCredentialsError';
  }
}

const BETA_THINKING_BINDING = 'thinking-binding-controls-2026-08-01';
const BETA_DISPLAY_UPDATES = 'thinking-display-updates-2026-08-18';
const BETA_SERVER_FALLBACK = 'server-side-fallback-2026-07-01';

/** Request fields Fusion sets itself or that the target models reject. */
const OWNED_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'max_tokens',
  'thinking',
  'stream',
  'betas',
  'temperature',
  'top_p',
  'top_k',
  'speed',
]);

/** Talks to the Claude API through the official SDK. */
export class AnthropicBackend implements Backend {
  readonly provider = 'anthropic' as const;
  private client?: Anthropic;
  private clientKey?: string;

  constructor(
    private readonly opts: AnthropicBackendOptions,
    private readonly registry: ModelRegistry,
  ) {}

  available(model: ModelInfo): boolean {
    if (model.provider !== 'anthropic') return false;
    const c = this.opts.credentials();
    return !!(c?.apiKey || c?.authToken || this.opts.allowDefaultCredentials);
  }

  async solve(call: SolveCall): Promise<{ message: ApiMessage; metrics: CallMetrics }> {
    const params = this.solveParams(call);
    const stream = this.sdk().beta.messages.stream(params, { signal: call.signal });
    for await (const event of stream) call.onEvent?.(event);
    const message = await stream.finalMessage();
    return { message, metrics: this.metrics(call.model, message) };
  }

  async json<T>(call: JsonCall<T>): Promise<{ value: T; metrics: CallMetrics }> {
    const response = await this.sdk().messages.parse(
      {
        model: call.model.id,
        max_tokens: call.maxTokens,
        system: call.system,
        messages: [{ role: 'user', content: call.prompt }],
        thinking: { type: 'adaptive' },
        output_config: { effort: call.effort, format: zodOutputFormat(call.schema) },
      },
      { signal: call.signal },
    );
    const metrics = this.metrics(call.model, response);
    if (response.stop_reason === 'refusal') throw new Error(`${call.model.short} declined the request`);
    if (response.parsed_output == null) throw new Error(`${call.model.short} returned no parseable JSON (stop: ${response.stop_reason})`);
    return { value: response.parsed_output as T, metrics };
  }

  isTransient(err: unknown): boolean {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return true;
    if (err instanceof Anthropic.APIUserAbortError) return false;
    if (err instanceof Anthropic.APIConnectionError) return true;
    // Errors delivered mid-stream as SSE `error` events carry their type but no status.
    return err instanceof Anthropic.APIError && (err.type === 'overloaded_error' || err.type === 'api_error');
  }

  /** The request body for one solver step. Exposed for tests. */
  solveParams(call: SolveCall): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
    const model = call.model;
    // `oauth-*` betas describe how the *client* signs in; Fusion's own calls use its API key.
    const betas = new Set((call.betas ?? []).filter((b) => !b.startsWith('oauth-')));
    const passthrough = Object.fromEntries(Object.entries(call.passthrough ?? {}).filter(([k]) => !OWNED_FIELDS.has(k)));

    const thinking: Anthropic.Beta.BetaThinkingConfigAdaptive = { type: 'adaptive' };
    if (call.thinkingDisplay) thinking.display = call.thinkingDisplay;
    if (call.thinkingDisplay === 'updates') betas.add(BETA_DISPLAY_UPDATES);
    // Degrade instead of failing if the client edited history: drop the stale thinking blocks.
    thinking.block_binding = call.blockBinding ?? { prefix_mismatch_behavior: 'drop_block' };
    betas.add(BETA_THINKING_BINDING);

    const messages = prepareMessages(call.messages, model);
    const tools = call.tools;
    const explicitCache = 'cache_control' in passthrough || hasCacheMarkers(call.system, messages, tools);
    // Two breakpoints: the static prefix (tools + system) and an automatic one on the growing tail.
    const system = explicitCache ? call.system : markLast(call.system);

    const output_config: Anthropic.Beta.BetaOutputConfig = {
      ...((passthrough.output_config as Anthropic.Beta.BetaOutputConfig | undefined) ?? {}),
      effort: call.effort,
    };
    delete passthrough.output_config;

    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      ...(passthrough as Partial<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming>),
      model: model.id,
      max_tokens: call.maxTokens,
      messages,
      thinking,
      output_config,
    };
    if (system.length) params.system = system;
    if (tools.length) params.tools = tools;
    const toolChoice = mapToolChoice(call.toolChoice, tools);
    if (toolChoice) params.tool_choice = toolChoice;
    if (!explicitCache) params.cache_control = { type: 'ephemeral' };
    if (call.refusalFallback && params.fallbacks === undefined && serverFallbackAllowed(model, messages)) {
      params.fallbacks = 'default';
      betas.add(BETA_SERVER_FALLBACK);
    }
    if (betas.size) params.betas = [...betas];
    return params;
  }

  private sdk(): Anthropic {
    const c = this.opts.credentials() ?? {};
    const key = `${c.apiKey ?? ''}\u0000${c.authToken ?? ''}\u0000${this.opts.baseURL ?? ''}`;
    if (!this.client || key !== this.clientKey) {
      if (!c.apiKey && !c.authToken && !this.opts.allowDefaultCredentials) {
        throw new MissingCredentialsError();
      }
      this.client = new Anthropic({
        ...(c.apiKey ? { apiKey: c.apiKey } : {}),
        ...(c.authToken ? { authToken: c.authToken } : {}),
        ...(this.opts.baseURL ? { baseURL: this.opts.baseURL } : {}),
        maxRetries: this.opts.maxRetries ?? 2,
      });
      this.clientKey = key;
    }
    return this.client;
  }

  private metrics(model: ModelInfo, message: { model: string; usage: unknown }): CallMetrics {
    return callMetrics(this.registry, model, message);
  }
}

/** Tokens and estimated cost of one API response, including every attempt of a server-side fallback. */
export function callMetrics(registry: ModelRegistry, model: ModelInfo, message: { model: string; usage: unknown }): CallMetrics {
  const u = message.usage as RawUsage;
  const iterations = Array.isArray(u.iterations) ? u.iterations : [];
  if (iterations.length) {
    // Per-attempt billing: each attempt is billed at its own model's rates.
    let usage = ZERO_USAGE;
    let cost: number | undefined = 0;
    for (const it of iterations) {
      const itUsage = toUsage(it);
      usage = addUsage(usage, itUsage);
      const c = costOf(registry.get(it.model ?? model.id) ?? model, itUsage);
      cost = c === undefined || cost === undefined ? undefined : cost + c;
    }
    return { usage, costUsd: cost, servedBy: message.model };
  }
  const usage = toUsage(u);
  return { usage, costUsd: costOf(registry.get(message.model) ?? model, usage), servedBy: message.model };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  iterations?: Array<RawUsage & { model?: string | null }> | null;
  model?: string | null;
}

function toUsage(u: RawUsage): TokenUsage {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h);
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
}

/**
 * Light-touch fixes so a history built by any client is valid for the target model. Messages that
 * are already valid pass through byte-for-byte, so the conversation prefix (and with it the prompt
 * cache and replayed thinking blocks) stays intact.
 */
export function prepareMessages(messages: readonly Msg[], model: ModelInfo): Msg[] {
  const out: Msg[] = [];
  for (const original of messages) {
    let m = original;
    if (m.role === 'system' && 'output_config' in m && m.output_config) {
      // Fusion chooses effort per step, so a client's per-message effort settings are removed
      // (consistently on every request, which keeps the conversation prefix stable).
      const { output_config: _ignored, ...rest } = m;
      if (!blocksOf(rest.content).length) continue;
      m = rest as Msg;
    }
    if (m.role === 'system' && !model.systemMessages) {
      // Older models: fold the instruction into the preceding user turn instead.
      const prev = out[out.length - 1];
      const text = blocksOf(m.content).map((b) => b.text ?? '').join('\n');
      if (prev?.role === 'user' && text) {
        out[out.length - 1] = { role: 'user', content: [...blocksOf(prev.content), { type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] } as Msg;
      }
      continue;
    }
    if (Array.isArray(m.content)) {
      let content = (m.content as { type: string; text?: string }[]).filter((b) => !(b.type === 'text' && !b.text));
      if (m.role === 'user') {
        const results = content.filter((b) => b.type === 'tool_result');
        if (results.length && content[0]?.type !== 'tool_result') content = [...results, ...content.filter((b) => b.type !== 'tool_result')];
      }
      if (!content.length) continue;
      out.push(content.length === m.content.length && content.every((b, i) => b === (m.content as unknown[])[i]) ? m : ({ ...m, content } as Msg));
    } else if (typeof m.content === 'string' && !m.content) {
      continue;
    } else {
      out.push(m);
    }
  }
  if (out[0] && out[0].role !== 'user') out.unshift({ role: 'user', content: '(continuing the conversation)' });
  return out;
}

function hasCacheMarkers(system: readonly TextBlockParam[], messages: readonly Msg[], tools: readonly Tool[]): boolean {
  const marked = (b: unknown) => !!b && typeof b === 'object' && 'cache_control' in b && (b as { cache_control?: unknown }).cache_control != null;
  return system.some(marked) || tools.some(marked) || messages.some((m) => blocksOf(m.content).some(marked));
}

function markLast(system: readonly TextBlockParam[]): TextBlockParam[] {
  if (!system.length) return [];
  const out = [...system];
  out[out.length - 1] = { ...out[out.length - 1], cache_control: { type: 'ephemeral' } };
  return out;
}

/** Forced tool use is rejected by the 5.5-generation models; steer with `auto` instead. */
function mapToolChoice(choice: ToolChoice | undefined, tools: readonly Tool[]): ToolChoice | undefined {
  if (!choice || !tools.length) return undefined;
  if (choice.type === 'any' || choice.type === 'tool') {
    return { type: 'auto', ...(choice.disable_parallel_tool_use ? { disable_parallel_tool_use: true } : {}) };
  }
  return choice;
}

/** `fallbacks: "default"` re-runs a declined request on another model server-side, when the request shape allows it. */
function serverFallbackAllowed(model: ModelInfo, messages: readonly Msg[]): boolean {
  if (!model.serverFallback) return false;
  // Sonnet 5.5 falls back to Sonnet 5, which rejects mid-conversation system messages.
  if (model.id === 'claude-sonnet-5-5' && messages.some((m) => m.role === 'system')) return false;
  return true;
}
