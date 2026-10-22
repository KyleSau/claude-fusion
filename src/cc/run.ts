import { POLICY, REVIEWED_MEDIUM } from '../core/policy';
import {
  CRITIC_SYSTEM,
  critiqueNote,
  escalationNote,
  GATE_SYSTEM,
  normalizeCritique,
  normalizeGate,
  normalizeRoute,
  reviewPrompt,
  ROUTER_SYSTEM,
  routerPrompt,
  type CritiqueJson,
} from '../core/prompts';
import { extractFeatures, heuristicRoute, obviouslyTrivial, shiftDifficulty } from '../core/signals';
import { truncateMiddle } from '../core/transcript';
import type { Difficulty, Effort, Objective, RouteDecision, Tier, Tool } from '../core/types';
import { parseJsonObject, runClaude, workLog, type ClaudeRunOptions, type ClaudeRunResult } from './claude';

/**
 * Multi-model orchestration on Claude Code. The same routing, policy and review prompts as the API
 * orchestrator, but every leg is a headless Claude Code run, so a cascade or a critique runs on your
 * Claude Code login instead of an API key.
 *
 * Patterns:
 * - single   one model does the task.
 * - cascade  a cheaper model does it; a tool-less gate reads the request, a condensed log of what it did
 *            and its answer; on rejection a stronger model resumes the same session and finishes.
 * - critique a model does it; an independent, tool-less reviewer reads the result; the drafter revises once.
 * - guarded  for tasks with side effects (email, calendar, forms, deploys): the planner may read but not
 *            act and writes an exact action plan; a tool-less reviewer approves or sends it back once;
 *            a cheaper executor then carries out only the approved plan. Nothing irreversible happens
 *            before review, and a plan with no actions ends the task early.
 */

export type CcPattern = 'single' | 'cascade' | 'critique' | 'guarded';

export interface CcOptions {
  prompt: string;
  appendSystem?: string;
  cwd: string;
  claudePath: string;
  objective: Objective;
  pattern: CcPattern | 'auto';
  /** The task changes things outside the workspace: use the guarded pattern when pattern is auto. */
  sideEffects: boolean;
  /** Tools the guarded planner may not call (the side-effecting ones). */
  guardTools: string[];
  /** Skip the router and use this difficulty. */
  difficulty?: Difficulty;
  router: 'model' | 'heuristic';
  tiers: Record<Tier, string>;
  chrome: boolean;
  permissionMode: string;
  legTimeoutMs: number;
  /** Once a task has cost this much (list-price estimate), optional legs (gate, critique, escalation) are skipped. */
  maxUsd: number;
  gateThreshold: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Test seam. */
  run?: (o: ClaudeRunOptions) => Promise<ClaudeRunResult>;
}

export interface CcLeg {
  role: 'route' | 'solve' | 'draft' | 'gate' | 'escalate' | 'critique' | 'revise' | 'plan' | 'review' | 'replan' | 'execute';
  model: string;
  effort: Effort;
  ok: boolean;
  ms: number;
  costUsd: number;
  sessionId?: string;
  detail?: string;
}

export interface CcOutcome {
  ok: boolean;
  result: string;
  pattern: CcPattern;
  difficulty: Difficulty;
  decision: RouteDecision;
  reason: string;
  legs: CcLeg[];
  costUsd: number;
  ms: number;
  escalated: boolean;
  /** Guarded: the plan that was executed (or that ended the task with no actions). */
  plan?: string;
}

type Slot = [Tier, Effort];

const JSON_ROUTE = 'Respond with only a JSON object with these keys: difficulty, reasoning, codegen, debugging, toolUse, risk, needsReview, rationale.';
const JSON_GATE = 'Respond with only a JSON object: {"issues": [strings], "confidence": number 0-1, "accept": boolean}.';
const JSON_CRITIQUE = 'Respond with only a JSON object: {"issues": [{"severity": "critical|major|minor", "issue": string, "suggestion": string}], "verdict": "approve|revise"}.';

export const PLAN_NOTE = `[Fusion orchestrator: planning pass] Read whatever you need, but take no action with side effects: do not send, reply, post, book, accept, submit, purchase, delete, or change any record or file outside your scratch notes. Work out the complete plan instead.

Start your final answer with a line "ACTIONS: <n>" giving the number of actions, then list each action, numbered, with its exact target and exact content (full message text, times with time zone, field values, file paths). Then list what you are deliberately not doing and why. If nothing needs doing, answer "ACTIONS: 0" and explain. The plan will be reviewed, then carried out exactly as written by another model.`;

