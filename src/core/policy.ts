import type { FusionConfig } from './config';
import type { ModelRegistry } from './models';
import { shiftDifficulty } from './signals';
import type { Difficulty, Effort, ModelRef, Objective, Pattern, Plan, RouteDecision, Tier } from './types';

type Slot = [Tier, Effort];

interface Spec {
  pattern: Pattern;
  solver: Slot;
  escalate?: Slot;
  gate?: Slot;
  critic?: Slot;
}

/**
 * The routing policy: the least complex workflow expected to meet the quality bar for each
 * difficulty, per objective. Cheap models get the first attempt wherever a gate or a reviewer can
 * catch them; the frontier model is used directly only where a cheaper first attempt would usually
 * be thrown away.
 */
export const POLICY: Record<Objective, Record<Difficulty, Spec>> = {
  fast: {
    trivial: { pattern: 'single', solver: ['fast', 'low'] },
    easy: { pattern: 'single', solver: ['fast', 'medium'] },
    medium: { pattern: 'cascade', solver: ['fast', 'medium'], escalate: ['balanced', 'medium'], gate: ['balanced', 'low'] },
    hard: { pattern: 'cascade', solver: ['balanced', 'medium'], escalate: ['frontier', 'medium'], gate: ['frontier', 'low'] },
  },
  balanced: {
    trivial: { pattern: 'single', solver: ['fast', 'low'] },
    easy: { pattern: 'cascade', solver: ['fast', 'medium'], escalate: ['balanced', 'medium'], gate: ['balanced', 'low'] },
    medium: { pattern: 'cascade', solver: ['balanced', 'medium'], escalate: ['frontier', 'high'], gate: ['frontier', 'low'] },
    hard: { pattern: 'critique', solver: ['frontier', 'high'], critic: ['balanced', 'medium'] },
  },
  quality: {
    trivial: { pattern: 'single', solver: ['balanced', 'low'] },
    easy: { pattern: 'cascade', solver: ['balanced', 'medium'], escalate: ['frontier', 'high'], gate: ['frontier', 'low'] },
    medium: { pattern: 'critique', solver: ['frontier', 'high'], critic: ['balanced', 'high'] },
    hard: { pattern: 'critique', solver: ['frontier', 'xhigh'], critic: ['balanced', 'high'] },
  },
};

/** Medium tasks that are mostly debugging or reasoning get a reviewer instead of a gate. */
const REVIEWED_MEDIUM: Record<Objective, Spec | undefined> = {
  fast: undefined,
  balanced: { pattern: 'critique', solver: ['balanced', 'high'], critic: ['frontier', 'medium'] },
  quality: undefined,
};

const TIERS: Tier[] = ['fast', 'balanced', 'frontier'];

/** No model in the pool can be called: usually no API key yet. A configuration problem, never worth a retry. */
export class NoAvailableModelError extends Error {
  constructor(role: string, wanted: string) {
    super(
      `Fusion has no model it can call for the ${role} role (wanted ${wanted}). If you have not set one yet, add an Anthropic API key: "Fusion: Set Anthropic API Key" in VS Code, or ANTHROPIC_API_KEY for the command-line gateway.`,
    );
    this.name = 'NoAvailableModelError';
  }
}

function above(t: Tier): Tier {
  return TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(t) + 1)];
}

export interface PolicyInput {
  decision: RouteDecision;
  objective: Objective;
  agentic: boolean;
}

/**
 * Turns a routing decision into a concrete, validated plan. Every model the plan names is checked
 * against the registry and `available` before any request runs; a missing model falls back to the
 * nearest available tier and the substitution is noted in `reason`.
 */
