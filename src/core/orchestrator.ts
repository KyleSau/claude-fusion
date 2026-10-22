import type { Backend, CallMetrics } from './backend';
import { bounded, isCancellation, TimeoutError } from './bounded';
import type { FusionConfig } from './config';
import { replay, startsToolUse } from './events';
import { Ledger, formatUsd } from './ledger';
import { ZERO_USAGE, type ModelInfo, type ModelRegistry } from './models';
import { planFor } from './policy';
import {
  CRITIC_SYSTEM,
  CritiqueSchema,
  GATE_SYSTEM,
  GateSchema,
  critiqueNote,
  escalationNote,
  normalizeCritique,
  normalizeGate,
  reviewPrompt,
  type CritiqueJson,
} from './prompts';
import { Router } from './router';
import { SessionStore, type TaskState } from './sessions';
import { appendNote, condenseWork, finalText, hasToolResults, hasToolUse, truncateMiddle } from './transcript';
import type {
  ApiMessage,
  LegOutcome,
  LegRole,
  ModelRef,
  Msg,
  Plan,
  RouteDecision,
  Stage,
  StreamEvent,
  Tier,
  TurnOutcome,
  TurnRequest,
  TurnSink,
} from './types';
import type * as z from 'zod/v4';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const NOOP_LOGGER: Logger = { info() {}, warn() {}, error() {} };
const HEARTBEAT_MS = 5_000;
const DRAFT_CHARS = 12_000;

export interface OrchestratorDeps {
  registry: ModelRegistry;
  backends: Backend[];
  config: () => FusionConfig;
  ledger?: Ledger;
  sessions?: SessionStore;
  log?: Logger;
}

interface TurnCtx {
  req: TurnRequest;
  cfg: FusionConfig;
  sink: TurnSink;
  task: TaskState;
  messages: Msg[];
  /** The first upstream event has arrived, so transports may commit to a streaming response. */
  opened: boolean;
  /** Some event of this turn has reached the client; the turn can no longer change course. */
  forwarded: boolean;
}

interface StepResult {
  message: ApiMessage;
  /** Held events, replayed if the step is delivered. Empty once the step went live. */
  events: StreamEvent[];
  /** The step started a tool call and was streamed to the client as it arrived. */
  live: boolean;
}

/**
 * Runs one client turn (one assistant message) through the task's workflow:
 *
 * - **single**: the chosen model answers directly, streamed live.
 * - **cascade**: an efficient model drives the agent loop. Its tool-calling steps stream live; its
 *   final answer is held for a quality gate. If the gate rejects it, a stronger model takes over the
 *   conversation from the current state with an appended hand-off note.
 * - **critique**: the drafter's final answer is held and reviewed by an independent, tool-less
 *   critic. On substantive issues the drafter revises once (tools allowed) and that result ships.
 *
 * Clients (VS Code, Claude Code) own the agent loop and call back once per step, so workflow state
 * lives in {@link SessionStore} between calls.
 */
export class Orchestrator {
  readonly ledger: Ledger;
  readonly sessions: SessionStore;
  private readonly router: Router;
  private readonly log: Logger;

  constructor(private readonly deps: OrchestratorDeps) {
    this.ledger = deps.ledger ?? new Ledger();
    this.sessions = deps.sessions ?? new SessionStore();
    this.log = deps.log ?? NOOP_LOGGER;
    this.router = new Router({
      registry: deps.registry,
      backendFor: (m) => this.findBackend(m),
      ledger: this.ledger,
      warn: (m) => this.log.warn(m),
    });
  }

  get registry(): ModelRegistry {
    return this.deps.registry;
  }

  isAvailable(modelId: string): boolean {
    const model = this.deps.registry.get(modelId);
    const backend = model && this.findBackend(model);
    return !!backend && backend.available(model);
  }

  /** Routes a request without running it: what Fusion would do, and why. */
  async preview(req: Pick<TurnRequest, 'messages' | 'tools' | 'objective' | 'signal'>): Promise<{ taskId: string; decision: RouteDecision; plan: Plan }> {
    const cfg = this.deps.config();
    const taskId = SessionStore.newId();
    this.ledger.start(taskId);
    const decision = await this.router.decide(taskId, req.messages, req.tools, cfg, req.signal);
    const plan = planFor({ decision, objective: req.objective, agentic: req.tools.length > 0 }, cfg, this.deps.registry, (id) =>
      this.isAvailable(id),
    );
    this.ledger.update(taskId, { decision, plan, final: true, resolution: 'preview only' });
    return { taskId, decision, plan };
  }

