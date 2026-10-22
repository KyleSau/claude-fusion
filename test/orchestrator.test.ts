import { describe, expect, it } from 'vitest';
import { blocksOf } from '../src/core/transcript';
import type { Msg } from '../src/core/types';
import {
  continueWith,
  FakeBackend,
  makeOrchestrator,
  RecordingSink,
  request,
  route,
  text,
  thinking,
  toolUse,
  TransientError,
  user,
} from './support/fakes';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

const systemTexts = (m: Msg | undefined) => (m?.role === 'system' ? blocksOf(m.content).map((b) => b.text as string) : []);

describe('single', () => {
  it('answers a trivial request with the fast model at low effort, skipping the router call', async () => {
    const backend = new FakeBackend({ solve: () => ({ content: [text('Hello!')] }) });
    const fusion = makeOrchestrator(backend);
    const sink = new RecordingSink();
    const outcome = await fusion.handleTurn(request([user('hi')], { tools: [] }), sink);

    expect(backend.jsonCalls).toHaveLength(0);
    expect(backend.solvedBy).toEqual([HAIKU]);
    expect(backend.solveCalls[0].effort).toBe('low');
    expect(sink.text()).toBe('Hello!');
    expect(outcome.final).toBe(true);
    expect(fusion.ledger.get(outcome.taskId)?.legs.map((l) => l.role)).toEqual(['solve']);
  });

  it('falls back to the next tier when the model is overloaded before anything was streamed', async () => {
    const backend = new FakeBackend({
      solve: (c) => (c.model.id === HAIKU ? new TransientError('overloaded') : { content: [text('Hi from Sonnet')] }),
    });
    const fusion = makeOrchestrator(backend);
    const sink = new RecordingSink();
    const outcome = await fusion.handleTurn(request([user('hi')], { tools: [] }), sink);

    expect(backend.solvedBy).toEqual([HAIKU, SONNET]);
    expect(sink.text()).toBe('Hi from Sonnet');
    const legs = fusion.ledger.get(outcome.taskId)!.legs;
    expect(legs.map((l) => [l.role, l.outcome])).toEqual([
      ['solve', 'error'],
      ['fallback', 'ok'],
    ]);
  });

  it('stops without emitting anything when the request is cancelled', async () => {
    const backend = new FakeBackend({ solve: () => ({ content: [text('never')] }) });
    const fusion = makeOrchestrator(backend);
    const controller = new AbortController();
    controller.abort();
    const sink = new RecordingSink();
    await expect(fusion.handleTurn(request([user('hi')], { tools: [], signal: controller.signal }), sink)).rejects.toMatchObject({
      name: 'CancelledError',
    });
    expect(sink.events).toHaveLength(0);
  });
});

