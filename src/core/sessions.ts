import { randomUUID } from 'node:crypto';
import { Lru } from './lru';
import { appendNote, assistantFingerprint, toParams } from './transcript';
import type { ContentBlock, ModelRef, Msg, Plan } from './types';

export type TaskPhase = 'drafting' | 'escalated' | 'revising' | 'solving';

export interface TaskState {
  id: string;
  plan: Plan;
  phase: TaskPhase;
  /** Model currently driving the agent loop. Sticky within a task to keep the prompt cache warm. */
  active: ModelRef;
  /** Tool-calling steps the current drafter has taken. */
  draftSteps: number;
  createdAt: number;
}

interface RecordedTurn {
  /** The assistant turn exactly as the API returned it, in request-param form. */
  content: unknown[];
  /** Orchestrator notes that sat right before this turn when it was generated. */
  notes: string[];
  taskId: string;
}

/**
 * Per-process memory of tasks and of the assistant turns Fusion produced.
 *
 * The API binds thinking blocks to the exact conversation that produced them, so any note Fusion
 * appends (an escalation hand-off, a critique) must be replayed at the same position on every later
 * request. Clients never store those notes, so `restore()` puts them back.
 */
export class SessionStore {
  private readonly tasks = new Lru<string, TaskState>(500);
  private readonly turns = new Lru<string, RecordedTurn>(20_000);

  static newId(): string {
    return `t_${randomUUID().slice(0, 8)}`;
  }

  newTask(id: string, plan: Plan, phase: TaskPhase): TaskState {
    const task: TaskState = {
      id,
      plan,
      phase,
      active: plan.solver,
      draftSteps: 0,
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** The task that produced the assistant turn whose tool results end `messages`, if Fusion remembers it. */
  taskForContinuation(messages: readonly Msg[]): TaskState | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      const fp = assistantFingerprint(m.content);
      const rec = fp ? this.turns.get(fp) : undefined;
      return rec ? this.tasks.get(rec.taskId) : undefined;
    }
    return undefined;
  }

  record(content: readonly ContentBlock[], taskId: string, notes: string[]): void {
    const fp = assistantFingerprint(content);
    if (!fp) return;
    this.turns.set(fp, { content: toParams(content), notes, taskId });
  }

  /**
   * Re-inserts recorded notes before the turns they preceded and, when `restoreBlocks` is set,
   * swaps each recognised assistant turn for the exact blocks the API returned.
   */
  restore(messages: readonly Msg[], restoreBlocks: boolean): Msg[] {
    let out: Msg[] = [];
    for (const m of messages) {
      if (m.role === 'assistant') {
        const fp = assistantFingerprint(m.content);
        const rec = fp ? this.turns.get(fp) : undefined;
        if (rec) {
          for (const note of rec.notes) out = appendNote(out, note) ?? out;
          out.push(restoreBlocks ? ({ role: 'assistant', content: rec.content } as Msg) : m);
          continue;
        }
      }
      out.push(m);
    }
    return out;
  }
}