  async handleTurn(req: TurnRequest, sink: TurnSink): Promise<TurnOutcome> {
    const cfg = this.deps.config();
    const messages = this.sessions.restore(req.messages, req.restoreAssistantBlocks);
    const known = hasToolResults(messages[messages.length - 1]) ? this.sessions.taskForContinuation(messages) : undefined;
    const task = known ?? (await this.startTask(req, messages, sink, cfg));
    const ctx: TurnCtx = { req, cfg, sink, task, messages, opened: false, forwarded: false };
    const beat = setInterval(() => {
      if (ctx.opened) sink.heartbeat?.();
    }, HEARTBEAT_MS);
    try {
      return await this.step(ctx);
    } finally {
      clearInterval(beat);
    }
  }

  private async startTask(req: TurnRequest, messages: Msg[], sink: TurnSink, cfg: FusionConfig): Promise<TaskState> {
    const taskId = SessionStore.newId();
    this.ledger.start(taskId);
    sink.progress?.({ taskId, stage: 'routing', model: cfg.router.model });
    const decision = await this.router.decide(taskId, messages, req.tools, cfg, req.signal, req.auxiliary);
    const plan = planFor({ decision, objective: req.objective, agentic: req.tools.length > 0 }, cfg, this.deps.registry, (id) =>
      this.isAvailable(id),
    );
    this.ledger.update(taskId, { decision, plan });
    this.log.info(`[${taskId}] ${plan.reason} — ${decision.source}: ${decision.rationale}`);
    return this.sessions.newTask(taskId, plan, plan.pattern === 'single' ? 'solving' : 'drafting');
  }

  private step(ctx: TurnCtx): Promise<TurnOutcome> {
    const { task } = ctx;
    switch (task.plan.pattern) {
      case 'single':
        return this.liveStep(ctx, task.active, 'solve', 'solving', ctx.messages, []);
      case 'cascade':
        return task.phase === 'escalated'
          ? this.liveStep(ctx, task.active, 'escalate', 'escalating', ctx.messages, [])
          : this.cascadeStep(ctx);
      case 'critique':
        return task.phase === 'revising'
          ? this.liveStep(ctx, task.active, 'revise', 'revising', ctx.messages, [])
          : this.critiqueStep(ctx);
    }
  }

  // ---- patterns ---------------------------------------------------------------------------------

  private async cascadeStep(ctx: TurnCtx): Promise<TurnOutcome> {
    const { task, cfg } = ctx;
    if (task.draftSteps >= cfg.cascade.maxDraftSteps) {
      return this.escalate(ctx, [`it took ${task.draftSteps} tool-calling steps without finishing`], undefined);
    }
    let draft: StepResult;
    try {
      draft = await this.runSolver(ctx, task.active, 'draft', 'drafting', ctx.messages, 'speculative');
    } catch (err) {
      // Client errors (a 400, a bad key) must reach the client unchanged; only an outage of the
      // drafter's tier is worth handing to the stronger model.
      if (isCancellation(err) || ctx.forwarded || !this.isTransient(task.active, err)) throw err;
      return this.escalate(ctx, [`it failed: ${errorMessage(err)}`], undefined);
    }
    if (draft.live || draft.message.stop_reason === 'pause_turn') {
      task.draftSteps++;
      return this.deliver(ctx, draft, []);
    }

    const message = draft.message;
    const text = finalText(message);
    if (message.stop_reason === 'refusal') return this.escalate(ctx, ['it declined the request'], undefined);
    if (message.stop_reason === 'max_tokens') return this.escalate(ctx, ['its response hit the output limit'], text || undefined);
    if (!text) return this.escalate(ctx, ['it produced no answer'], undefined);

    if (this.overBudget(ctx)) {
      this.ledger.update(task.id, { resolution: 'draft delivered without a gate check (task budget reached)' });
      return this.deliver(ctx, draft, []);
    }
    const verdict = await this.gate(ctx, text);
    if (verdict.accept) {
      this.ledger.update(task.id, { resolution: `draft accepted by the gate (confidence ${verdict.confidence.toFixed(2)})` });
      return this.deliver(ctx, draft, []);
    }
    return this.escalate(ctx, verdict.reasons, text);
  }

