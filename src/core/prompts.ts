import * as z from 'zod/v4';
import type { WorkSummary } from './transcript';
import type { Difficulty, Risk } from './types';

// Wire schemas hold only what structured outputs enforce (types and required fields); allowed values
// travel as descriptions, and the normalize* functions below map the answers onto them.
const level = z.number().describe('0, 1, 2 or 3');

export const RouteSchema = z.object({
  difficulty: z.string().describe('One of: trivial, easy, medium, hard'),
  reasoning: level,
  codegen: level,
  debugging: level,
  toolUse: level,
  risk: z.string().describe('One of: low, medium, high'),
  needsReview: z.boolean(),
  rationale: z.string(),
});

export const GateSchema = z.object({
  issues: z.array(z.string()),
  confidence: z.number().describe('From 0 to 1'),
  accept: z.boolean(),
});

export const CritiqueSchema = z.object({
  issues: z.array(
    z.object({
      severity: z.string().describe('One of: critical, major, minor'),
      issue: z.string(),
      suggestion: z.string(),
    }),
  ),
  verdict: z.string().describe('One of: approve, revise'),
});

function pick<T extends string>(value: string, allowed: readonly T[], aliases: Record<string, T>, fallback: T): T {
  const v = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : (aliases[v] ?? fallback);
}

const clampLevel = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0);

export interface RouteJson {
  difficulty: Difficulty;
  reasoning: number;
  codegen: number;
  debugging: number;
  toolUse: number;
  risk: Risk;
  needsReview: boolean;
  rationale: string;
}

export function normalizeRoute(v: z.infer<typeof RouteSchema>): RouteJson {
  return {
    difficulty: pick(v.difficulty, ['trivial', 'easy', 'medium', 'hard'], { simple: 'easy', moderate: 'medium', complex: 'hard', expert: 'hard' }, 'medium'),
    reasoning: clampLevel(v.reasoning),
    codegen: clampLevel(v.codegen),
    debugging: clampLevel(v.debugging),
    toolUse: clampLevel(v.toolUse),
    risk: pick(v.risk, ['low', 'medium', 'high'], { none: 'low', critical: 'high' }, 'medium'),
    needsReview: v.needsReview,
    rationale: v.rationale,
  };
}

export interface GateJson {
  issues: string[];
  confidence: number;
  accept: boolean;
}

export function normalizeGate(v: z.infer<typeof GateSchema>): GateJson {
  const c = v.confidence > 1 && v.confidence <= 100 ? v.confidence / 100 : v.confidence;
  return { issues: v.issues.filter(Boolean), confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0, accept: v.accept };
}

export interface CritiqueJson {
  issues: { severity: 'critical' | 'major' | 'minor'; issue: string; suggestion: string }[];
  verdict: 'approve' | 'revise';
}

export function normalizeCritique(v: z.infer<typeof CritiqueSchema>): CritiqueJson {
  const issues = v.issues
    .filter((i) => i.issue.trim())
    .map((i) => ({ ...i, severity: pick(i.severity, ['critical', 'major', 'minor'] as const, { high: 'major', medium: 'major', low: 'minor', blocker: 'critical' }, 'major') }));
  return { issues, verdict: pick(v.verdict, ['approve', 'revise'] as const, { approved: 'approve', accept: 'approve', reject: 'revise' }, issues.length ? 'revise' : 'approve') };
}

export const ROUTER_SYSTEM = `You are the routing classifier inside Fusion, a coding assistant that runs each task on the cheapest model workflow likely to meet a high quality bar. Read the user's latest request and the context around it, and estimate what solving it will take. You do not solve it.

Rate:
- difficulty:
  - "trivial": greetings, thanks, one-line factual questions, tiny mechanical edits (a rename, a typo, formatting) with no ambiguity.
  - "easy": small, well-specified work confined to one file or function; straightforward explanations of given code; simple commands.
  - "medium": typical feature work or bug fixes spanning a few files; debugging with a clear error or failing test; non-trivial explanations or reviews.
  - "hard": ambiguous or open-ended goals, architecture or design decisions, subtle bugs (concurrency, memory, performance, security), large refactors or migrations, work that needs long autonomous exploration or deep reasoning.
- reasoning, codegen (writing or changing code), debugging, toolUse (reading files, running commands, searching; only when tools are available): each 0 to 3, where 0 means not needed and 3 means central to the task.
- risk: "high" when a mistake could lose data, break production, weaken security, or touch credentials, payments, deployments or migrations; "medium" for changes to shared or critical code; otherwise "low".
- needsReview: true when an independent second opinion would likely catch mistakes a single pass would miss, such as correctness-critical logic, tricky edge cases, or claims that are easy to get subtly wrong.
- rationale: one short sentence.

Judge the substance of the task, not its length. Long pasted context can come with an easy request, and a one-line request can be hard.`;

