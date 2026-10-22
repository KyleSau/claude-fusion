import { describe, expect, it } from 'vitest';
import { ANTHROPIC_MODELS, costOf, type TokenUsage } from '../src/core/models';
import { normalizeCritique, normalizeGate, normalizeRoute } from '../src/core/prompts';
import { extractFeatures, heuristicRoute, obviouslyTrivial } from '../src/core/signals';
import {
  appendNote,
  assistantFingerprint,
  condenseWork,
  footerLine,
  splitRequest,
  stripFooter,
  toParams,
} from '../src/core/transcript';
import type { ContentBlock, Msg } from '../src/core/types';
import { TOOLS, user } from './support/fakes';

const model = (id: string) => ANTHROPIC_MODELS.find((m) => m.id === id)!;
const usage = (u: Partial<TokenUsage>): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...u });

describe('pricing', () => {
  it('prices each model at its own rates', () => {
    expect(costOf(model('claude-opus-5-5'), usage({ input: 1_000_000, output: 1_000_000 }))).toBeCloseTo(24);
    expect(costOf(model('claude-sonnet-5-5'), usage({ input: 1_000_000, output: 1_000_000 }))).toBeCloseTo(12);
    expect(costOf(model('claude-haiku-5-5'), usage({ input: 1_000_000, output: 1_000_000 }))).toBeCloseTo(3); // long-context card
    expect(costOf(model('claude-haiku-5-5'), usage({ input: 50_000, output: 10_000 }))).toBeCloseTo(0.005 + 0.005);
  });

  it('prices cache reads and writes', () => {
    // Opus 5.5: reads at 0.05x ($0.20), 5-minute writes at 1.25x ($5), 1-hour writes at 2x ($8).
    expect(costOf(model('claude-opus-5-5'), usage({ cacheRead: 1_000_000 }))).toBeCloseTo(0.2);
    expect(costOf(model('claude-opus-5-5'), usage({ cacheWrite5m: 1_000_000 }))).toBeCloseTo(5);
    expect(costOf(model('claude-opus-5-5'), usage({ cacheWrite1h: 1_000_000 }))).toBeCloseTo(8);
  });

  it('has no price for models it does not know', () => {
    expect(costOf(undefined, usage({ input: 10 }))).toBeUndefined();
  });
});

describe('signals', () => {
  it('treats greetings and short plain questions as trivial', () => {
    expect(obviouslyTrivial(extractFeatures([user('thanks!')], []))).toBe(true);
    expect(obviouslyTrivial(extractFeatures([user('what does git stash do?')], []))).toBe(true);
    expect(obviouslyTrivial(extractFeatures([user('fix the bug')], []))).toBe(false);
  });

  it('finds debugging signals in stack traces', () => {
    const f = extractFeatures([user('Why does this fail?\nTraceback (most recent call last):\n  File "a.py", line 3\nTypeError: x')], TOOLS);
    const d = heuristicRoute(f);
    expect(f.stackTrace).toBe(true);
    expect(d.signals.debugging).toBeGreaterThanOrEqual(2);
    expect(d.difficulty).not.toBe('trivial');
  });

  it('respects "quick" and "think hard" hints', () => {
    const base = 'Refactor the session handling and add tests for the edge cases in the auth module';
    const plain = heuristicRoute(extractFeatures([user(base)], TOOLS)).difficulty;
    const deep = heuristicRoute(extractFeatures([user(`${base}. Think hard about it.`)], TOOLS)).difficulty;
    const quick = heuristicRoute(extractFeatures([user(`${base}, quickly`)], TOOLS)).difficulty;
    const order = ['trivial', 'easy', 'medium', 'hard'];
    expect(order.indexOf(deep)).toBeGreaterThan(order.indexOf(plain));
    expect(order.indexOf(quick)).toBeLessThan(order.indexOf(plain));
  });

  it('reads the request out of client wrappers', () => {
    expect(splitRequest('<context>big file</context><userRequest>rename foo</userRequest>').request).toBe('rename foo');
    expect(splitRequest('<system-reminder>env</system-reminder>\nfix the build').request).toBe('fix the build');
  });
});

describe('review answer normalization', () => {
  it('maps loosely formatted router answers onto the allowed values', () => {
    expect(normalizeRoute({ difficulty: ' Hard ', reasoning: 7, codegen: -2, debugging: 1.6, toolUse: Number.NaN, risk: 'CRITICAL', needsReview: true, rationale: 'r' })).toEqual({
      difficulty: 'hard',
      reasoning: 3,
      codegen: 0,
      debugging: 2,
      toolUse: 0,
      risk: 'high',
      needsReview: true,
      rationale: 'r',
    });
    expect(normalizeRoute({ difficulty: 'weird', reasoning: 0, codegen: 0, debugging: 0, toolUse: 0, risk: '?', needsReview: false, rationale: '' }).difficulty).toBe('medium');
  });

  it('accepts confidences given as percentages and unknown severities', () => {
    expect(normalizeGate({ issues: ['x', ''], confidence: 85, accept: true })).toEqual({ issues: ['x'], confidence: 0.85, accept: true });
    expect(normalizeCritique({ issues: [{ severity: 'High', issue: 'bug', suggestion: '' }], verdict: 'Revise' })).toEqual({
      issues: [{ severity: 'major', issue: 'bug', suggestion: '' }],
      verdict: 'revise',
    });
  });
});

describe('transcript', () => {
  it('fingerprints assistant turns by tool call ids, or by text without the Fusion footer', () => {
    const tools: ContentBlock[] = [{ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} } as ContentBlock];
    expect(assistantFingerprint(tools)).toBe('tu:toolu_1');
    const a = assistantFingerprint([{ type: 'text', text: 'Done.' }]);
    const b = assistantFingerprint([{ type: 'text', text: `Done.${footerLine('cascade · 3 calls · $0.01')}` }]);
    expect(a).toBe(b);
    expect(stripFooter(`Answer${footerLine('x')}`)).toBe('Answer');
  });

  it('appends notes after a user turn, or onto a trailing system message', () => {
    const afterUser = appendNote([user('hi')], 'NOTE')!;
    expect(afterUser.at(-1)).toEqual({ role: 'system', content: 'NOTE' });
    const env: Msg = { role: 'system', content: 'env' };
    const merged = appendNote([user('hi'), env], 'NOTE')!;
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual({ role: 'system', content: [{ type: 'text', text: 'env' }, { type: 'text', text: 'NOTE' }] });
    expect(appendNote(merged, 'NOTE')).toEqual(merged);
    expect(appendNote([{ role: 'assistant', content: 'x' }], 'NOTE')).toBeUndefined();
  });

  it('echoes only text from before a mid-output fallback', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'partial', citations: null },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      { type: 'thinking', thinking: '', signature: 't' },
      { type: 'text', text: 'rest', citations: null },
    ] as unknown as ContentBlock[];
    expect(toParams(content)).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'thinking', thinking: '', signature: 't' },
      { type: 'text', text: 'rest' },
    ]);
  });

  it('condenses long work logs, keeping the start and the end', () => {
    const messages: Msg[] = [user('Do the thing')];
    for (let i = 0; i < 200; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'run', input: { cmd: `step ${i} ${'x'.repeat(300)}` } }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `output ${i}` }] });
    }
    const work = condenseWork(messages, 8_000);
    expect(work.request).toBe('Do the thing');
    expect(work.steps).toBe(400);
    expect(work.log.length).toBeLessThanOrEqual(8_100);
    expect(work.log).toContain('step 0');
    expect(work.log).toContain('output 199');
    expect(work.log).toMatch(/steps omitted/);
  });
});
