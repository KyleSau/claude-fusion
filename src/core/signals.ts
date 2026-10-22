import { hasToolResults, lastRequestIndex, requestText, splitRequest, textOf } from './transcript';
import type { Difficulty, Msg, Risk, RouteDecision, Tool } from './types';

const PATTERNS = {
  debugging:
    /\b(bugs?|errors?|exceptions?|fail(?:s|ing|ed|ure)?|crash(?:es|ing|ed)?|broken|not working|doesn'?t work|stack ?trace|traceback|segfault|panic(?:ked)?|regression|flaky|fix(?:es|ing)?)\b/gi,
  codegen:
    /\b(implement|write|create|add|build|generate|scaffold|refactor|migrate|port|convert|rewrite|feature|endpoint|component|function|class|module|tests?|script)\b/gi,
  reasoning:
    /\b(why|design|architect(?:ure)?|trade-?offs?|compare|optimi[sz]e|performance|complexity|algorithm|prove|correctness|concurren(?:t|cy)|race conditions?|deadlocks?|thread-?safe|memory leaks?|security|vulnerab\w*|scal(?:e|ing|ability)|distributed)\b/gi,
  risk: /\b(prod(?:uction)?|deploy\w*|migrations?|drop table|rm -rf|credentials?|secrets?|passwords?|payments?|billing|encrypt\w*|auth(?:entication|orization)?)\b/gi,
  greeting:
    /^\s*(hi|hello|hey|yo|thanks?|thank you|ty|ok(?:ay)?|cool|great|nice|good (?:morning|afternoon|evening))\b[\s!.?]*$/i,
  fast: /\b(quick(?:ly)?|fast|brief(?:ly)?|short answer|tl;?dr|one-?liner)\b/i,
  deep: /\b(think (?:hard|carefully|deeply)|ultrathink|very carefully|thorough(?:ly)?|in[- ]depth|deep dive|rigorous(?:ly)?)\b/i,
  stack:
    /(Traceback \(most recent call last\)|^\s+at \S+ \(?.*:\d+:\d+\)?$|Exception in thread|panicked at|error TS\d{4}|error\[E\d{4}\]|Segmentation fault|AssertionError|NullPointerException|TypeError:|ReferenceError:|SyntaxError:)/m,
};

export interface TaskFeatures {
  request: string;
  context: string;
  chars: number;
  codeBlocks: number;
  stackTrace: boolean;
  agentic: boolean;
  tools: string[];
  priorRequests: number;
  /** The task is continuing an earlier one after Fusion lost track of it (e.g. a restart). */
  resumed: boolean;
  greeting: boolean;
  hints: { fast: boolean; deep: boolean };
  counts: { debugging: number; codegen: number; reasoning: number; risk: number };
}

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

export function toolNames(tools: readonly Tool[]): string[] {
  return tools.map((t) => ('name' in t && typeof t.name === 'string' ? t.name : t.type));
}

export function extractFeatures(messages: readonly Msg[], tools: readonly Tool[]): TaskFeatures {
  const { request, context } = requestText(messages);
  const start = lastRequestIndex(messages);
  let priorRequests = 0;
  for (let i = 0; i < start; i++) {
    const m = messages[i];
    if (m.role === 'user' && !hasToolResults(m) && splitRequest(textOf(m.content)).request) priorRequests++;
  }
  const all = `${request}\n${context}`;
  return {
    request,
    context,
    chars: request.length,
    codeBlocks: Math.floor((all.match(/```/g)?.length ?? 0) / 2),
    stackTrace: PATTERNS.stack.test(all),
    agentic: tools.length > 0,
    tools: toolNames(tools),
    priorRequests,
    resumed: hasToolResults(messages[messages.length - 1]),
    greeting: PATTERNS.greeting.test(request),
    hints: { fast: PATTERNS.fast.test(request), deep: PATTERNS.deep.test(request) },
    counts: {
      debugging: count(PATTERNS.debugging, request),
      codegen: count(PATTERNS.codegen, request),
      reasoning: count(PATTERNS.reasoning, request),
      risk: count(PATTERNS.risk, request),
    },
  };
}

const ORDER: Difficulty[] = ['trivial', 'easy', 'medium', 'hard'];

export function shiftDifficulty(d: Difficulty, by: number): Difficulty {
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(d) + by))];
}

/** Requests so plainly trivial that asking the router model would cost more than it saves. */
export function obviouslyTrivial(f: TaskFeatures): boolean {
  if (f.resumed || f.codeBlocks > 0 || f.stackTrace) return false;
  if (f.greeting) return true;
  const c = f.counts;
  return f.chars > 0 && f.chars < 60 && c.debugging + c.codegen + c.reasoning + c.risk === 0;
}

/** Keyword-and-shape routing used when the router model is off, fails, or is not worth calling. */
export function heuristicRoute(f: TaskFeatures): RouteDecision {
  const c = f.counts;
  let difficulty: Difficulty;
  if (obviouslyTrivial(f)) {
    difficulty = 'trivial';
  } else {
    let score = 0;
    if (f.chars > 4000) score += 2;
    else if (f.chars > 1200) score += 1;
    if (f.codeBlocks >= 2) score += 1;
    if (f.stackTrace) score += 1;
    score += Math.min(2, c.reasoning);
    if (c.debugging) score += 1;
    if (c.codegen && f.agentic) score += 1;
    if (c.risk >= 2) score += 1;
    if (f.resumed) score += 1;
    difficulty = score <= 1 ? 'easy' : score <= 3 ? 'medium' : 'hard';
  }
  if (f.hints.fast) difficulty = shiftDifficulty(difficulty, -1);
  if (f.hints.deep) difficulty = shiftDifficulty(difficulty, +1);

  const risk: Risk = c.risk >= 3 ? 'high' : c.risk >= 1 ? 'medium' : 'low';
  const signals = {
    reasoning: Math.min(3, c.reasoning),
    codegen: Math.min(3, c.codegen),
    debugging: Math.min(3, c.debugging + (f.stackTrace ? 1 : 0)),
    toolUse: f.agentic ? (c.codegen || c.debugging ? 2 : 1) : 0,
  };
  return {
    difficulty,
    risk,
    signals,
    needsReview: signals.reasoning >= 2 || risk === 'high',
    source: 'heuristic',
    rationale: f.resumed ? 'continuing a task Fusion has no record of' : 'keyword and shape heuristics',
  };
}
