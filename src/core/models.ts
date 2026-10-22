import type { Effort, Tier } from './types';

/** USD per million tokens. */
export interface RateCard {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Pricing extends RateCard {
  /** Some models switch to a second rate card once the prompt exceeds `threshold` tokens. */
  longContext?: RateCard & { threshold: number };
}

export interface ModelInfo {
  /** Anthropic model id, or `vscode:<vendor>/<id>` for a model provided by another VS Code extension. */
  id: string;
  label: string;
  short: string;
  provider: 'anthropic' | 'vscode';
  /** Model family, used to pick a critic from a *different* family when one is available. */
  family: string;
  tier?: Tier;
  contextWindow: number;
  maxOutput: number;
  efforts: readonly Effort[];
  /** Accepts mid-conversation `role: "system"` messages (how Fusion injects review notes append-only). */
  systemMessages: boolean;
  /** Accepts `thinking.display: "updates"` (progress notes between tool calls). */
  progressUpdates: boolean;
  /** Accepts the server-side `fallbacks: "default"` refusal fallback. */
  serverFallback: boolean;
  pricing?: Pricing;
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function card(input: number, output: number, cacheReadMultiplier: number): RateCard {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * cacheReadMultiplier,
  };
}

/**
 * Anthropic models Fusion knows how to drive. Prices are first-party Claude API list prices
 * (USD / MTok, cached 2026-10-06) and are only used for Fusion's own cost estimates.
 */
export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    short: 'Fable 5.1',
    provider: 'anthropic',
    family: 'claude',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: true,
    progressUpdates: true,
    serverFallback: true,
    pricing: card(10, 50, 0.025),
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    short: 'Opus 5.5',
    provider: 'anthropic',
    family: 'claude',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: true,
    progressUpdates: true,
    serverFallback: true,
    pricing: card(4, 20, 0.05),
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    short: 'Sonnet 5.5',
    provider: 'anthropic',
    family: 'claude',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: true,
    progressUpdates: true,
    serverFallback: true,
    pricing: card(2, 10, 0.1),
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    short: 'Haiku 5.5',
    provider: 'anthropic',
    family: 'claude',
    tier: 'fast',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: true,
    progressUpdates: false,
    serverFallback: false,
    pricing: { ...card(0.1, 0.5, 0.1), longContext: { threshold: 100_000, ...card(0.5, 2.5, 0.1) } },
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    short: 'Opus 5',
    provider: 'anthropic',
    family: 'claude',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: true,
    progressUpdates: false,
    serverFallback: true,
    pricing: card(5, 25, 0.1),
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    short: 'Opus 4.8',
    provider: 'anthropic',
    family: 'claude',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: true,
    progressUpdates: false,
    serverFallback: false,
    pricing: card(5, 25, 0.1),
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    short: 'Sonnet 5',
    provider: 'anthropic',
    family: 'claude',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    efforts: ALL_EFFORTS,
    systemMessages: false,
    progressUpdates: false,
    serverFallback: false,
    pricing: card(2, 10, 0.1),
  },
];

export const DEFAULT_POOL: Record<Tier, string> = {
  fast: 'claude-haiku-5-5',
  balanced: 'claude-sonnet-5-5',
  frontier: 'claude-opus-5-5',
};

/** Holds the Anthropic catalog plus any VS Code-provided models discovered at runtime. */
export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>();

  constructor(models: readonly ModelInfo[] = ANTHROPIC_MODELS) {
    for (const m of models) this.models.set(m.id, m);
  }

  add(model: ModelInfo): void {
    this.models.set(model.id, model);
  }

  removeProvider(provider: ModelInfo['provider']): void {
    for (const [id, m] of this.models) if (m.provider === provider) this.models.delete(id);
  }

  get(id: string): ModelInfo | undefined {
    return this.models.get(id);
  }

  require(id: string): ModelInfo {
    const m = this.models.get(id);
    if (!m) throw new Error(`Fusion: unknown model "${id}". Known models: ${[...this.models.keys()].join(', ')}`);
    return m;
  }

  all(): ModelInfo[] {
    return [...this.models.values()];
  }

  /** Short display name, falling back to the raw id. */
  short(id: string): string {
    return this.models.get(id)?.short ?? id;
  }
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

/** Estimated USD cost of one request, or `undefined` when the model has no known price. */
export function costOf(model: ModelInfo | undefined, u: TokenUsage): number | undefined {
  const p = model?.pricing;
  if (!p) return undefined;
  const promptTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const rate: RateCard = p.longContext && promptTokens > p.longContext.threshold ? p.longContext : p;
  return (
    (u.input * rate.input +
      u.output * rate.output +
      u.cacheRead * rate.cacheRead +
      u.cacheWrite5m * rate.cacheWrite5m +
      u.cacheWrite1h * rate.cacheWrite1h) /
    1_000_000
  );
}
