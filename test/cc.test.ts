import { describe, expect, it } from 'vitest';
import { claudeArgs, parseJsonObject, parseStream, type ClaudeRunOptions, type ClaudeRunResult } from '../src/cc/claude';
import { ccPlan, runCc, type CcOptions } from '../src/cc/run';
import type { RouteDecision } from '../src/core/types';

const decision = (difficulty: RouteDecision['difficulty'], extra: Partial<RouteDecision> = {}): RouteDecision => ({
  difficulty,
  risk: 'low',
  signals: { reasoning: 0, codegen: 1, debugging: 0, toolUse: 1 },
  needsReview: false,
  source: 'forced',
  rationale: '',
  ...extra,
});

/** A scripted Claude Code: each call returns the next reply and is recorded. */
function fake(replies: Array<Partial<ClaudeRunResult>>) {
  const calls: ClaudeRunOptions[] = [];
  const run = async (o: ClaudeRunOptions): Promise<ClaudeRunResult> => {
    calls.push(o);
    const r = replies.shift() ?? { text: 'done' };
    return { ok: true, text: '', costUsd: 0.01, ms: 5, turns: 1, steps: [], sessionId: `s${calls.length}`, ...r };
  };
  return { run, calls };
}

const base = (over: Partial<CcOptions>): CcOptions => ({
  prompt: 'Add a --dry-run flag to the deploy script and test it',
  cwd: '.',
  claudePath: 'claude',
  objective: 'balanced',
  pattern: 'auto',
  sideEffects: false,
  guardTools: [],
  difficulty: 'medium',
  router: 'heuristic',
  tiers: { fast: 'haiku', balanced: 'sonnet', frontier: 'opus' },
  chrome: false,
  permissionMode: 'auto',
  legTimeoutMs: 60_000,
  maxUsd: 5,
  gateThreshold: 0.6,
  ...over,
});

describe('ccPlan', () => {
  it('follows the shared policy table', () => {
    expect(ccPlan(decision('trivial'), { objective: 'balanced', pattern: 'auto', sideEffects: false }).pattern).toBe('single');
    const medium = ccPlan(decision('medium'), { objective: 'balanced', pattern: 'auto', sideEffects: false });
    expect(medium).toMatchObject({ pattern: 'cascade', solver: ['balanced', 'medium'], gate: ['frontier', 'low'], escalate: ['frontier', 'high'] });
    expect(ccPlan(decision('hard'), { objective: 'balanced', pattern: 'auto', sideEffects: false }).pattern).toBe('critique');
  });

  it('uses the guarded pattern for side effects, with a different-tier reviewer and a cheaper executor', () => {
    const hard = ccPlan(decision('hard'), { objective: 'balanced', pattern: 'auto', sideEffects: true });
    expect(hard).toMatchObject({ pattern: 'guarded', solver: ['frontier', 'high'], critic: ['balanced', 'high'], executor: ['balanced', 'medium'] });
    const easy = ccPlan(decision('easy'), { objective: 'balanced', pattern: 'auto', sideEffects: true });
    expect(easy.solver[0]).toBe('balanced');
    expect(easy.critic).toEqual(['frontier', 'low']);
  });

  it('bumps high-risk tasks one level', () => {
    expect(ccPlan(decision('medium', { risk: 'high' }), { objective: 'balanced', pattern: 'auto', sideEffects: false }).pattern).toBe('critique');
  });
});

