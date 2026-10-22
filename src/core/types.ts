import type Anthropic from '@anthropic-ai/sdk';

// Fusion's canonical wire format is the Anthropic (beta) Messages API. The gateway speaks it
// natively, and the VS Code provider converts to and from it at its edge.
export type Msg = Anthropic.Beta.BetaMessageParam;
export type UserMsg = Anthropic.Beta.BetaUserMessageParam;
export type AssistantMsg = Anthropic.Beta.BetaAssistantMessageParam;
export type SystemMsg = Anthropic.Beta.BetaSystemMessageParam;
export type BlockParam = Anthropic.Beta.BetaContentBlockParam;
export type TextBlockParam = Anthropic.Beta.BetaTextBlockParam;
export type Tool = Anthropic.Beta.BetaToolUnion;
export type ToolChoice = Anthropic.Beta.BetaToolChoice;
export type ApiMessage = Anthropic.Beta.BetaMessage;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type StreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Tier = 'fast' | 'balanced' | 'frontier';
export type Pattern = 'single' | 'cascade' | 'critique';
export type Objective = 'fast' | 'balanced' | 'quality';
export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard';
export type Risk = 'low' | 'medium' | 'high';

/** 0 = not needed, 3 = central to the task. */
export interface Signals {
  reasoning: number;
  codegen: number;
  debugging: number;
  toolUse: number;
}

export interface RouteDecision {
  difficulty: Difficulty;
  risk: Risk;
  signals: Signals;
  needsReview: boolean;
  source: 'model' | 'heuristic' | 'forced';
  rationale: string;
}

export interface ModelRef {
  model: string;
  effort: Effort;
}

export interface Plan {
  pattern: Pattern;
  /** Single: the model. Cascade: the drafter. Critique: the drafter (and reviser). */
  solver: ModelRef;
  /** Cascade only: the stronger model that takes over when the gate rejects the draft. */
  escalate?: ModelRef;
  /** Cascade only: the judge that accepts or rejects the drafter's final answer. */
  gate?: ModelRef;
  /** Critique only: the independent, tool-less reviewer. */
  critic?: ModelRef;
  reason: string;
}

export type LegRole = 'route' | 'solve' | 'draft' | 'gate' | 'critique' | 'revise' | 'escalate' | 'fallback';
export type LegOutcome = 'ok' | 'error' | 'timeout' | 'cancelled' | 'refusal' | 'skipped';

export type Stage = 'routing' | 'solving' | 'drafting' | 'gating' | 'escalating' | 'critiquing' | 'revising' | 'done';

export interface ProgressUpdate {
  taskId: string;
  stage: Stage;
  model?: string;
  detail?: string;
}

/** Receives the single assistant message a turn produces, either live or replayed after review. */
export interface TurnSink {
  event(e: StreamEvent): void;
  /** Workflow stage changes. Never part of the response itself. */
  progress?(p: ProgressUpdate): void;
  /** Called periodically while a stage is held back, so transports can keep connections alive. */
  heartbeat?(): void;
}

export interface TurnRequest {
  /** Top-level system prompt, as blocks. Fusion never rewrites it. */
  system: TextBlockParam[];
  /** Full history as the client holds it. */
  messages: Msg[];
  tools: Tool[];
  toolChoice?: ToolChoice;
  /** Client-requested output ceiling; Fusion picks one when absent. */
  maxTokens?: number;
  /** Client-requested thinking display (gateway). Wins over `progressUpdates`. */
  thinkingDisplay?: 'summarized' | 'omitted' | 'updates';
  /** Ask for between-tool progress notes when the client did not choose a display (VS Code). */
  progressUpdates?: boolean;
  /** The client marked this as a background request (titles, summaries): skip routing, use the fast tier. */
  auxiliary?: boolean;
  /** Overrides `FusionConfig.refusalFallback` for this request. */
  refusalFallback?: boolean;
  /** Client-requested `thinking.block_binding` (gateway), forwarded unchanged. */
  blockBinding?: Anthropic.Beta.BetaThinkingBlockBinding;
  /** Client `anthropic-beta` values, forwarded on solver calls. */
  betas?: string[];
  /** Other Messages API parameters forwarded on solver calls (metadata, context_management, ...). */
  passthrough?: Record<string, unknown>;
  objective: Objective;
  /**
   * Replace assistant turns Fusion produced with the exact blocks the API returned (thinking blocks
   * included). Needed when the client cannot store them itself, as in VS Code.
   */
  restoreAssistantBlocks: boolean;
  signal: AbortSignal;
}

export interface TurnOutcome {
  taskId: string;
  message: ApiMessage;
  plan: Plan;
  /** True when this message ends the task (no tool calls left to run). */
  final: boolean;
}
