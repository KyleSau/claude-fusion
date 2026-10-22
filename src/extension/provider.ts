import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { isCancellation } from '../core/bounded';
import type { ModelRegistry } from '../core/models';
import { errorMessage, type Orchestrator } from '../core/orchestrator';
import { oneLineSummary } from '../core/report';
import { footerLine } from '../core/transcript';
import type { Objective, ProgressUpdate } from '../core/types';
import { fromVsCode, toolsFromVsCode, VsCodeSink } from './convert';
import type { ExtensionSettings } from './settings';

export const VENDOR = 'fusion';

const VARIANTS: { id: string; name: string; objective?: Objective }[] = [
  { id: 'fusion', name: 'Fusion (multi model)' },
  { id: 'fusion-fast', name: 'Fusion Fast (multi model)', objective: 'fast' },
  { id: 'fusion-quality', name: 'Fusion Quality (multi model)', objective: 'quality' },
];

const TOOLTIPS: Record<Objective, string> = {
  fast: 'Fusion, tuned for speed and cost: Haiku handles most tasks, Sonnet steps in when a gate rejects its work.',
  balanced: 'Fusion routes each task to the least complex workflow likely to meet the bar: a single call, a cascade with a quality gate, or a draft-critique-revise loop across Haiku, Sonnet and Opus.',
  quality: 'Fusion, tuned for quality: stronger drafters and an independent review on most tasks.',
};

export interface ProviderHost {
  orchestrator: Orchestrator;
  registry: ModelRegistry;
  settings(): ExtensionSettings;
  /** Makes sure Fusion can call its models, prompting for an API key if needed. */
  ensureCredentials(): Promise<boolean>;
  onProgress(p: ProgressUpdate): void;
  onTurnEnd(taskId: string | undefined): void;
  log: vscode.LogOutputChannel;
  version: string;
}

/** Puts "Fusion (multi model)" into VS Code's chat model picker. */
export class FusionChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  constructor(private readonly host: ProviderHost) {}

  refresh(): void {
    this.changed.fire();
  }

  provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
    const s = this.host.settings();
    const r = this.host.registry;
    const pool = s.fusion.pool;
    return VARIANTS.filter((v) => v.id === 'fusion' || s.showVariants).map((v) => ({
      id: v.id,
      name: v.name,
      family: 'fusion',
      version: this.host.version,
      detail: `${r.short(pool.fast)} · ${r.short(pool.balanced)} · ${r.short(pool.frontier)}`,
      tooltip: TOOLTIPS[v.objective ?? s.fusion.objective],
      maxInputTokens: s.maxInputTokens,
      maxOutputTokens: 64_000,
      capabilities: { toolCalling: true, imageInput: true },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const s = this.host.settings();
    if (!(await this.host.ensureCredentials())) {
      throw new Error('Fusion needs an Anthropic API key. Run "Fusion: Set Anthropic API Key", then try again.');
    }
    const objective = VARIANTS.find((v) => v.id === model.id)?.objective ?? s.fusion.objective;
    const { tools, names } = toolsFromVsCode(options.tools);
    const { system, messages: history } = fromVsCode(messages);
    const controller = new AbortController();
    const cancel = token.onCancellationRequested(() => controller.abort());
    const sink = new VsCodeSink(progress, names, s.fusion.progressUpdates, (p) => this.host.onProgress(p));
    let taskId: string | undefined;
    try {
      const outcome = await this.host.orchestrator.handleTurn(
        {
          system,
          messages: history,
          tools,
          toolChoice: options.toolMode === vscode.LanguageModelChatToolMode.Required && tools.length ? { type: 'any' } : undefined,
          objective,
          restoreAssistantBlocks: true,
          progressUpdates: s.fusion.progressUpdates,
          signal: controller.signal,
        },
        sink,
      );
      taskId = outcome.taskId;
      if (outcome.final && s.showSummary) {
        const task = this.host.orchestrator.ledger.get(outcome.taskId);
        if (task) progress.report(new vscode.LanguageModelTextPart(footerLine(oneLineSummary(task, this.host.registry))));
      }
    } catch (err) {
      if (token.isCancellationRequested || isCancellation(err)) return;
      this.host.log.error(`request failed: ${errorMessage(err)}`);
      throw new Error(friendlyError(err));
    } finally {
      cancel.dispose();
      this.host.onTurnEnd(taskId);
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    if (typeof text === 'string') return estimateTokens(text.length);
    let chars = 0;
    let images = 0;
    const visit = (part: unknown) => {
      const p = part as Record<string, any>;
      if (typeof p?.value === 'string') chars += p.value.length;
      else if (typeof p?.mimeType === 'string') images += p.mimeType.startsWith('image/') ? 1 : 0;
      else if (typeof p?.name === 'string' && 'input' in p) chars += p.name.length + JSON.stringify(p.input ?? {}).length;
      else if (Array.isArray(p?.content)) p.content.forEach(visit);
      else if (p && 'value' in p) chars += JSON.stringify(p.value ?? '').length;
    };
    text.content.forEach(visit);
    return estimateTokens(chars) + images * 1_600;
  }
}

/** A deliberately generous estimate: ~3.5 characters per token on the newer Claude tokenizers. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Fusion: the Anthropic API rejected the API key. Update it with "Fusion: Set Anthropic API Key".';
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Fusion: this API key cannot use the requested model (${errorMessage(err)}).`;
  if (err instanceof Anthropic.RateLimitError) return 'Fusion: the Anthropic API is rate limiting this key. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Fusion: could not reach the Anthropic API. Check your connection.';
  return `Fusion: ${errorMessage(err)}`;
}
