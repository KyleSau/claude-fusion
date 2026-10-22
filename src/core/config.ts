import { DEFAULT_POOL, type ModelRegistry } from './models';
import type { Effort, Objective, Pattern, Tier } from './types';

export interface FusionConfig {
  /** Objective used when a request does not name one (e.g. the plain `fusion` model id). */
  objective: Objective;
  /** Which model fills each tier. */
  pool: Record<Tier, string>;
  router: {
    /** `model` asks the router model to classify each new task; `heuristic` never makes that call. */
    mode: 'model' | 'heuristic';
    model: string;
    effort: Effort;
    timeoutMs: number;
  };
  /** Force one pattern for every task (useful for comparing workflows). */
  forcePattern: Pattern | 'auto';
  gate: {
    /** Minimum judge confidence needed to accept a draft. */
    threshold: number;
    /** What to do when the gate itself fails: escalate (protect quality) or accept (protect cost). */
    onError: 'escalate' | 'accept';
    timeoutMs: number;
  };
  critique: {
    /** Preferred critic. Empty = pick automatically, preferring a different model family. */
    model: string;
    /** Lowest issue severity that triggers a revision. */
    minSeverity: 'critical' | 'major' | 'minor';
    timeoutMs: number;
  };
  cascade: {
    /** A drafter that has not finished after this many tool-calling steps hands over to the stronger model. */
    maxDraftSteps: number;
  };
  budget: {
    /** Per-task ceiling for optional legs (gate, critic, escalation). Solver calls are never cut off. */
    maxTaskUsd: number;
  };
  /** Ask for between-tool progress notes on models that support them. */
  progressUpdates: boolean;
  /** Opt into server-side refusal fallback (`fallbacks: "default"`) where the model and request allow it. */
  refusalFallback: boolean;
  /** Default output ceiling for solver calls when the client does not set one. */
  maxOutputTokens: number;
}

export const DEFAULT_CONFIG: FusionConfig = {
  objective: 'balanced',
  pool: { ...DEFAULT_POOL },
  router: { mode: 'model', model: DEFAULT_POOL.fast, effort: 'low', timeoutMs: 20_000 },
  forcePattern: 'auto',
  gate: { threshold: 0.6, onError: 'escalate', timeoutMs: 90_000 },
  critique: { model: '', minSeverity: 'major', timeoutMs: 120_000 },
  cascade: { maxDraftSteps: 40 },
  budget: { maxTaskUsd: 5 },
  progressUpdates: true,
  refusalFallback: true,
  maxOutputTokens: 64_000,
};

/** Deep-merges a partial config over the defaults. */
export function resolveConfig(partial: DeepPartial<FusionConfig> = {}): FusionConfig {
  return mergeDeep(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, partial as Record<string, unknown>) as unknown as FusionConfig;
}

/**
 * Checks that every model the policy can route to exists, before any request runs.
 * Returns human-readable problems (empty when valid).
 */
export function validateConfig(cfg: FusionConfig, registry: ModelRegistry): string[] {
  const problems: string[] = [];
  const check = (what: string, id: string) => {
    if (id && !registry.get(id)) problems.push(`${what} model "${id}" is not available`);
  };
  check('fast tier', cfg.pool.fast);
  check('balanced tier', cfg.pool.balanced);
  check('frontier tier', cfg.pool.frontier);
  check('critic', cfg.critique.model);
  check('router', cfg.router.model);
  if (cfg.gate.threshold < 0 || cfg.gate.threshold > 1) problems.push('gate.threshold must be between 0 and 1');
  if (cfg.cascade.maxDraftSteps < 1) problems.push('cascade.maxDraftSteps must be at least 1');
  if (cfg.budget.maxTaskUsd <= 0) problems.push('budget.maxTaskUsd must be positive');
  return problems;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      mergeDeep(current, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