export function planFor(
  input: PolicyInput,
  cfg: FusionConfig,
  registry: ModelRegistry,
  available: (modelId: string) => boolean,
): Plan {
  const { decision, objective } = input;
  let difficulty = decision.difficulty;
  const notes: string[] = [];
  if (decision.risk === 'high' && difficulty !== 'hard') {
    difficulty = shiftDifficulty(difficulty, +1);
    notes.push('high risk, bumped one level');
  }

  let spec = POLICY[objective][difficulty];
  const s = decision.signals;
  if (difficulty === 'medium' && (s.debugging >= 2 || s.reasoning >= 2 || decision.needsReview) && REVIEWED_MEDIUM[objective]) {
    spec = REVIEWED_MEDIUM[objective]!;
    notes.push(decision.needsReview ? 'review recommended' : s.debugging >= 2 ? 'debugging-heavy' : 'reasoning-heavy');
  }
  if (!input.agentic && difficulty === 'easy' && objective !== 'quality' && spec.pattern === 'cascade') {
    spec = { pattern: 'single', solver: ['fast', 'medium'] };
    notes.push('chat answer, no gate needed');
  }
  if (cfg.forcePattern !== 'auto' && cfg.forcePattern !== spec.pattern) {
    spec = forced(cfg.forcePattern, spec);
    notes.push(`pattern forced to ${cfg.forcePattern}`);
  }

  const resolve = (slot: Slot | undefined, role: string): ModelRef | undefined => {
    if (!slot) return undefined;
    const [tier, effort] = slot;
    const wanted = role === 'critic' && cfg.critique.model ? cfg.critique.model : cfg.pool[tier];
    if (registry.get(wanted) && available(wanted)) return { model: wanted, effort };
    // Validated routing: substitute the nearest available tier (upward on ties) rather than failing mid-task.
    const at = TIERS.indexOf(tier);
    const order = [...TIERS].sort((a, b) => Math.abs(TIERS.indexOf(a) - at) - Math.abs(TIERS.indexOf(b) - at) || TIERS.indexOf(b) - TIERS.indexOf(a));
    for (const t of order) {
      const id = cfg.pool[t];
      if (registry.get(id) && available(id)) {
        notes.push(`${registry.short(wanted)} unavailable, using ${registry.short(id)}`);
        return { model: id, effort };
      }
    }
    throw new NoAvailableModelError(role, wanted);
  };

  const plan: Plan = {
    pattern: spec.pattern,
    solver: resolve(spec.solver, 'solver')!,
    escalate: resolve(spec.escalate, 'escalation'),
    gate: resolve(spec.gate, 'gate'),
    critic: resolve(spec.critic, 'critic'),
    reason: '',
  };
  plan.reason = describe(plan, difficulty, registry, notes);
  return plan;
}

function forced(pattern: Pattern, base: Spec): Spec {
  const [tier, effort] = base.solver;
  switch (pattern) {
    case 'single':
      return { pattern, solver: base.solver };
    case 'cascade': {
      const drafter: Tier = tier === 'frontier' ? 'balanced' : tier;
      return { pattern, solver: [drafter, effort], escalate: [above(drafter), 'high'], gate: [above(drafter), 'low'] };
    }
    case 'critique':
      return { pattern, solver: base.solver, critic: [tier === 'frontier' ? 'balanced' : above(tier), 'medium'] };
  }
}

export function describe(plan: Plan, difficulty: Difficulty, registry: ModelRegistry, notes: string[] = []): string {
  const m = (r?: ModelRef) => (r ? `${registry.short(r.model)} (${r.effort})` : '?');
  let flow: string;
  switch (plan.pattern) {
    case 'single':
      flow = `single: ${m(plan.solver)}`;
      break;
    case 'cascade':
      flow = `cascade: ${m(plan.solver)} drafts, ${m(plan.gate)} gates, ${m(plan.escalate)} takes over if rejected`;
      break;
    case 'critique':
      flow = `critique: ${m(plan.solver)} drafts, ${m(plan.critic)} reviews, one revision`;
      break;
  }
  return `${difficulty}${notes.length ? ` (${notes.join('; ')})` : ''} → ${flow}`;
}