  private async critiqueStep(ctx: TurnCtx): Promise<TurnOutcome> {
    const { task } = ctx;
    const draft = await this.runSolver(ctx, task.active, 'draft', 'drafting', ctx.messages, 'speculative');
    const message = draft.message;
    const text = finalText(message);
    if (draft.live || message.stop_reason === 'pause_turn' || message.stop_reason === 'refusal' || !text) {
      return this.deliver(ctx, draft, []);
    }
    if (this.overBudget(ctx)) {
      this.ledger.update(task.id, { resolution: 'delivered without review (task budget reached)' });
      return this.deliver(ctx, draft, []);
    }

    const review = await this.critique(ctx, text);
    if (!review.revise) {
      this.ledger.update(task.id, { resolution: review.failed ? 'delivered without review (critic failed)' : 'approved by the critic' });
      return this.deliver(ctx, draft, []);
    }
    const noted = this.withNote(ctx, critiqueNote(review.issues, truncateMiddle(text, DRAFT_CHARS)), task.active);
    if (!noted.notes.length) return this.deliver(ctx, draft, []);
    task.phase = 'revising';
    this.ledger.update(task.id, { resolution: `revised once after review (${review.issues.length} issue${review.issues.length === 1 ? '' : 's'})` });
    return this.liveStep(ctx, task.active, 'revise', 'revising', noted.messages, noted.notes);
  }

  private escalate(ctx: TurnCtx, reasons: string[], draftText: string | undefined): Promise<TurnOutcome> {
    const { task, cfg } = ctx;
    const target: ModelRef = task.plan.escalate ?? { model: cfg.pool.frontier, effort: 'high' };
    task.phase = 'escalated';
    task.active = target;
    this.ledger.update(task.id, { resolution: `escalated to ${this.deps.registry.short(target.model)}: ${reasons[0]}` });
    this.log.info(`[${task.id}] escalating to ${target.model}: ${reasons.join('; ')}`);
    const noted = this.withNote(ctx, escalationNote(reasons, draftText && truncateMiddle(draftText, DRAFT_CHARS)), target);
    return this.liveStep(ctx, target, 'escalate', 'escalating', noted.messages, noted.notes);
  }

  // ---- legs -------------------------------------------------------------------------------------

  private async gate(ctx: TurnCtx, draftText: string): Promise<{ accept: boolean; reasons: string[]; confidence: number }> {
    const { cfg } = ctx;
    const ref = ctx.task.plan.gate ?? { model: cfg.pool.balanced, effort: 'low' };
    try {
      const v = normalizeGate(
        await this.judge(ctx, ref, 'gate', 'gating', GATE_SYSTEM, GateSchema, draftText, cfg.gate.timeoutMs, (v) =>
          `accept=${v.accept}, confidence ${v.confidence}`,
        ),
      );
      const accept = v.accept && v.confidence >= cfg.gate.threshold;
      const reasons = v.issues.length
        ? v.issues.slice(0, 5)
        : [v.accept ? `the gate's confidence (${v.confidence.toFixed(2)}) was below the ${cfg.gate.threshold} bar` : 'the quality gate rejected it'];
      return { accept, reasons, confidence: v.confidence };
    } catch (err) {
      if (isCancellation(err)) throw err;
      return {
        accept: cfg.gate.onError === 'accept',
        reasons: ['the quality gate could not run, so the task was handed over as a precaution'],
        confidence: 0,
      };
    }
  }

  private async critique(ctx: TurnCtx, draftText: string): Promise<{ revise: boolean; issues: CritiqueJson['issues']; failed?: boolean }> {
    const { cfg } = ctx;
    const ref = ctx.task.plan.critic ?? { model: cfg.pool.balanced, effort: 'medium' };
    try {
      const v = normalizeCritique(
        await this.judge(ctx, ref, 'critique', 'critiquing', CRITIC_SYSTEM, CritiqueSchema, draftText, cfg.critique.timeoutMs, (v) =>
          `${v.verdict}, ${v.issues.length} issue(s)`,
        ),
      );
      const rank = { critical: 3, major: 2, minor: 1 } as const;
      const issues = v.issues.filter((i) => rank[i.severity] >= rank[cfg.critique.minSeverity]).slice(0, 6);
      return { revise: v.verdict === 'revise' && issues.length > 0, issues };
    } catch (err) {
      if (isCancellation(err)) throw err;
      return { revise: false, issues: [], failed: true };
    }
  }

