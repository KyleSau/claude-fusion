import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicCredentials } from '../backends/anthropic';
import { CancelledError, isCancellation, TimeoutError } from '../core/bounded';
import type { Orchestrator, Logger } from '../core/orchestrator';
import { errorMessage } from '../core/orchestrator';
import type { Objective, StreamEvent, TextBlockParam, TurnRequest, TurnSink } from '../core/types';

export const DEFAULT_PORT = 4545;
export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Request-scoped credentials from the inbound request, readable by the Anthropic backend. */
export const inboundCredentials = new AsyncLocalStorage<AnthropicCredentials>();

export interface GatewayOptions {
  orchestrator: Orchestrator;
  port?: number;
  host?: string;
  /** Where Fusion's own calls and pass-through requests go. Always explicit, never read from env. */
  upstreamURL?: string;
  /** Credentials for pass-through requests that arrive without any. */
  defaultCredentials: () => AnthropicCredentials | undefined;
  /** When set, clients must present this value as `x-api-key` or a bearer token. */
  token?: string;
  /** Objective for the plain `fusion` model id. */
  defaultObjective: () => Objective;
  /** Model whose tokenizer answers `count_tokens` for `fusion*` requests. */
  countTokensModel: () => string;
  /** Opt Fusion's own solver calls into server-side refusal fallback (clients can also send `fallbacks`). */
  refusalFallback?: boolean;
  log: Logger;
}

const FUSION_MODEL = /^fusion(?:-(fast|balanced|quality))?(?:\[[^\]]*\])?$/i;

export function fusionObjective(model: unknown, fallback: Objective): Objective | undefined {
  if (typeof model !== 'string') return undefined;
  const m = FUSION_MODEL.exec(model.trim());
  if (!m) return undefined;
  return (m[1]?.toLowerCase() as Objective | undefined) ?? fallback;
}

export const FUSION_MODELS = [
  { id: 'fusion', display_name: 'Fusion (multi model)', description: 'Routes each task across Haiku, Sonnet and Opus: single call, cascade, or draft-critique-revise.' },
  { id: 'fusion-fast', display_name: 'Fusion Fast (multi model)', description: 'Fusion biased toward speed and cost.' },
  { id: 'fusion-quality', display_name: 'Fusion Quality (multi model)', description: 'Fusion biased toward quality: more review, stronger drafters.' },
];

/**
 * An Anthropic-compatible endpoint. Requests for `fusion*` models run through the orchestrator;
 * every other model is proxied byte-for-byte, so a client such as Claude Code can keep using its
 * normal models through the same base URL.
 */
export class Gateway {
  private server?: http.Server;
  private readonly upstream: string;
  private readonly clients = new Map<string, Anthropic>();

  constructor(private readonly opts: GatewayOptions) {
    this.upstream = (opts.upstreamURL ?? DEFAULT_UPSTREAM).replace(/\/+$/, '');
  }

  get address(): string | undefined {
    const a = this.server?.address();
    return a && typeof a === 'object' ? `http://${a.address}:${a.port}` : undefined;
  }

  async start(): Promise<string> {
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? DEFAULT_PORT;
    const self = new URL(this.upstream);
    if (['127.0.0.1', 'localhost', host].includes(self.hostname) && Number(self.port) === port) {
      throw new Error(`Fusion gateway upstream (${this.upstream}) points at the gateway itself`);
    }
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.opts.log.error(`gateway: ${errorMessage(err)}`);
        if (!res.headersSent) sendError(res, 500, 'api_error', errorMessage(err));
        else res.end();
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return this.address!;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/api/hello' || path === '' || path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, service: 'fusion' }));
      return;
    }
    if (!this.authorized(req)) {
      sendError(res, 401, 'authentication_error', 'Fusion gateway: missing or invalid gateway token');
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') return this.listModels(req, res);
    if (req.method === 'GET' && path === '/fusion/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ session: this.opts.orchestrator.ledger.session, tasks: this.opts.orchestrator.ledger.recent(20) }, null, 2));
      return;
    }
    if (req.method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/count_tokens')) {
      const body = await readJson(req);
      if (!body) {
        sendError(res, 400, 'invalid_request_error', 'Request body must be a JSON object');
        return;
      }
      const objective = fusionObjective(body.model, this.opts.defaultObjective());
      if (path === '/v1/messages/count_tokens') {
        if (objective) body.model = this.opts.countTokensModel();
        return this.proxy(req, res, path + url.search, body);
      }
      if (!objective) return this.proxy(req, res, path + url.search, body);
      return this.fusion(req, res, body, objective);
    }
    sendError(res, 404, 'not_found_error', `Fusion gateway: no route for ${req.method} ${path}`);
  }

  // ---- fusion -------------------------------------------------------------------------------------

  private async fusion(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, any>, objective: Objective): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const streaming = body.stream === true;
    let headerSent = false;
    const head = () => {
      if (headerSent) return;
      headerSent = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    };
    const sink: TurnSink = streaming
      ? {
          event: (e: StreamEvent) => {
            head();
            res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          },
          heartbeat: () => {
            head();
            res.write('event: ping\ndata: {"type": "ping"}\n\n');
          },
        }
      : { event: () => {} };