export function routerPrompt(input: {
  request: string;
  context: string;
  earlier: string;
  tools: string[];
}): string {
  const tools = input.tools.length
    ? `yes, ${input.tools.length} tools (for example: ${input.tools.slice(0, 12).join(', ')})`
    : 'no (chat only)';
  return [
    `Tools available: ${tools}`,
    input.earlier ? `Earlier requests in this conversation:\n${input.earlier}` : '',
    `<request>\n${input.request || '(empty)'}\n</request>`,
    input.context ? `<context>\n${input.context}\n</context>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const GATE_SYSTEM = `You are the quality gate in Fusion, a multi-model coding assistant. A fast, low-cost model has finished working on the user's task and proposed a final response. Decide whether the work and the response can be delivered to the user as they are, or whether the task must be handed to a stronger model.

You see the user's request, a condensed log of the actions taken (tool calls and their results), and the proposed final response. You cannot run tools, so judge from the evidence.

Reject (accept = false) when any of these hold:
- A requirement in the request is unmet, only partly done, or silently changed.
- The code or reasoning contains an error, or the response states something the log does not support: tests reported as passing that were never run or failed, files that were never edited, invented APIs.
- Errors in the log were left unresolved, or the work stopped early.
- The task needed verification (tests, a build, running the code) that was available and skipped.
- The answer to a question is wrong, misleading, or materially incomplete.
Do not reject for style, verbosity, or choices a reasonable engineer would accept.

List at most 5 concrete issues, most important first. confidence is how sure you are (0 to 1) that the response fully and correctly solves the task. Set accept = true only if you would ship it.`;

export const CRITIC_SYSTEM = `You are an independent reviewer in Fusion, a multi-model coding assistant: a rubber duck from a different model family. Another model has worked on the user's task and proposed a final response that the user has not seen yet. Your review is read-only: you cannot run tools, and you only see the request, a condensed log of the actions taken, and the proposed response.

Look for concrete defects that matter:
- Correctness: bugs in code or logic, wrong commands, incorrect explanations, unhandled edge cases the task cares about.
- Completeness: requirements that were missed or only partly done.
- Evidence: claims the log does not support, such as untested changes reported as tested or errors that were ignored.
- Risk: changes that could break other code, lose data, or weaken security.

Do not nitpick style, formatting, or reasonable choices. If the work is correct and complete, approve it with no issues; approving good work is the expected outcome, not a failure to review.

Give each issue a severity ("critical": wrong or harmful as delivered; "major": a real defect or a missed requirement; "minor": worth a mention but fine to ship) and a concrete suggestion. At most 6 issues, most important first.`;

export function reviewPrompt(work: WorkSummary, draft: string): string {
  return [
    work.earlier ? `Earlier requests in this conversation:\n${work.earlier}` : '',
    `<request>\n${work.request || '(empty)'}\n</request>`,
    work.context ? `<request_context>\n${work.context}\n</request_context>` : '',
    `<work_log steps="${work.steps}">\n${work.log || '(no tool calls; the model answered directly)'}\n</work_log>`,
    `<proposed_response>\n${draft || '(empty)'}\n</proposed_response>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function escalationNote(reasons: string[], draft: string | undefined): string {
  const lines = [
    '[Fusion orchestrator] You are taking over this task from a faster model. It was handed to you for these reasons:',
    ...reasons.map((r) => `- ${r}`),
  ];
  if (draft) {
    lines.push('', 'Its proposed final response, which the user has not seen:', '<draft>', draft, '</draft>');
  }
  lines.push(
    '',
    'The conversation above shows everything it did. Continue from the current state: check that work, fix what is wrong or missing (use tools where needed), then write the final response to the user yourself. The user has not seen this hand-off, so do not mention it.',
  );
  return lines.join('\n');
}

export function critiqueNote(issues: CritiqueJson['issues'], draft: string): string {
  return [
    '[Fusion orchestrator] An independent reviewer from another model family examined your proposed final response before it was shown to the user and raised these issues:',
    ...issues.map((i, n) => `${n + 1}. (${i.severity}) ${i.issue}${i.suggestion ? ` Suggestion: ${i.suggestion}` : ''}`),
    '',
    'Your proposed final response:',
    '<draft>',
    draft,
    '</draft>',
    '',
    'Address each issue that is valid (use tools if changes or checks are needed), then write your final response to the user. If an issue is mistaken, keep the correct work as it is rather than changing it to satisfy the reviewer. The user has not seen this review, so do not mention it.',
  ].join('\n');
}
