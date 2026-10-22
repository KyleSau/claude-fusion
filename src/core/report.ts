import { formatUsd, type Leg, type TaskSummary } from './ledger';
import type { ModelRegistry } from './models';

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function cost(task: TaskSummary): string {
  return `${formatUsd(task.costUsd)}${task.costComplete ? '' : '+'}`;
}

/** One line for the end of a response: what Fusion did, how many calls, what it cost. */
export function oneLineSummary(task: TaskSummary, registry: ModelRegistry): string {
  const plan = task.plan;
  const calls = task.legs.filter((l) => l.outcome !== 'skipped').length;
  const who = plan ? registry.short(plan.solver.model) : '?';
  const what = task.resolution ?? (plan?.pattern === 'single' ? who : `${who} drafted`);
  return [
    plan?.pattern ?? 'fusion',
    what,
    `${calls} call${calls === 1 ? '' : 's'}`,
    cost(task),
    formatMs(task.updatedAt - task.startedAt),
  ].join(' · ');
}

export function legRow(leg: Leg, registry: ModelRegistry): string[] {
  return [
    leg.role,
    registry.short(leg.model),
    leg.effort ?? '',
    leg.outcome,
    formatMs(leg.ms),
    leg.costUsd === undefined ? 'n/a' : formatUsd(leg.costUsd),
    `${leg.usage.input + leg.usage.cacheRead + leg.usage.cacheWrite5m + leg.usage.cacheWrite1h} in / ${leg.usage.output} out`,
    leg.detail ?? '',
  ];
}

export function textReport(task: TaskSummary, registry: ModelRegistry): string {
  const rows = task.legs.map((l) => legRow(l, registry));
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  const table = rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')).join('\n         ');
  return [
    `plan     ${task.plan?.reason ?? '(none)'}`,
    task.decision ? `routing  ${task.decision.source}: ${task.decision.rationale}` : '',
    task.resolution ? `result   ${task.resolution}` : '',
    `legs     ${table || '(none)'}`,
    `total    ${cost(task)} · ${formatMs(task.updatedAt - task.startedAt)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function markdownReport(task: TaskSummary, registry: ModelRegistry): string {
  const lines = [
    `## Fusion task \`${task.taskId}\``,
    '',
    `**Plan:** ${task.plan?.reason ?? '(none)'}  `,
    task.decision ? `**Routing:** ${task.decision.source} — ${task.decision.rationale}  ` : '',
    task.decision
      ? `**Signals:** reasoning ${task.decision.signals.reasoning}, codegen ${task.decision.signals.codegen}, debugging ${task.decision.signals.debugging}, tool use ${task.decision.signals.toolUse}; risk ${task.decision.risk}${task.decision.needsReview ? '; review recommended' : ''}  `
      : '',
    task.resolution ? `**Result:** ${task.resolution}  ` : '',
    `**Total:** ${cost(task)} over ${formatMs(task.updatedAt - task.startedAt)}`,
    '',
    '| Leg | Model | Effort | Outcome | Time | Cost | Tokens | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...task.legs.map((l) => `| ${legRow(l, registry).map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`),
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}