  /** A read-only, tool-less review call over a condensed view of the task. */
  private async judge<T>(
    ctx: TurnCtx,
    ref: ModelRef,
    role: LegRole,
    stage: Stage,
    system: string,
    schema: z.ZodType<T>,
    draftText: string,
    timeoutMs: number,
    describe: (v: T) => string,
  ): Promise<T> {
    const model = this.deps.registry.require(ref.model);
    const backend = this.backendFor(model);
    ctx.sink.progress?.({ taskId: ctx.task.id, stage, model: model.id });
    const prompt = reviewPrompt(condenseWork(ctx.messages), truncateMiddle(draftText, DRAFT_CHARS));
    const started = Date.now();
    try {
      const { value, metrics } = await bounded(role, ctx.req.signal, timeoutMs, (signal) =>
        backend.json({ model, effort: ref.effort, system, prompt, schema, maxTokens: 8_000, signal }),
      );
      this.recordLeg(ctx.task.id, role, ref, started, 'ok', metrics, describe(value));
      return value;
    } catch (err) {
      this.recordLeg(ctx.task.id, role, ref, started, outcomeOf(err), undefined, errorMessage(err));
      if (!isCancellation(err)) this.log.warn(`[${ctx.task.id}] ${role} failed: ${errorMessage(err)}`);
      throw err;
    }
  }

  private async liveStep(
    ctx: TurnCtx,
    ref: ModelRef,
    role: LegRole,
    stage: Stage,
    messages: Msg[],
    notes: string[],
  ): Promise<TurnOutcome> {
    const step = await this.runSolver(ctx, ref, role, stage, messages, 'live');
    return this.finish(ctx, step.message, notes);
  }

  /**
   * Calls the solver, falling back to another tier on transient failures as long as nothing has
   * reached the client. In `speculative` mode the step is held until it either starts a tool call
   * (then it goes live) or ends as a final answer (then the caller decides whether to deliver it).
   */
  private async runSolver(
    ctx: TurnCtx,
    ref: ModelRef,
    role: LegRole,
    stage: Stage,
    messages: Msg[],
    mode: 'live' | 'speculative',
  ): Promise<StepResult> {
    const chain = this.fallbackChain(ctx.cfg, ref);
    for (let i = 0; ; i++) {
      const current = chain[i];
      const held: StreamEvent[] = [];
      let live = mode === 'live';
      const onEvent = (e: StreamEvent) => {
        ctx.opened = true;
        if (live) {
          ctx.forwarded = true;
          ctx.sink.event(e);
          return;
        }
        held.push(e);
        if (startsToolUse(e)) {
          live = true;
          ctx.forwarded = true;
          for (const h of held.splice(0)) ctx.sink.event(h);
        }
      };
      try {
        const message = await this.callSolver(ctx, current, i === 0 ? role : 'fallback', stage, messages, onEvent);
        return { message, events: held, live };
      } catch (err) {
        const next = chain[i + 1];
        if (isCancellation(err) || ctx.forwarded || !next || !this.isTransient(current, err)) throw err;
        this.log.warn(
          `[${ctx.task.id}] ${this.deps.registry.short(current.model)} failed (${errorMessage(err)}); falling back to ${this.deps.registry.short(next.model)}`,
        );
      }
    }
  }

  private async callSolver(
    ctx: TurnCtx,
    ref: ModelRef,
    role: LegRole,
    stage: Stage,
    messages: Msg[],
    onEvent: (e: StreamEvent) => void,
  ): Promise<ApiMessage> {
    const model = this.deps.registry.require(ref.model);
    const backend = this.backendFor(model);
    ctx.sink.progress?.({ taskId: ctx.task.id, stage, model: model.id });
    const started = Date.now();
    try {
      const { message, metrics } = await bounded(role, ctx.req.signal, undefined, (signal) =>
        backend.solve({
          model,
          effort: ref.effort,
          system: ctx.req.system,
          messages,
          tools: ctx.req.tools,
          toolChoice: ctx.req.toolChoice,
          maxTokens: Math.min(ctx.req.maxTokens ?? ctx.cfg.maxOutputTokens, model.maxOutput),
          thinkingDisplay: this.displayFor(ctx.req, model),
          blockBinding: ctx.req.blockBinding,
          betas: ctx.req.betas,
          passthrough: ctx.req.passthrough,
          refusalFallback: ctx.req.refusalFallback ?? ctx.cfg.refusalFallback,
          signal,
          onEvent,
        }),
      );
      const via = metrics.servedBy !== model.id ? ` via ${metrics.servedBy}` : '';
      this.recordLeg(ctx.task.id, role, ref, started, message.stop_reason === 'refusal' ? 'refusal' : 'ok', metrics, `${message.stop_reason}${via}`);
      return message;
    } catch (err) {
      this.recordLeg(ctx.task.id, role, ref, started, outcomeOf(err), undefined, errorMessage(err));
      throw err;
    }
  }

