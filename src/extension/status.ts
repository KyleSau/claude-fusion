import * as vscode from 'vscode';
import { formatUsd } from '../core/ledger';
import type { ModelRegistry } from '../core/models';
import type { Orchestrator } from '../core/orchestrator';
import { oneLineSummary } from '../core/report';
import type { ProgressUpdate } from '../core/types';

const STAGE_LABEL: Record<ProgressUpdate['stage'], string> = {
  routing: 'routing',
  solving: 'working',
  drafting: 'drafting',
  gating: 'checking',
  escalating: 'escalating',
  critiquing: 'reviewing',
  revising: 'revising',
  done: 'done',
};

/** Shows the workflow stage while Fusion works, and the session's estimated spend otherwise. */
export class FusionStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('fusion.status', vscode.StatusBarAlignment.Right, 100);
  private readonly active = new Map<string, ProgressUpdate>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly registry: ModelRegistry,
    private readonly details: () => { apiKey: boolean; gateway?: string },
  ) {
    this.item.name = 'Fusion';
    this.item.command = 'fusion.menu';
    this.unsubscribe = orchestrator.ledger.onChange(() => this.update());
    this.update();
    this.item.show();
  }

  progress(p: ProgressUpdate): void {
    if (p.stage === 'done') this.active.delete(p.taskId);
    else this.active.set(p.taskId, p);
    this.update();
  }

  turnEnded(taskId: string | undefined): void {
    if (taskId) this.active.delete(taskId);
    else this.active.clear();
    this.update();
  }

  update(): void {
    const busy = [...this.active.values()].pop();
    const session = this.orchestrator.ledger.session;
    const d = this.details();
    if (busy) {
      this.item.text = `$(loading~spin) Fusion: ${STAGE_LABEL[busy.stage]}${busy.model ? ` · ${this.registry.short(busy.model)}` : ''}`;
    } else {
      this.item.text = `$(sparkle) Fusion${session.costUsd > 0 ? ` · ${formatUsd(session.costUsd)}` : ''}`;
    }
    const latest = this.orchestrator.ledger.latest();
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown('**Fusion** — multi-model orchestration\n\n');
    if (!d.apiKey) md.appendMarkdown('$(warning) No Anthropic API key set\n\n');
    if (latest?.plan) md.appendMarkdown(`Last: ${oneLineSummary(latest, this.registry)}\n\n`);
    md.appendMarkdown(`Session: ${session.tasks} task(s), ${session.legs} model call(s), ${formatUsd(session.costUsd)} estimated\n\n`);
    md.appendMarkdown(d.gateway ? `Gateway: ${d.gateway}` : 'Gateway: stopped');
    this.item.tooltip = md;
  }

  dispose(): void {
    this.unsubscribe();
    this.item.dispose();
  }
}
