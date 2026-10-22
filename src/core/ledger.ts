import type { TokenUsage } from './models';
import type { Effort, LegOutcome, LegRole, Plan, RouteDecision } from './types';

/** One model call made while handling a turn: a draft, a gate check, a critique, a routing call... */
export interface Leg {
  taskId: string;
  role: LegRole;
  model: string;
  effort?: Effort;
  outcome: LegOutcome;
  ms: number;
  usage: TokenUsage;
  /** Undefined when the model has no known price (e.g. a subscription model provided by VS Code). */
  costUsd?: number;
  detail?: string;
}

export interface TaskSummary {
  taskId: string;
  startedAt: number;
  updatedAt: number;
  decision?: RouteDecision;
  plan?: Plan;
  legs: Leg[];
  costUsd: number;
  /** False when at least one leg had no known price, so `costUsd` is a lower bound. */
  costComplete: boolean;
  final: boolean;
  /** How the task resolved, e.g. "draft accepted by gate" or "escalated to Opus 5.5". */
  resolution?: string;
}

type Listener = (task: TaskSummary) => void;

/** Complete accounting across every leg of every task, kept in memory for the UI and logs. */
export class Ledger {
  private readonly tasks = new Map<string, TaskSummary>();
  private readonly listeners = new Set<Listener>();
  private sessionCost = 0;
  private sessionLegs = 0;

  constructor(private readonly keep = 100) {}

  start(taskId: string): TaskSummary {
    const now = Date.now();
    const task: TaskSummary = { taskId, startedAt: now, updatedAt: now, legs: [], costUsd: 0, costComplete: true, final: false };
    this.tasks.set(taskId, task);
    while (this.tasks.size > this.keep) this.tasks.delete(this.tasks.keys().next().value!);
    return task;
  }

  get(taskId: string): TaskSummary | undefined {
    return this.tasks.get(taskId);
  }

  ensure(taskId: string): TaskSummary {
    return this.tasks.get(taskId) ?? this.start(taskId);
  }

  update(taskId: string, patch: Partial<Pick<TaskSummary, 'decision' | 'plan' | 'final' | 'resolution'>>): void {
    const task = this.ensure(taskId);
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.emit(task);
  }

  record(leg: Leg): void {
    const task = this.ensure(leg.taskId);
    task.legs.push(leg);
    task.updatedAt = Date.now();
    if (leg.costUsd === undefined) {
      if (leg.outcome !== 'skipped') task.costComplete = false;
    } else {
      task.costUsd += leg.costUsd;
      this.sessionCost += leg.costUsd;
    }
    this.sessionLegs++;
    this.emit(task);
  }

  recent(limit = 20): TaskSummary[] {
    return [...this.tasks.values()].slice(-limit).reverse();
  }

  latest(): TaskSummary | undefined {
    let latest: TaskSummary | undefined;
    for (const t of this.tasks.values()) if (!latest || t.updatedAt >= latest.updatedAt) latest = t;
    return latest;
  }

  get session(): { costUsd: number; legs: number; tasks: number } {
    return { costUsd: this.sessionCost, legs: this.sessionLegs, tasks: this.tasks.size };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(task: TaskSummary): void {
    for (const l of this.listeners) {
      try {
        l(task);
      } catch {
        // A broken listener must never break a request.
      }
    }
  }
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}
