import { describe, expect, it } from 'vitest';
import { AnthropicBackend, callMetrics, prepareMessages } from '../src/backends/anthropic';
import type { SolveCall } from '../src/core/backend';
import { ModelRegistry } from '../src/core/models';
import type { Msg } from '../src/core/types';
import { TOOLS, user } from './support/fakes';

const registry = new ModelRegistry();
const backend = new AnthropicBackend({ credentials: () => ({ apiKey: 'sk-ant-api03-test' }) }, registry);

function call(over: Partial<SolveCall> = {}): SolveCall {
  return {
    model: registry.require('claude-opus-5-5'),
    effort: 'high',
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    messages: [user('hi')],
    tools: TOOLS,
    maxTokens: 64_000,
    refusalFallback: true,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('solver request', () => {
  it('uses adaptive thinking, the planned effort, and degrades instead of failing on edited history', () => {
    const p = backend.solveParams(call());
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p.betas).toContain('thinking-binding-controls-2026-08-01');
    expect(p.max_tokens).toBe(64_000);
  });

  it("keeps the client's thinking display and block binding", () => {
    const p = backend.solveParams(call({ thinkingDisplay: 'updates', blockBinding: { prefix_mismatch_behavior: 'error' } }));
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'error' } });
    expect(p.betas).toContain('thinking-display-updates-2026-08-18');
  });

  it('forwards client parameters except the ones the target models reject', () => {
    const p = backend.solveParams(
      call({
        passthrough: {
          temperature: 0.2,
          top_p: 0.9,
          speed: 'fast',
          metadata: { user_id: 'u1' },
          context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
          output_config: { effort: 'max', format: { type: 'json_schema', schema: { type: 'object' } } },
        },
      }),
    ) as unknown as Record<string, unknown>;
    expect(p.temperature).toBeUndefined();
    expect(p.top_p).toBeUndefined();
    expect(p.speed).toBeUndefined();
    expect(p.metadata).toEqual({ user_id: 'u1' });
    expect(p.context_management).toBeDefined();
    expect(p.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } });
  });

  it('adds cache breakpoints only when the client set none', () => {
    const fresh = backend.solveParams(call());
    expect(fresh.cache_control).toEqual({ type: 'ephemeral' });
    expect((fresh.system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: 'ephemeral' });

    const marked = backend.solveParams(
      call({ system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }] }),
    );
    expect(marked.cache_control).toBeUndefined();
    expect(marked.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  });

  it('turns forced tool use into auto, which the 5.5 models require', () => {
    expect(backend.solveParams(call({ toolChoice: { type: 'any', disable_parallel_tool_use: true } })).tool_choice).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    expect(backend.solveParams(call({ toolChoice: { type: 'auto' } })).tool_choice).toEqual({ type: 'auto' });
  });

  it("drops the client's OAuth betas but keeps feature betas", () => {
    const p = backend.solveParams(call({ betas: ['oauth-2025-04-20', 'context-management-2025-06-27'] }));
    expect(p.betas).not.toContain('oauth-2025-04-20');
    expect(p.betas).toContain('context-management-2025-06-27');
  });

  it('opts into server-side refusal fallback only where the model and request allow it', () => {
    const opus = backend.solveParams(call());
    expect(opus.fallbacks).toBe('default');
    expect(opus.betas).toContain('server-side-fallback-2026-07-01');

    const haiku = backend.solveParams(call({ model: registry.require('claude-haiku-5-5') }));
    expect(haiku.fallbacks).toBeUndefined();

    const sonnetWithSystem = backend.solveParams(
      call({ model: registry.require('claude-sonnet-5-5'), messages: [user('hi'), { role: 'system', content: 'note' }] }),
    );
    expect(sonnetWithSystem.fallbacks).toBeUndefined();

    expect(backend.solveParams(call({ refusalFallback: false })).fallbacks).toBeUndefined();
  });
});

describe('message preparation', () => {
  const opus = registry.require('claude-opus-5-5');

  it('passes valid messages through untouched', () => {
    const messages: Msg[] = [user('hi'), { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, user('more')];
    const out = prepareMessages(messages, opus);
    out.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('moves tool results first and drops empty text blocks', () => {
    const out = prepareMessages(
      [
        user('go'),
        { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
      opus,
    );
    expect(out[1].content).toEqual([{ type: 'tool_use', id: 't1', name: 'x', input: {} }]);
    expect((out[2].content as { type: string }[]).map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it("removes a client's per-message effort settings (Fusion picks effort)", () => {
    const out = prepareMessages(
      [
        user('go'),
        { role: 'system', content: [], output_config: { effort: 'max' } },
        { role: 'system', content: 'keep me', output_config: { effort: 'low' } },
      ] as Msg[],
      opus,
    );
    expect(out).toEqual([user('go'), { role: 'system', content: 'keep me' }]);
  });

  it('folds system messages into the user turn for models without mid-conversation system messages', () => {
    const out = prepareMessages([user('go'), { role: 'system', content: 'note' }], registry.require('claude-sonnet-5'));
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out[0].content)).toContain('<system-reminder>\\nnote');
  });
});

describe('cost accounting', () => {
  it('bills every attempt of a server-side fallback at its own rates', () => {
    const m = callMetrics(registry, registry.require('claude-opus-5-5'), {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    });
    expect(m.costUsd).toBeCloseTo(4 + 5);
    expect(m.servedBy).toBe('claude-opus-4-8');
    expect(m.usage.input).toBe(2_000_000);
  });

  it('splits cache writes by TTL', () => {
    const m = callMetrics(registry, registry.require('claude-sonnet-5-5'), {
      model: 'claude-sonnet-5-5',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      },
    });
    expect(m.costUsd).toBeCloseTo(2.5 + 4);
  });
});
