import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/core/config';
import type { Logger } from '../src/core/orchestrator';
import { Gateway } from '../src/gateway/server';
import { createRuntime } from '../src/runtime';
// @ts-expect-error -- plain JS test helper
import { defaultResponder, startMockUpstream } from './support/mock-upstream.mjs';
import { TOOLS } from './support/fakes';

const silent: Logger = { info() {}, warn() {}, error() {} };
const KEY = 'sk-ant-api03-fusion-test';

type Responder = (body: any) => any;
let respond: Responder = defaultResponder;
let mock: { url: string; requests: any[]; close(): Promise<void> };
let gateway: Gateway;
let client: Anthropic;

async function startGateway(token?: string) {
  const { orchestrator } = createRuntime({
    config: () => resolveConfig({ router: { mode: 'model' } }),
    credentials: () => ({ apiKey: KEY }),
    upstreamURL: mock.url,
    maxRetries: 0,
    log: silent,
  });
  const g = new Gateway({
    orchestrator,
    port: 0,
    upstreamURL: mock.url,
    defaultCredentials: () => ({ apiKey: KEY }),
    defaultObjective: () => 'balanced',
    countTokensModel: () => 'claude-sonnet-5-5',
    token,
    log: silent,
  });
  const url = await g.start();
  return { g, url };
}

beforeAll(async () => {
  mock = await startMockUpstream({ respond: (body: any) => respond(body) });
  const started = await startGateway();
  gateway = started.g;
  client = new Anthropic({ apiKey: 'sk-ant-api03-client', baseURL: started.url, maxRetries: 0 });
});

afterAll(async () => {
  await gateway?.stop();
  await mock?.close();
});

beforeEach(() => {
  respond = defaultResponder;
  mock.requests.length = 0;
});

const solverCalls = () => mock.requests.filter((r) => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens') && !String(r.body.system ?? '').includes('Fusion'));

describe('fusion models', () => {
  it('streams a routed answer and calls upstream with Fusion\'s key and request shape', async () => {
    const message = await client.messages.stream({ model: 'fusion', max_tokens: 2_000, messages: [{ role: 'user', content: 'hi' }] }).finalMessage();
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'mock reply from claude-haiku-5-5' });
    const [upstream] = solverCalls();
    expect(upstream.auth).toBe('bearer');
    expect(upstream.body.model).toBe('claude-haiku-5-5');
    expect(upstream.body.output_config).toEqual({ effort: 'low' });
    expect(upstream.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(upstream.body.max_tokens).toBe(2_000);
  });

  it('answers non-streaming requests and honours the objective in the model id', async () => {
    const message = await client.messages.create({ model: 'fusion-quality', max_tokens: 2_000, messages: [{ role: 'user', content: 'hi' }] });
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'mock reply from claude-sonnet-5-5' });
  });

  it('holds a rejected draft and streams the stronger model instead', async () => {
    respond = (body) => {
      const system = JSON.stringify(body.system ?? '');
      if (system.includes('quality gate')) return { content: [{ type: 'text', text: JSON.stringify({ issues: ['Never ran the tests'], confidence: 0.2, accept: false }) }] };
      if (body.model === 'claude-haiku-5-5' && !system.includes('routing classifier')) return { content: [{ type: 'text', text: 'Draft from Haiku' }] };
      return defaultResponder(body);
    };
    const message = await client.messages
      .stream({ model: 'fusion', max_tokens: 4_000, tools: TOOLS as Anthropic.Tool[], messages: [{ role: 'user', content: 'Add input validation to the signup handler' }] })
      .finalMessage();
    expect(message.content[0]).toMatchObject({ text: 'mock reply from claude-sonnet-5-5' });
    const escalated = mock.requests.at(-1)!.body;
    expect(escalated.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(escalated.messages.at(-1))).toContain('Never ran the tests');
  });

  it('falls back to the next tier when the routed model is overloaded', async () => {
    respond = (body) =>
      body.model === 'claude-haiku-5-5' ? { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } } : defaultResponder(body);
    const message = await client.messages.create({ model: 'fusion', max_tokens: 2_000, messages: [{ role: 'user', content: 'hi' }] });
    expect(message.content[0]).toMatchObject({ text: 'mock reply from claude-sonnet-5-5' });
  });

  it('passes upstream client errors back unchanged, before any stream starts', async () => {
    respond = () => ({ error: { status: 400, type: 'invalid_request_error', message: 'messages.1: bound to a different conversation' } });
    const err = await client.messages.stream({ model: 'fusion', max_tokens: 2_000, messages: [{ role: 'user', content: 'hi' }] }).finalMessage().catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err.message).toContain('bound to a different conversation');
  });

  it('routes background requests straight to the fast tier', async () => {
    await client.messages.create(
      { model: 'fusion', max_tokens: 500, messages: [{ role: 'user', content: 'Write a five word title for this conversation about refactoring the auth module' }] },
      { headers: { 'x-claude-code-request-class': 'auxiliary' } },
    );
    expect(mock.requests.map((r) => r.body.model)).toEqual(['claude-haiku-5-5']);
  });

  it('answers count_tokens for fusion with the balanced model', async () => {
    const count = await client.messages.countTokens({ model: 'fusion', messages: [{ role: 'user', content: 'hi' }] });
    expect(count.input_tokens).toBe(4321);
    expect(mock.requests[0].body.model).toBe('claude-sonnet-5-5');
  });
});

describe('pass-through', () => {
  it('proxies other models byte-for-byte with the caller\'s own credentials', async () => {
    const body = {
      model: 'claude-opus-5-5',
      max_tokens: 1_000,
      system: [{ type: 'text' as const, text: 'sys', cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: 'hello' }],
      thinking: { type: 'adaptive' as const },
    };
    const message = await client.beta.messages.create(body);
    expect(message.content[0]).toMatchObject({ text: 'mock reply from claude-opus-5-5' });
    const [upstream] = mock.requests;
    expect(upstream.url).toBe('/v1/messages?beta=true');
    expect(upstream.body).toEqual(body);
    expect(upstream.auth).toBe('bearer');
  });

  it('forwards upstream errors unchanged', async () => {
    respond = () => ({ error: { status: 404, type: 'not_found_error', message: 'model: claude-nope' } });
    const err = await client.messages.create({ model: 'claude-nope', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.NotFoundError);
    expect(err.message).toContain('model: claude-nope');
  });

  it('lists the fusion models alongside upstream models', async () => {
    const page = await client.models.list();
    const ids = page.data.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['fusion', 'fusion-fast', 'fusion-quality', 'claude-opus-5-5']));
  });
});

describe('gateway token', () => {
  it('rejects clients without the token when one is configured', async () => {
    const { g, url } = await startGateway('local-secret');
    try {
      const anonymous = new Anthropic({ apiKey: 'wrong', baseURL: url, maxRetries: 0 });
      await expect(anonymous.messages.create({ model: 'fusion', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(
        Anthropic.AuthenticationError,
      );
      const allowed = new Anthropic({ apiKey: 'local-secret', baseURL: url, maxRetries: 0 });
      const message = await allowed.messages.create({ model: 'fusion', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(message.content[0]).toMatchObject({ type: 'text' });
    } finally {
      await g.stop();
    }
  });
});