describe('cascade', () => {
  const task = [user('Add a docstring to the parse function in src/app.ts')];

  it('streams tool steps live, holds the final answer for the gate, and delivers it once accepted', async () => {
    const backend = new FakeBackend({
      solve: (_call, n) => (n === 1 ? { content: [text('Reading the file.'), toolUse()] } : { content: [text('Added the docstring.')] }),
    });
    const fusion = makeOrchestrator(backend);

    const step1 = new RecordingSink();
    const first = await fusion.handleTurn(request(task), step1);
    expect(first.plan.pattern).toBe('cascade');
    expect(first.final).toBe(false);
    expect(step1.text()).toBe('Reading the file.');
    expect(step1.events.some((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use')).toBe(true);

    const step2 = new RecordingSink();
    const second = await fusion.handleTurn(request(continueWith(task, first)), step2);
    expect(second.final).toBe(true);
    expect(step2.text()).toBe('Added the docstring.');
    expect(backend.solvedBy).toEqual([HAIKU, HAIKU]);
    expect(backend.jsonCalls.map((c) => c.role)).toEqual(['route', 'gate']);
    // The gate sees the request, the work log and the draft, and has no tools.
    const gatePrompt = backend.jsonCalls[1].call.prompt;
    expect(gatePrompt).toContain('Add a docstring');
    expect(gatePrompt).toContain('call read_file');
    expect(gatePrompt).toContain('Added the docstring.');
    expect(backend.jsonCalls[1].call.model.id).toBe(SONNET);
    expect(fusion.ledger.get(second.taskId)?.resolution).toMatch(/accepted by the gate/);
  });

  it('hands a rejected draft to the stronger model with a note, and replays the note on later steps', async () => {
    const backend = new FakeBackend({
      solve: (_call, n) => {
        if (n === 1) return { content: [toolUse()] };
        if (n === 2) return { content: [text('Added the docstring. Tests pass.')] };
        if (n === 3) return { content: [thinking(), toolUse('edit_file')] };
        return { content: [text('Added the docstring and ran the tests.')] };
      },
      json: (_call, role) =>
        role === 'gate' ? { issues: ['Claims tests pass but no tests were run'], confidence: 0.3, accept: false } : undefined,
    });
    const fusion = makeOrchestrator(backend);

    const first = await fusion.handleTurn(request(task), new RecordingSink());
    const history2 = continueWith(task, first);
    const step2 = new RecordingSink();
    const second = await fusion.handleTurn(request(history2), step2);

    expect(backend.solvedBy).toEqual([HAIKU, HAIKU, SONNET]);
    expect(second.final).toBe(false);
    expect(step2.text()).not.toContain('Tests pass'); // the rejected draft never reaches the client
    const handoff = backend.solveCalls[2].messages;
    const note = systemTexts(handoff[handoff.length - 1]).join('\n');
    expect(note).toContain('taking over');
    expect(note).toContain('Claims tests pass but no tests were run');
    expect(note).toContain('Added the docstring. Tests pass.');

    const history3 = continueWith(history2, second);
    const third = await fusion.handleTurn(request(history3), new RecordingSink());
    expect(third.final).toBe(true);
    expect(backend.solvedBy).toEqual([HAIKU, HAIKU, SONNET, SONNET]);
    expect(backend.jsonCalls.map((c) => c.role)).toEqual(['route', 'gate']); // no second gate after escalation

    // The note sits exactly where the stronger model first saw it: right before its first turn.
    const replayed = backend.solveCalls[3].messages;
    const at = replayed.findIndex((m) => m.role === 'system');
    expect(replayed.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(systemTexts(replayed[at]).join('')).toBe(note);
    expect(replayed[at + 1].role).toBe('assistant');
    expect(blocksOf(replayed[at + 1].content).some((b) => b.type === 'tool_use' && b.name === 'edit_file')).toBe(true);
    expect(fusion.ledger.get(third.taskId)?.resolution).toMatch(/escalated to Sonnet 5.5/);
  });

  it('merges the hand-off note into a trailing system message (the shape Claude Code sends)', async () => {
    const backend = new FakeBackend({
      solve: (_call, n) => ({ content: [text(n === 1 ? 'Fixed.' : n === 2 ? 'Fixed properly.' : 'You are welcome.')] }),
      json: (_call, role) =>
        role === 'route' ? route('medium') : role === 'gate' ? { issues: ['No test was run'], confidence: 0.2, accept: false } : undefined,
    });
    const fusion = makeOrchestrator(backend);
    const env: Msg = { role: 'system', content: [{ type: 'text', text: '# Environment\ncwd: /repo' }] };
    const history: Msg[] = [user('Fix the failing test in parser.ts'), env];

    const first = await fusion.handleTurn(request(history), new RecordingSink());
    expect(backend.solvedBy).toEqual([SONNET, OPUS]);
    const sent = backend.solveCalls[1].messages;
    expect(sent).toHaveLength(2);
    expect(systemTexts(sent[1])[0]).toBe('# Environment\ncwd: /repo');
    expect(systemTexts(sent[1])[1]).toContain('taking over');

    // Next user turn: the client replays its own history, without the note.
    const next: Msg[] = [...history, { role: 'assistant', content: [{ type: 'text', text: 'Fixed properly.' }] }, user('thanks')];
    await fusion.handleTurn(request(next), new RecordingSink());
    const replayed = backend.solveCalls[2].messages;
    expect(systemTexts(replayed[1])).toEqual(systemTexts(sent[1]));
    expect(first.final).toBe(true);
  });

  it('escalates proactively when the drafter runs past its step budget', async () => {
    const backend = new FakeBackend({ solve: () => ({ content: [toolUse()] }) });
    const fusion = makeOrchestrator(backend, { cascade: { maxDraftSteps: 1 } });
    const first = await fusion.handleTurn(request(task), new RecordingSink());
    await fusion.handleTurn(request(continueWith(task, first)), new RecordingSink());
    expect(backend.solvedBy).toEqual([HAIKU, SONNET]);
    const handoff = backend.solveCalls[1].messages;
    expect(systemTexts(handoff[handoff.length - 1]).join('')).toContain('tool-calling steps without finishing');
  });

  it('passes client errors through instead of escalating', async () => {
    const backend = new FakeBackend({ solve: () => new Error('400 invalid_request_error: bad image') });
    const fusion = makeOrchestrator(backend);
    await expect(fusion.handleTurn(request(task), new RecordingSink())).rejects.toThrow('bad image');
    expect(backend.solvedBy).toEqual([HAIKU]);
  });

  it('skips the gate once the task budget is spent', async () => {
    const backend = new FakeBackend({ solve: () => ({ content: [text('Done.')] }) });
    const fusion = makeOrchestrator(backend, { budget: { maxTaskUsd: 0.005 } });
    const outcome = await fusion.handleTurn(request(task), new RecordingSink());
    expect(backend.jsonCalls.map((c) => c.role)).toEqual(['route']);
    expect(fusion.ledger.get(outcome.taskId)?.resolution).toMatch(/budget/);
  });
});

describe('critique', () => {
  const question = [user('Explain why this lock-free queue can lose updates under contention:\n```c\n/* ... */\n```')];
  const hard = (extra: (role: string) => unknown) => (_call: unknown, role: string) => (role === 'route' ? route('hard') : extra(role));

  it('revises once when the independent reviewer finds a substantive issue', async () => {
    const backend = new FakeBackend({
      solve: (_call, n) => ({ content: [text(n === 1 ? 'Draft explanation.' : 'Revised explanation covering ABA.')] }),
      json: hard((role) =>
        role === 'critique'
          ? { issues: [{ severity: 'major', issue: 'Misses the ABA problem', suggestion: 'Explain ABA' }], verdict: 'revise' }
          : undefined,
      ),
    });
    const fusion = makeOrchestrator(backend);
    const sink = new RecordingSink();
    const outcome = await fusion.handleTurn(request(question, { tools: [] }), sink);

    expect(outcome.plan.pattern).toBe('critique');
    expect(backend.solvedBy).toEqual([OPUS, OPUS]);
    expect(backend.solveCalls[0].effort).toBe('high');
    expect(backend.jsonCalls.map((c) => [c.role, c.call.model.id])).toEqual([
      ['route', HAIKU],
      ['critique', SONNET],
    ]);
    const note = systemTexts(backend.solveCalls[1].messages.at(-1)).join('');
    expect(note).toContain('Misses the ABA problem');
    expect(note).toContain('Draft explanation.');
    expect(sink.text()).toBe('Revised explanation covering ABA.');
    expect(outcome.final).toBe(true);
  });

  it('delivers the draft when the reviewer only has minor remarks', async () => {
    const backend = new FakeBackend({
      solve: () => ({ content: [text('Draft explanation.')] }),
      json: hard((role) =>
        role === 'critique' ? { issues: [{ severity: 'minor', issue: 'Could be shorter', suggestion: '' }], verdict: 'revise' } : undefined,
      ),
    });
    const fusion = makeOrchestrator(backend);
    const sink = new RecordingSink();
    const outcome = await fusion.handleTurn(request(question, { tools: [] }), sink);
    expect(backend.solvedBy).toEqual([OPUS]);
    expect(sink.text()).toBe('Draft explanation.');
    expect(fusion.ledger.get(outcome.taskId)?.resolution).toBe('approved by the critic');
  });

  it('still answers when the critic fails', async () => {
    const backend = new FakeBackend({
      solve: () => ({ content: [text('Draft explanation.')] }),
      json: hard((role) => (role === 'critique' ? new Error('critic down') : undefined)),
    });
    const fusion = makeOrchestrator(backend);
    const sink = new RecordingSink();
    await fusion.handleTurn(request(question, { tools: [] }), sink);
    expect(sink.text()).toBe('Draft explanation.');
  });
});

describe('client history', () => {
  it('puts back thinking blocks a client could not store (VS Code)', async () => {
    const backend = new FakeBackend({
      solve: (_call, n) => (n === 1 ? { content: [thinking('', 'sig-keep-me'), toolUse()] } : { content: [text('done')] }),
    });
    const fusion = makeOrchestrator(backend);
    const first = await fusion.handleTurn(request([user('hi')], { restoreAssistantBlocks: true }), new RecordingSink());
    const call = first.message.content.find((b) => b.type === 'tool_use') as { id: string };
    // VS Code keeps only text and tool calls.
    const history: Msg[] = [
      user('hi'),
      { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: 'read_file', input: { path: 'src/app.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
    ];
    await fusion.handleTurn(request(history, { restoreAssistantBlocks: true }), new RecordingSink());
    const replayed = backend.solveCalls[1].messages[1];
    expect(blocksOf(replayed.content).map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(blocksOf(replayed.content)[0].signature).toBe('sig-keep-me');
  });

  it('routes a new task without running it in preview mode', async () => {
    const backend = new FakeBackend({ solve: () => ({ content: [text('x')] }), json: (_c, role) => (role === 'route' ? route('medium') : undefined) });
    const fusion = makeOrchestrator(backend);
    const { plan } = await fusion.preview({
      messages: [user('Refactor the payment module to use the new client')],
      tools: [],
      objective: 'balanced',
      signal: new AbortController().signal,
    });
    expect(plan.pattern).toBe('cascade');
    expect(plan.reason).toContain('Sonnet 5.5 (medium) drafts');
    expect(backend.solveCalls).toHaveLength(0);
  });
});