export const PLAN_REVIEW_SYSTEM = `You review an action plan before anything in it is carried out. A model has read the situation and written the exact actions it intends to take (emails, messages, calendar changes, form submissions, record updates). You see the task, the evidence it gathered (a condensed log of what it read), and the plan. You cannot run tools.

Send it back ("revise") when any action is wrong or unsafe: unsupported by the evidence, contacts the wrong person or a no-reply address, double-books or misstates a time or time zone, duplicates something already done, invents facts, breaks a rule stated in the task, exceeds a stated limit, or is irreversible while the evidence is uncertain. Also send it back when a clearly required action is missing. Approve a correct plan with no issues; approving good work is the expected outcome.`;

export function execNote(plan: string): string {
  return `[Fusion orchestrator: execution pass] The plan below was written by a planning model and approved by an independent reviewer. Carry it out exactly: take each listed action in order, with the exact content given. Do not add actions that are not in the plan. You may read what you need to carry out a step. If a step can no longer be done as written (the situation changed, a page differs, a limit is reached), skip it and say why. Finish with a short report of what you did and what you skipped.

<approved_plan>
${plan}
</approved_plan>`;
}

function actionCount(plan: string): number | undefined {
  const m = plan.match(/ACTIONS:\s*(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

const TIERS: Tier[] = ['fast', 'balanced', 'frontier'];
const above = (t: Tier): Tier => TIERS[Math.min(2, TIERS.indexOf(t) + 1)];
const atLeast = (t: Tier, min: Tier): Tier => (TIERS.indexOf(t) < TIERS.indexOf(min) ? min : t);

export interface CcPlan {
  pattern: CcPattern;
  solver: Slot;
  escalate?: Slot;
  gate?: Slot;
  critic?: Slot;
  executor?: Slot;
  reason: string;
}

/** Same policy table as the API orchestrator, plus the guarded pattern for side-effecting work. */
export function ccPlan(decision: RouteDecision, o: Pick<CcOptions, 'objective' | 'pattern' | 'sideEffects'>): CcPlan {
  let difficulty = decision.difficulty;
  const notes: string[] = [];
  if (decision.risk === 'high' && difficulty !== 'hard') {
    difficulty = shiftDifficulty(difficulty, +1);
    notes.push('high risk, bumped one level');
  }
  let spec = POLICY[o.objective][difficulty];
  const s = decision.signals;
  if (difficulty === 'medium' && (s.debugging >= 2 || s.reasoning >= 2 || decision.needsReview) && REVIEWED_MEDIUM[o.objective]) {
    spec = REVIEWED_MEDIUM[o.objective]!;
    notes.push('review recommended');
  }
  const want: CcPattern = o.pattern === 'auto' ? (o.sideEffects ? 'guarded' : spec.pattern) : o.pattern;
  let plan: CcPlan;
  if (want === 'guarded') {
    // The planner carries the judgment, so it gets the policy's solver tier (at least balanced);
    // the reviewer is a different tier from the planner; the executor only follows the plan.
    const planner: Slot = [atLeast(spec.solver[0], 'balanced'), spec.solver[1] === 'low' ? 'medium' : spec.solver[1]];
    const reviewer: Slot = planner[0] === 'frontier' ? ['balanced', 'high'] : ['frontier', 'low'];
    plan = { pattern: 'guarded', solver: planner, critic: reviewer, executor: ['balanced', 'medium'], reason: '' };
  } else if (want === spec.pattern) {
    plan = { pattern: want, solver: spec.solver, escalate: spec.escalate, gate: spec.gate, critic: spec.critic, reason: '' };
  } else if (want === 'single') {
    plan = { pattern: 'single', solver: spec.solver, reason: '' };
  } else if (want === 'cascade') {
    const drafter: Tier = spec.solver[0] === 'frontier' ? 'balanced' : spec.solver[0];
    plan = { pattern: 'cascade', solver: [drafter, spec.solver[1]], escalate: [above(drafter), 'high'], gate: [above(drafter), 'low'], reason: '' };
  } else {
    plan = { pattern: 'critique', solver: spec.solver, critic: [spec.solver[0] === 'frontier' ? 'balanced' : above(spec.solver[0]), 'medium'], reason: '' };
  }
  if (o.pattern !== 'auto') notes.push(`pattern forced to ${o.pattern}`);
  plan.reason = `${difficulty}${notes.length ? ` (${notes.join('; ')})` : ''} → ${plan.pattern}`;
  return plan;
}

export async function runCc(o: CcOptions): Promise<CcOutcome> {
  const run = o.run ?? runClaude;
  const started = Date.now();
  const legs: CcLeg[] = [];
  const log = o.log ?? (() => {});
  const spent = () => legs.reduce((a, l) => a + l.costUsd, 0);
  const model = (t: Tier) => o.tiers[t];

  const leg = async (
    role: CcLeg['role'],
    slot: Slot,
    prompt: string,
    extra: Partial<ClaudeRunOptions> = {},
  ): Promise<ClaudeRunResult> => {
    log(`${role}: ${model(slot[0])} (${slot[1]})`);
    const r = await run({
      claudePath: o.claudePath,
      prompt,
      model: model(slot[0]),
      effort: slot[1],
      cwd: o.cwd,
      appendSystem: o.appendSystem,
      permissionMode: o.permissionMode,
      chrome: o.chrome,
      timeoutMs: o.legTimeoutMs,
      signal: o.signal,
      ...extra,
    });
    legs.push({ role, model: model(slot[0]), effort: slot[1], ok: r.ok, ms: r.ms, costUsd: r.costUsd, sessionId: r.sessionId, detail: r.error });
    log(`${role}: ${r.ok ? 'ok' : `failed (${r.error ?? 'error'})`} in ${Math.round(r.ms / 1000)}s, $${r.costUsd.toFixed(3)}`);
    return r;
  };

  const judge = async (role: 'gate' | 'critique' | 'review', slot: Slot, system: string, body: string, format: string) => {
    const r = await leg(role, slot, `${body}\n\n${format}`, { toolless: true, appendSystem: system, chrome: false, permissionMode: 'auto' });
    return { r, json: r.ok ? parseJsonObject(r.text) : undefined };
  };

  // 1. Route.
  // Claude Code legs always have tools, so routing treats every task as agentic.
  const tools = [{ name: 'agent', input_schema: { type: 'object' } } as Tool];
  const features = extractFeatures([{ role: 'user', content: o.prompt }], tools);
  let decision: RouteDecision;
  if (o.difficulty) {
    decision = { ...heuristicRoute(features), difficulty: o.difficulty, source: 'forced', rationale: 'difficulty given by the caller' };
  } else if (o.router === 'heuristic' || obviouslyTrivial(features)) {
    decision = heuristicRoute(features);
  } else {
    const body = routerPrompt({ request: truncateMiddle(features.request, 8_000), context: '', earlier: '', tools: ['agent tools'] });
    const r = await leg('route', ['fast', 'low'], `${body}\n\n${JSON_ROUTE}`, { toolless: true, appendSystem: ROUTER_SYSTEM, chrome: false });
    const j = r.ok ? parseJsonObject(r.text) : undefined;
    if (j && typeof j.difficulty === 'string') {
      const v = normalizeRoute({
        difficulty: String(j.difficulty), reasoning: Number(j.reasoning), codegen: Number(j.codegen), debugging: Number(j.debugging),
        toolUse: Number(j.toolUse), risk: String(j.risk ?? 'medium'), needsReview: j.needsReview === true, rationale: String(j.rationale ?? ''),
      });
      decision = { difficulty: v.difficulty, risk: v.risk, signals: { reasoning: v.reasoning, codegen: v.codegen, debugging: v.debugging, toolUse: v.toolUse }, needsReview: v.needsReview, source: 'model', rationale: v.rationale };
    } else {
      decision = { ...heuristicRoute(features), rationale: 'router failed; heuristics' };
    }
  }
  const plan = ccPlan(decision, o);
  log(`plan: ${plan.reason}${decision.rationale ? ` · ${decision.rationale}` : ''}`);
  const done = (ok: boolean, result: string, extra: Partial<CcOutcome> = {}): CcOutcome => ({
    ok, result, pattern: plan.pattern, difficulty: decision.difficulty, decision, reason: plan.reason, legs,
    costUsd: Number(spent().toFixed(4)), ms: Date.now() - started, escalated: false, ...extra,
  });

  // 2. Run the pattern.
  if (plan.pattern === 'single') {
    const r = await leg('solve', plan.solver, o.prompt);
    return done(r.ok, r.text);
  }

  if (plan.pattern === 'cascade') {
    const d = await leg('draft', plan.solver, o.prompt, { persist: true });
    if (spent() >= o.maxUsd) return done(d.ok, d.text, { reason: `${plan.reason}; budget reached, gate skipped` });
    let reasons: string[] = [];
    if (!d.ok) {
      reasons = [`the first attempt failed: ${d.error ?? 'error'}`];
    } else {
      const work = { request: o.prompt, context: '', earlier: '', steps: d.steps.length, log: workLog(d.steps) };
      const g = await judge('gate', plan.gate!, GATE_SYSTEM, reviewPrompt(work,d.text), JSON_GATE);
      if (!g.json) return done(true, d.text, { reason: `${plan.reason}; gate unavailable, draft kept` });
      const v = normalizeGate({ issues: (g.json.issues as string[]) ?? [], confidence: Number(g.json.confidence), accept: g.json.accept === true });
      legs[legs.length - 1].detail = `${v.accept ? 'accept' : 'reject'} ${v.confidence.toFixed(2)}${v.issues.length ? `: ${v.issues[0]}` : ''}`;
      if (v.accept && v.confidence >= o.gateThreshold) return done(true, d.text);
      reasons = v.issues.length ? v.issues : ['the quality gate was not confident in the result'];
    }
    const note = escalationNote(reasons, d.ok ? d.text : undefined);
    const e = d.sessionId
      ? await leg('escalate', plan.escalate!, note, { resume: d.sessionId })
      : await leg('escalate', plan.escalate!, `${o.prompt}\n\n${note}`);
    return done(e.ok, e.ok ? e.text : d.text, { escalated: true });
  }

  if (plan.pattern === 'critique') {
    const d = await leg('draft', plan.solver, o.prompt, { persist: true });
    if (!d.ok || spent() >= o.maxUsd) return done(d.ok, d.text);
    const work = { request: o.prompt, context: '', earlier: '', steps: d.steps.length, log: workLog(d.steps) };
    const c = await judge('critique', plan.critic!, CRITIC_SYSTEM, reviewPrompt(work,d.text), JSON_CRITIQUE);
    const v: CritiqueJson | undefined = c.json ? normalizeCritique({ issues: (c.json.issues as never) ?? [], verdict: String(c.json.verdict ?? '') }) : undefined;
    const serious = v?.issues.filter((i) => i.severity !== 'minor') ?? [];
    if (!v || v.verdict === 'approve' || !serious.length || !d.sessionId) return done(true, d.text);
    legs[legs.length - 1].detail = `${serious.length} issue(s): ${serious[0].issue}`;
    const rv = await leg('revise', plan.solver, critiqueNote(serious, d.text), { resume: d.sessionId });
    return done(rv.ok || d.ok, rv.ok ? rv.text : d.text);
  }

  // guarded: plan (no side effects) -> review -> execute the approved plan.
  const guard = { disallowedTools: o.guardTools, persist: true };
  let p = await leg('plan', plan.solver, `${o.prompt}\n\n${PLAN_NOTE}`, guard);
  if (!p.ok) return done(false, p.text || p.error || 'planning failed');
  if (actionCount(p.text) === 0) return done(true, p.text, { plan: p.text, reason: `${plan.reason}; nothing to do, ended after planning` });
  for (let round = 0; round < 2; round++) {
    const work = { request: o.prompt, context: '', earlier: '', steps: p.steps.length, log: workLog(p.steps) };
    const c = await judge('review', plan.critic!, PLAN_REVIEW_SYSTEM, reviewPrompt(work,p.text), JSON_CRITIQUE);
    const v = c.json ? normalizeCritique({ issues: (c.json.issues as never) ?? [], verdict: String(c.json.verdict ?? '') }) : undefined;
    if (!v) return done(false, p.text, { plan: p.text, reason: `${plan.reason}; reviewer unavailable, nothing executed` });
    const serious = v.issues.filter((i) => i.severity !== 'minor');
    legs[legs.length - 1].detail = v.verdict === 'approve' || !serious.length ? 'approved' : `${serious.length} issue(s): ${serious[0].issue}`;
    if (v.verdict === 'approve' || !serious.length) break;
    if (round === 1 || !p.sessionId) {
      return done(false, p.text, { plan: p.text, reason: `${plan.reason}; plan still rejected after one revision, nothing executed` });
    }
    p = await leg('replan', plan.solver, `${critiqueNote(serious, p.text)}\n\n${PLAN_NOTE}`, { ...guard, resume: p.sessionId });
    if (!p.ok) return done(false, p.text || 'replanning failed');
    if (actionCount(p.text) === 0) return done(true, p.text, { plan: p.text });
  }
  const x = await leg('execute', plan.executor!, `${o.prompt}\n\n${execNote(p.text)}`);
  return done(x.ok, x.text, { plan: p.text });
}
