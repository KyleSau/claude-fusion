// A scripted stand-in for the Anthropic Messages API, used by the gateway tests and for capturing
// the request shapes real clients send. Auth headers are never stored.
import http from 'node:http';

let counter = 0;

/** Plain-text JSON answers for Fusion's own tool-less legs, keyed off their system prompts. */
export function defaultResponder(body) {
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((b) => b.text).join('\n');
  if (system.includes('routing classifier')) {
    return { content: [{ type: 'text', text: JSON.stringify({ difficulty: 'easy', reasoning: 0, codegen: 1, debugging: 0, toolUse: 1, risk: 'low', needsReview: false, rationale: 'mock route' }) }] };
  }
  if (system.includes('quality gate')) {
    return { content: [{ type: 'text', text: JSON.stringify({ issues: [], confidence: 0.9, accept: true }) }] };
  }
  if (system.includes('independent reviewer')) {
    return { content: [{ type: 'text', text: JSON.stringify({ issues: [], verdict: 'approve' }) }] };
  }
  return { content: [{ type: 'text', text: `mock reply from ${body.model}` }] };
}

function message(body, reply) {
  const content = reply.content;
  return {
    id: `msg_mock_${++counter}`,
    type: 'message',
    role: 'assistant',
    model: reply.model ?? body.model,
    content,
    stop_reason: reply.stop_reason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: reply.usage?.input_tokens ?? 100,
      output_tokens: reply.usage?.output_tokens ?? 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: reply.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function stream(res, msg, delayMs) {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_${msg.id}` });
  sse(res, 'message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 1 } } });
  sse(res, 'ping', { type: 'ping' });
  for (const [index, block] of msg.content.entries()) {
    await wait();
    if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of block.text.match(/.{1,12}/gs) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (block.type === 'thinking') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (block.thinking) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'tool_use') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * @param {{ port?: number, respond?: (body: any, headers: http.IncomingHttpHeaders) => any, delayMs?: number, onRequest?: (record: any) => void }} [opts]
 */
export async function startMockUpstream(opts = {}) {
  const requests = [];
  const respond = opts.respond ?? defaultResponder;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const headers = { ...req.headers };
    const auth = headers.authorization;
    delete headers.authorization;
    delete headers['x-api-key'];
    const record = {
      method: req.method,
      url: req.url,
      headers,
      auth: auth ? (String(auth).includes('sk-ant-oat') ? 'bearer(oauth)' : 'bearer') : req.headers['x-api-key'] ? 'x-api-key' : 'none',
      body,
    };
    requests.push(record);
    opts.onRequest?.(record);

    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }));
      return;
    }
    if (path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 4321 }));
      return;
    }
    if (path !== '/v1/messages') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: unknown path' } }));
      return;
    }
    const reply = await respond(body, req.headers);
    if (reply.error) {
      res.writeHead(reply.error.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: reply.error.type, message: reply.error.message } }));
      return;
    }
    const msg = message(body, reply);
    if (body.stream) await stream(res, msg, opts.delayMs ?? 1);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(msg));
    }
  });
  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Standalone: `node test/support/mock-upstream.mjs <port> <capture-dir>` records every request body.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [port, dir] = process.argv.slice(2);
  const fs = await import('node:fs');
  const path = await import('node:path');
  if (dir) fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const mock = await startMockUpstream({
    port: Number(port) || 4646,
    onRequest: (r) => {
      if (dir) fs.writeFileSync(path.join(dir, `req-${String(++n).padStart(3, '0')}.json`), JSON.stringify(r, null, 2));
      console.log(`${r.method} ${r.url} model=${r.body.model ?? '-'} auth=${r.auth}`);
    },
  });
  console.log(`mock upstream on ${mock.url}`);
}
