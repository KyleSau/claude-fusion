import * as vscode from 'vscode';
import { resolveConfig, type FusionConfig } from '../core/config';

export interface ExtensionSettings {
  fusion: FusionConfig;
  showSummary: boolean;
  showVariants: boolean;
  maxInputTokens: number;
  gateway: { autoStart: boolean; port: number };
  baseUrl: string;
}

export function readSettings(): ExtensionSettings {
  const c = vscode.workspace.getConfiguration('fusion');
  const get = <T>(key: string): T | undefined => c.get<T>(key);
  const fast = get<string>('models.fast') || undefined;
  return {
    fusion: resolveConfig({
      objective: get('objective'),
      pool: { fast, balanced: get<string>('models.balanced') || undefined, frontier: get<string>('models.frontier') || undefined },
      router: { mode: get('router.mode'), model: fast },
      forcePattern: get('forcePattern'),
      gate: { threshold: get('gate.threshold') },
      critique: { model: get<string>('models.critic') ?? '' },
      cascade: { maxDraftSteps: get('cascade.maxDraftSteps') },
      budget: { maxTaskUsd: get('budget.maxTaskUsd') },
      progressUpdates: get('progressUpdates'),
      refusalFallback: get('refusalFallback'),
    }),
    showSummary: get<boolean>('showSummary') ?? true,
    showVariants: get<boolean>('showVariants') ?? true,
    maxInputTokens: get<number>('maxInputTokens') ?? 200_000,
    gateway: { autoStart: get<boolean>('gateway.autoStart') ?? false, port: get<number>('gateway.port') ?? 4545 },
    baseUrl: (get<string>('anthropic.baseUrl') ?? '').trim(),
  };
}