describe('runCc', () => {
  it('cascade: ships the draft when the gate accepts', async () => {
    const f = fake([{ text: 'draft answer' }, { text: '{"issues":[],"confidence":0.9,"accept":true}' }]);
    const out = await runCc(base({ run: f.run }));
    expect(out.result).toBe('draft answer');
    expect(out.escalated).toBe(false);
    expect(f.calls.map((c) => c.model)).toEqual(['sonnet', 'opus']);
    expect(f.calls[1].toolless).toBe(true);
    expect(f.calls[0].persist).toBe(true);
  });

  it('cascade: escalates by resuming the drafter session when the gate rejects', async () => {
    const f = fake([
      { text: 'draft', sessionId: 'abc' },
      { text: '{"issues":["tests never ran"],"confidence":0.3,"accept":false}' },
      { text: 'fixed answer' },
    ]);
    const out = await runCc(base({ run: f.run }));
    expect(out.escalated).toBe(true);
    expect(out.result).toBe('fixed answer');
    expect(f.calls[2]).toMatchObject({ model: 'opus', effort: 'high', resume: 'abc' });
    expect(f.calls[2].prompt).toContain('tests never ran');
  });

  it('cascade: skips the gate once the budget is spent', async () => {
    const f = fake([{ text: 'draft', costUsd: 9 }]);
    const out = await runCc(base({ run: f.run }));
    expect(f.calls).toHaveLength(1);
    expect(out.reason).toContain('budget');
  });

  it('critique: revises once on serious issues', async () => {
    const f = fake([
      { text: 'draft', sessionId: 'd1' },
      { text: '{"issues":[{"severity":"major","issue":"misses the edge case","suggestion":"handle empty"}],"verdict":"revise"}' },
      { text: 'revised' },
    ]);
    const out = await runCc(base({ run: f.run, difficulty: 'hard' }));
    expect(out.pattern).toBe('critique');
    expect(out.result).toBe('revised');
    expect(f.calls[2].resume).toBe('d1');
  });

  it('guarded: plans without the side-effect tools, gets approval, then executes the plan on the executor', async () => {
    const f = fake([
      { text: 'ACTIONS: 1\n1. Reply to Darin: "Friday 10:30 works."', sessionId: 'p1' },
      { text: '{"issues":[],"verdict":"approve"}' },
      { text: 'Sent the reply.' },
    ]);
    const out = await runCc(base({ run: f.run, sideEffects: true, guardTools: ['mcp__claude_ai_Gmail__reply'] }));
    expect(out.pattern).toBe('guarded');
    expect(f.calls[0].disallowedTools).toEqual(['mcp__claude_ai_Gmail__reply']);
    expect(f.calls[1].toolless).toBe(true);
    expect(f.calls[2].disallowedTools).toBeUndefined();
    expect(f.calls[2].prompt).toContain('Friday 10:30 works.');
    expect(out.result).toBe('Sent the reply.');
  });

  it('guarded: ends after planning when there is nothing to do', async () => {
    const f = fake([{ text: 'ACTIONS: 0\nNo new emails need a reply.' }]);
    const out = await runCc(base({ run: f.run, sideEffects: true }));
    expect(f.calls).toHaveLength(1);
    expect(out.ok).toBe(true);
  });

  it('guarded: never executes a plan the reviewer still rejects after one revision', async () => {
    const reject = { text: '{"issues":[{"severity":"critical","issue":"double-books 10:30","suggestion":"use 1:30"}],"verdict":"revise"}' };
    const f = fake([{ text: 'ACTIONS: 1\n1. Book 10:30', sessionId: 'p1' }, reject, { text: 'ACTIONS: 1\n1. Book 10:30 anyway' }, reject]);
    const out = await runCc(base({ run: f.run, sideEffects: true }));
    expect(out.ok).toBe(false);
    expect(f.calls.map((c) => c.toolless ?? false)).toEqual([false, true, false, true]);
    expect(out.legs.some((l) => l.role === 'execute')).toBe(false);
  });

  it('routes with heuristics when asked, and with the fast tier model otherwise', async () => {
    const f = fake([{ text: '{"difficulty":"easy","reasoning":0,"codegen":1,"debugging":0,"toolUse":1,"risk":"low","needsReview":false,"rationale":"small"}' }, { text: 'draft' }, { text: '{"issues":[],"confidence":0.95,"accept":true}' }]);
    const out = await runCc(base({ run: f.run, difficulty: undefined, router: 'model' }));
    expect(f.calls[0]).toMatchObject({ model: 'haiku', toolless: true });
    expect(out.difficulty).toBe('easy');
  });
});

describe('claude helpers', () => {
  it('builds the CLI arguments', () => {
    const args = claudeArgs({ claudePath: 'c', prompt: 'x', model: 'opus', effort: 'high', cwd: '.', toolless: true, timeoutMs: 1, disallowedTools: ['A', 'B'] });
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'opus', '--effort', 'high', '--tools', '', '--disallowedTools', 'A,B', '--no-session-persistence']));
    expect(claudeArgs({ claudePath: 'c', prompt: 'x', model: 'm', effort: 'low', cwd: '.', timeoutMs: 1, resume: 's1' })).toEqual(expect.arrayContaining(['--resume', 's1']));
  });

  it('parses stream-json into the result and a tool log', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '12 passed', is_error: false }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All green.', session_id: 'abc', total_cost_usd: 0.12, num_turns: 3 }),
    ];
    const r = parseStream(lines);
    expect(r).toMatchObject({ ok: true, text: 'All green.', sessionId: 'abc', costUsd: 0.12 });
    expect(r.steps[0]).toMatchObject({ name: 'Bash', result: '12 passed' });
  });

  it('pulls JSON out of fenced or chatty answers', () => {
    expect(parseJsonObject('Here you go:\n```json\n{"accept": true}\n```')).toEqual({ accept: true });
    expect(parseJsonObject('verdict {"verdict":"approve","issues":[]} done')).toEqual({ verdict: 'approve', issues: [] });
  });
});