  // ---- delivery ---------------------------------------------------------------------------------

  private deliver(ctx: TurnCtx, step: StepResult, notes: string[]): TurnOutcome {
    if (step.events.length) {
      ctx.forwarded = true;
      replay(step.events, ctx.sink);
    }
    return this.finish(ctx, step.message, notes);
  }

  private finish(ctx: TurnCtx, message: ApiMessage, notes: string[]): TurnOutcome {
    const { task } = ctx;
    this.sessions.record(message.content, task.id, notes);
    const final = !hasToolUse(message) && message.stop_reason !== 'pause_turn';
    if (final) {
      const summary = this.ledger.get(task.id);
      this.ledger.update(task.id, { final: true });
      ctx.sink.progress?.({ taskId: task.id, stage: 'done', detail: summary ? formatUsd(summary.costUsd) : undefined });
    }
    return { taskId: task.id, message, plan: task.plan, final };
  }

  /** Appends an orchestrator note as operator text, when the request and model allow one. */
  private withNote(ctx: TurnCtx, note: string, ref: ModelRef): { messages: Msg[]; notes: string[] } {
    const model = this.deps.registry.get(ref.model);
    const messages = model?.provider === 'anthropic' && !model.systemMessages ? undefined : appendNote(ctx.messages, note);
    if (!messages) {
      this.log.warn(`[${ctx.task.id}] cannot append an orchestrator note to this request; continuing without it`);
      return { messages: ctx.messages, notes: [] };
    }
    return { messages, notes: [note] };
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private displayFor(req: TurnRequest, model: ModelInfo): TurnRequest['thinkingDisplay'] {
    if (req.thinkingDisplay) return req.thinkingDisplay === 'updates' && !model.progressUpdates ? undefined : req.thinkingDisplay;
    return req.progressUpdates && model.progressUpdates ? 'updates' : undefined;
  }

  private overBudget(ctx: TurnCtx): boolean {
    const spent = this.ledger.get(ctx.task.id)?.costUsd ?? 0;
    if (spent < ctx.cfg.budget.maxTaskUsd) return false;
    this.log.warn(`[${ctx.task.id}] task budget reached (${formatUsd(spent)}); skipping optional legs`);
    return true;
  }

  /** The requested model, plus one neighbouring tier to try when it is overloaded or unreachable. */
  private fallbackChain(cfg: FusionConfig, ref: ModelRef): ModelRef[] {
    const tier = (Object.keys(cfg.pool) as Tier[]).find((t) => cfg.pool[t] === ref.model);
    const alt = tier === 'fast' ? cfg.pool.balanced : tier === 'balanced' ? cfg.pool.frontier : tier === 'frontier' ? cfg.pool.balanced : undefined;
    const chain = [ref];
    if (alt && alt !== ref.model && this.isAvailable(alt)) chain.push({ model: alt, effort: ref.effort });
    return chain;
  }

  private isTransient(ref: ModelRef, err: unknown): boolean {
    if (err instanceof TimeoutError) return true;
    const model = this.deps.registry.get(ref.model);
    const backend = model && this.findBackend(model);
    return !!backend && backend.isTransient(err);
  }

  private findBackend(model: ModelInfo): Backend | undefined {
    return this.deps.backends.find((b) => b.provider === model.provider);
  }

  private backendFor(model: ModelInfo): Backend {
    const backend = this.findBackend(model);
    if (!backend) throw new Error(`Fusion: no backend for ${model.provider} models (${model.id})`);
    return backend;
  }

  private recordLeg(
    taskId: string,
    role: LegRole,
    ref: ModelRef,
    started: number,
    outcome: LegOutcome,
    metrics: CallMetrics | undefined,
    detail?: string,
  ): void {
    this.ledger.record({
      taskId,
      role,
      model: metrics?.servedBy ?? ref.model,
      effort: ref.effort,
      outcome,
      ms: Date.now() - started,
      usage: metrics?.usage ?? ZERO_USAGE,
      costUsd: metrics?.costUsd ?? (metrics ? undefined : 0),
      detail,
    });
  }
}

function outcomeOf(err: unknown): LegOutcome {
  if (isCancellation(err)) return 'cancelled';
  if (err instanceof TimeoutError) return 'timeout';
  return 'error';
}

export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