    const system: TextBlockParam[] = typeof body.system === 'string' ? (body.system ? [{ type: 'text', text: body.system }] : []) : (body.system ?? []);
    const passthrough = { ...body };
    for (const k of ['model', 'messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'thinking', 'stream']) delete passthrough[k];
    const turn: TurnRequest = {
      system,
      messages: Array.isArray(body.messages) ? body.messages : [],
      tools: Array.isArray(body.tools) ? body.tools : [],
      toolChoice: body.tool_choice,
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      thinkingDisplay: body.thinking?.display ?? undefined,
      blockBinding: body.thinking?.block_binding ?? undefined,
      betas: splitHeader(req.headers['anthropic-beta']),
      passthrough,
      objective,
      restoreAssistantBlocks: false,
      auxiliary: header(req, 'x-claude-code-request-class') === 'auxiliary',
      refusalFallback: this.opts.refusalFallback ?? false,
      signal: controller.signal,
    };

    const started = Date.now();
    try {
      const outcome = await inboundCredentials.run(this.orchestrationCredentials(req), () =>
        this.opts.orchestrator.handleTurn(turn, sink),
      );
      if (streaming) {
        head();
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'x-fusion-task': outcome.taskId });
        res.end(JSON.stringify(outcome.message));
      }
      this.opts.log.info(`POST /v1/messages ${body.model} → ${outcome.message.model} ${outcome.message.stop_reason} (${Date.now() - started}ms)`);
    } catch (err) {
      if (isCancellation(err) || controller.signal.aborted) return;
      const { status, payload } = errorPayload(err);
      this.opts.log.warn(`POST /v1/messages ${body.model} failed: ${status} ${errorMessage(err)}`);
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
      } else {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    }
  }

  /**
   * Fusion's own calls use the configured key. Without one, an inbound API key is accepted, but an
   * inbound OAuth token (a claude.ai login) is never used for orchestration.
   */
  private orchestrationCredentials(req: http.IncomingMessage): AnthropicCredentials {
    const configured = this.opts.defaultCredentials();
    if (configured?.apiKey || configured?.authToken) return configured;
    const inbound = this.inbound(req);
    const apiKey = [inbound.apiKey, inbound.authToken].find((v) => v?.startsWith('sk-ant-api'));
    return apiKey ? { apiKey } : {};
  }

  // ---- pass-through -------------------------------------------------------------------------------

  private async proxy(req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const creds = this.inbound(req);
    const client = this.clientFor(creds.apiKey || creds.authToken ? creds : (this.opts.defaultCredentials() ?? {}));
    const headers: Record<string, string> = {};
    const beta = header(req, 'anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;
    const version = header(req, 'anthropic-version');
    if (version) headers['anthropic-version'] = version;
    try {
      const upstream = await client
        .post(path.startsWith('/') ? path : `/${path}`, { body, headers, signal: controller.signal, stream: body.stream === true, maxRetries: 0 })
        .asResponse();
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key)) out[key] = value;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body) {
        Readable.fromWeb(upstream.body as any).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const { status, payload } = errorPayload(err);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      } else {
        res.end();
      }
    }
  }

  private async listModels(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const now = new Date().toISOString();
    const ours = FUSION_MODELS.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, description: m.description, created_at: now }));
    let theirs: unknown[] = [];
    try {
      const creds = this.inbound(req);
      const client = this.clientFor(creds.apiKey || creds.authToken ? creds : (this.opts.defaultCredentials() ?? {}));
      const page = await client.models.list({ limit: 100 });
      theirs = page.data;
    } catch {
      // Listing upstream models is best effort.
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [...ours, ...theirs], has_more: false, first_id: ours[0].id, last_id: null }));
  }

  private inbound(req: http.IncomingMessage): AnthropicCredentials {
    const apiKey = header(req, 'x-api-key');
    const auth = header(req, 'authorization');
    const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
    const isGatewayToken = (v?: string) => !!this.opts.token && v === this.opts.token;
    return {
      apiKey: apiKey && !isGatewayToken(apiKey) ? apiKey : undefined,
      authToken: bearer && !isGatewayToken(bearer) ? bearer : undefined,
    };
  }

  private authorized(req: http.IncomingMessage): boolean {
    if (!this.opts.token) return true;
    const auth = header(req, 'authorization');
    return header(req, 'x-api-key') === this.opts.token || auth === `Bearer ${this.opts.token}` || header(req, 'x-fusion-token') === this.opts.token;
  }

  private clientFor(creds: AnthropicCredentials): Anthropic {
    const key = `${creds.apiKey ?? ''}\u0000${creds.authToken ?? ''}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new Anthropic({
        apiKey: creds.apiKey ?? null,
        authToken: creds.authToken ?? null,
        baseURL: this.upstream,
        maxRetries: 0,
      });
      if (this.clients.size >= 16) this.clients.delete(this.clients.keys().next().value!);
      this.clients.set(key, client);
    }
    return client;
  }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
}

function splitHeader(v: string | string[] | undefined): string[] {
  const s = Array.isArray(v) ? v.join(',') : (v ?? '');
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/** Upstream errors are forwarded unmodified: clients match on their wording to decide on retries. */
export function errorPayload(err: unknown): { status: number; payload: unknown } {
  if (err instanceof Anthropic.APIError && err.error && typeof err.error === 'object') {
    const status = err.status ?? (err.type === 'overloaded_error' ? 529 : 500);
    return { status, payload: err.error };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 502, payload: { type: 'error', error: { type: 'api_error', message: `Fusion could not reach the upstream API: ${err.message}` } } };
  }
  if (err instanceof TimeoutError) return { status: 504, payload: { type: 'error', error: { type: 'api_error', message: err.message } } };
  if (err instanceof CancelledError) return { status: 499, payload: { type: 'error', error: { type: 'api_error', message: err.message } } };
  return { status: 500, payload: { type: 'error', error: { type: 'api_error', message: `Fusion: ${errorMessage(err)}` } } };
}
