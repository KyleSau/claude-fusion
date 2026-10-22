import type { Backend } from './backend';
import { bounded, isCancellation, TimeoutError } from './bounded';
import type { FusionConfig } from './config';
import type { Ledger } from './ledger';
import type { ModelInfo, ModelRegistry } from './models';
import { normalizeRoute, ROUTER_SYSTEM, RouteSchema, routerPrompt } from './prompts';
import { extractFeatures, heuristicRoute, obviouslyTrivial } from './signals';
import { condenseWork, truncateMiddle } from './transcript';
import type { Msg, RouteDecision, Tool } from './types';

export interface RouterDeps {
  registry: ModelRegistry;
  backendFor: (model: ModelInfo) => Backend | undefined;
  ledger: Ledger;
  warn: (message: string) => void;
}

/**
 * Classifies a new task. A cheap model reads the request and rates difficulty, capability signals
 * and risk; plainly trivial requests skip that call, and any failure falls back to heuristics.
 */
export class Router {
  constructor(private readonly deps: RouterDeps) {}

  async decide(
    taskId: string,
    messages: readonly Msg[],
    tools: readonly Tool[],
    cfg: FusionConfig,
    signal: AbortSignal,
    auxiliary = false,
  ): Promise<RouteDecision> {
    const features = extractFeatures(messages, tools);
    if (auxiliary) {
      return {
        difficulty: 'trivial',
        risk: 'low',
        signals: { reasoning: 0, codegen: 0, debugging: 0, toolUse: 0 },
        needsReview: false,
        source: 'forced',
        rationale: 'auxiliary request from the client (titles, summaries)',
      };
    }
    if (cfg.router.mode === 'heuristic' || obviouslyTrivial(features)) return heuristicRoute(features);

    const model = this.deps.registry.get(cfg.router.model);
    const backend = model && this.deps.backendFor(model);
    if (!model || !backend?.available(model)) {
      return { ...heuristicRoute(features), rationale: `router model ${cfg.router.model} unavailable; heuristics` };
    }

    const started = Date.now();
    try {
      const prompt = routerPrompt({
        request: truncateMiddle(features.request, 8_000),
        context: truncateMiddle(features.context, 3_000),
        earlier: condenseWork(messages, 2_000).earlier,
        tools: features.tools,
      });
      const { value: raw, metrics } = await bounded('router', signal, cfg.router.timeoutMs, (s) =>
        backend.json({ model, effort: cfg.router.effort, system: ROUTER_SYSTEM, prompt, schema: RouteSchema, maxTokens: 4_000, signal: s }),
      );
      const value = normalizeRoute(raw);
      this.deps.ledger.record({
        taskId,
        role: 'route',
        model: model.id,
        effort: cfg.router.effort,
        outcome: 'ok',
        ms: Date.now() - started,
        usage: metrics.usage,
        costUsd: metrics.costUsd,
        detail: `${value.difficulty}, risk ${value.risk}`,
      });
      return {
        difficulty: value.difficulty,
        risk: value.risk,
        signals: {
          reasoning: value.reasoning,
          codegen: value.codegen,
          debugging: value.debugging,
          toolUse: features.agentic ? value.toolUse : 0,
        },
        needsReview: value.needsReview,
        source: 'model',
        rationale: value.rationale,
      };
    } catch (err) {
      if (isCancellation(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.ledger.record({
        taskId,
        role: 'route',
        model: model.id,
        effort: cfg.router.effort,
        outcome: err instanceof TimeoutError ? 'timeout' : 'error',
        ms: Date.now() - started,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        detail: message,
      });
      this.deps.warn(`[${taskId}] router failed, using heuristics: ${message}`);
      return { ...heuristicRoute(features), rationale: `router failed (${message.slice(0, 80)}); heuristics` };
    }
  }
}
