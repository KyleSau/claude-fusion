import { describe, expect, it } from 'vitest';
import { resolveConfig, validateConfig } from '../src/core/config';
import { ModelRegistry } from '../src/core/models';
import { planFor } from '../src/core/policy';
import type { Difficulty, Objective, RouteDecision } from '../src/core/types';

const registry = new ModelRegistry();
const everything = (_id: string) => true;

function decision(difficulty: Difficulty, extra: Partial<RouteDecision> = {}): RouteDecision {
  return {
    difficulty,
    risk: 'low',
    signals: { reasoning: 0, codegen: 2, debugging: 0, toolUse: 2 },
    needsReview: false,
    source: 'model',
    rationale: 'test',
    ...extra,
  };
}

function plan(d: RouteDecision, objective: Objective = 'balanced', agentic = true, cfg = resolveConfig(), available = everything) {
  return planFor({ decision: d, objective, agentic }, cfg, registry, available);
}

const short = (p: ReturnType<typeof plan>) => ({
  pattern: p.pattern,
  solver: `${p.solver.model}@${p.solver.effort}`,
  escalate: p.escalate && `${p.escalate.model}@${p.escalate.effort}`,
  gate: p.gate && `${p.gate.model}@${p.gate.effort}`,
  critic: p.critic && `${p.critic.model}@${p.critic.effort}`,
});

describe('balanced policy', () => {
  it('uses Haiku directly for trivial work', () => {
    expect(short(plan(decision('trivial')))).toEqual({ pattern: 'single', solver: 'claude-haiku-5-5@low', escalate: undefined, gate: undefined, critic: undefined });
  });

  it('lets Haiku draft easy agentic work behind a Sonnet gate', () => {
    expect(short(plan(decision('easy')))).toMatchObject({
      pattern: 'cascade',
      solver: 'claude-haiku-5-5@medium',
      gate: 'claude-sonnet-5-5@low',
      escalate: 'claude-sonnet-5-5@medium',
    });
  });

  it('answers easy chat questions with a single Haiku call', () => {
    expect(short(plan(decision('easy'), 'balanced', false))).toMatchObject({ pattern: 'single', solver: 'claude-haiku-5-5@medium' });
  });

  it('lets Sonnet draft medium work, with Opus at high effort taking over when the gate says no', () => {
    expect(short(plan(decision('medium')))).toMatchObject({
      pattern: 'cascade',
      solver: 'claude-sonnet-5-5@medium',
      gate: 'claude-opus-5-5@low',
      escalate: 'claude-opus-5-5@high',
    });
  });

  it('reviews debugging-heavy medium work instead of gating it', () => {
    const p = plan(decision('medium', { signals: { reasoning: 0, codegen: 1, debugging: 3, toolUse: 2 } }));
    expect(short(p)).toMatchObject({ pattern: 'critique', solver: 'claude-sonnet-5-5@high', critic: 'claude-opus-5-5@medium' });
    expect(p.reason).toContain('debugging-heavy');
  });

  it('puts Opus at high effort on hard work, with an independent review', () => {
    expect(short(plan(decision('hard')))).toMatchObject({ pattern: 'critique', solver: 'claude-opus-5-5@high', critic: 'claude-sonnet-5-5@medium' });
  });

  it('treats high-risk work one level harder', () => {
    expect(plan(decision('easy', { risk: 'high' })).solver.model).toBe('claude-sonnet-5-5');
  });
});

describe('objectives', () => {
  it('fast keeps easy work on a single Haiku call', () => {
    expect(short(plan(decision('easy'), 'fast'))).toMatchObject({ pattern: 'single', solver: 'claude-haiku-5-5@medium' });
  });

  it('quality never lets Haiku draft', () => {
    for (const d of ['trivial', 'easy', 'medium', 'hard'] as const) {
      expect(plan(decision(d), 'quality').solver.model).not.toBe('claude-haiku-5-5');
    }
  });
});

describe('validated routing', () => {
  it('substitutes the nearest available tier and says so', () => {
    const p = plan(decision('hard'), 'balanced', true, resolveConfig(), (id) => id !== 'claude-opus-5-5');
    expect(p.solver.model).toBe('claude-sonnet-5-5');
    expect(p.reason).toContain('Opus 5.5 unavailable, using Sonnet 5.5');
    const noSonnet = plan(decision('medium'), 'balanced', true, resolveConfig(), (id) => id !== 'claude-sonnet-5-5');
    expect(noSonnet.solver.model).toBe('claude-opus-5-5');
  });

  it('fails clearly when nothing is available', () => {
    expect(() => plan(decision('easy'), 'balanced', true, resolveConfig(), () => false)).toThrow(/no model it can call.*API key/);
  });

  it('honours a forced pattern', () => {
    const cfg = resolveConfig({ forcePattern: 'critique' });
    expect(plan(decision('easy'), 'balanced', true, cfg).pattern).toBe('critique');
    const single = resolveConfig({ forcePattern: 'single' });
    expect(plan(decision('hard'), 'balanced', true, single)).toMatchObject({ pattern: 'single', solver: { model: 'claude-opus-5-5' } });
  });

  it('uses a configured critic', () => {
    const cfg = resolveConfig({ critique: { model: 'claude-fable-5-1' } });
    expect(plan(decision('hard'), 'balanced', true, cfg).critic?.model).toBe('claude-fable-5-1');
  });

  it('reports unknown models in the configuration', () => {
    expect(validateConfig(resolveConfig({ pool: { fast: 'claude-nope' } }), registry)).toEqual(['fast tier model "claude-nope" is not available']);
    expect(validateConfig(resolveConfig(), registry)).toEqual([]);
  });
});
