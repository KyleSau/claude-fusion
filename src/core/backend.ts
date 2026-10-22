import type Anthropic from '@anthropic-ai/sdk';
import type * as z from 'zod/v4';
import type { ModelInfo, TokenUsage } from './models';
import type { ApiMessage, Effort, Msg, StreamEvent, TextBlockParam, Tool, ToolChoice } from './types';

export interface CallMetrics {
  usage: TokenUsage;
  /** Undefined when the price is unknown. */
  costUsd?: number;
  /** The model that actually produced the output (differs after a server-side refusal fallback). */
  servedBy: string;
}

export interface SolveCall {
  model: ModelInfo;
  effort: Effort;
  system: TextBlockParam[];
  messages: Msg[];
  tools: Tool[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  thinkingDisplay?: 'summarized' | 'omitted' | 'updates';
  blockBinding?: Anthropic.Beta.BetaThinkingBlockBinding;
  betas?: string[];
  passthrough?: Record<string, unknown>;
  refusalFallback: boolean;
  signal: AbortSignal;
  /** Receives raw stream events as they arrive. */
  onEvent?: (e: StreamEvent) => void;
}

export interface JsonCall<T> {
  model: ModelInfo;
  effort: Effort;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  signal: AbortSignal;
}

/** A source of model calls. Fusion ships an Anthropic backend and, inside VS Code, a VS Code LM backend. */
export interface Backend {
  readonly provider: ModelInfo['provider'];
  /** Whether this backend can currently serve the model (credentials present, model discovered...). */
  available(model: ModelInfo): boolean;
  /** One agent step: a streamed Messages API call with the client's tools. */
  solve(call: SolveCall): Promise<{ message: ApiMessage; metrics: CallMetrics }>;
  /** A tool-less call that must return JSON matching `schema` (router, gate, critic). */
  json<T>(call: JsonCall<T>): Promise<{ value: T; metrics: CallMetrics }>;
  /** Transient failures (rate limits, overload, network) are worth retrying on another model. */
  isTransient(err: unknown): boolean;
}
