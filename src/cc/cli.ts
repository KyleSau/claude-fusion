import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Difficulty, Objective, Tier } from '../core/types';
import { findClaude } from './claude';
import { runCc, type CcPattern } from './run';

export const CC_HELP = `fusion cc — multi-model orchestration on Claude Code (no API key; uses your Claude Code login)

Usage
  fusion cc "<task>" [options]
  fusion cc --prompt-file task.md [options]

Options
  --objective fast|balanced|quality     Routing objective (default balanced)
  --pattern auto|single|cascade|critique|guarded   Force a workflow (default auto)
  --side-effects                        The task acts on the world (email, calendar, forms, deploys):
                                        auto routing uses the guarded plan -> review -> execute pattern
  --guard-tools a,b,c                   Tools the guarded planner may not call (e.g. mcp__claude_ai_Gmail__send_message)
  --difficulty trivial|easy|medium|hard Skip the router
  --router model|heuristic              Router call on the fast tier, or keyword heuristics (default model)
  --tiers fast=haiku,balanced=sonnet,frontier=opus   Models for each tier (Claude Code aliases or full ids)
  --append-system-file rules.md         Appended to every working leg's system prompt
  --cwd DIR                             Working directory for the legs (default: current)
  --chrome                              Enable Claude in Chrome for working legs
  --permission-mode MODE                Claude Code permission mode for working legs (default auto)
  --leg-timeout-min N                   Per-leg timeout (default 20)
  --max-usd N                           Skip optional legs once the task's estimated cost reaches N (default 5)
  --gate-threshold N                    Minimum gate confidence to accept a draft (default 0.6)
  --claude PATH                         Claude Code CLI (default: $CLAUDE_PATH, PATH, or the VS Code extension)
  --json                                Print the outcome as JSON instead of the result text
  --json-out FILE                       Also write the outcome JSON to FILE
  -v, --verbose                         Log each leg to stderr`;

function tiers(spec: string | undefined): Record<Tier, string> {
  const t: Record<Tier, string> = { fast: 'haiku', balanced: 'sonnet', frontier: 'opus' };
  for (const part of (spec ?? '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=');
    if ((k === 'fast' || k === 'balanced' || k === 'frontier') && v) t[k] = v.trim();
  }
  return t;
}

export async function ccMain(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'prompt-file': { type: 'string' },
      'append-system-file': { type: 'string' },
      objective: { type: 'string' },
      pattern: { type: 'string' },
      'side-effects': { type: 'boolean' },
      'guard-tools': { type: 'string' },
      difficulty: { type: 'string' },
      router: { type: 'string' },
      tiers: { type: 'string' },
      cwd: { type: 'string' },
      chrome: { type: 'boolean' },
      'permission-mode': { type: 'string' },
      'leg-timeout-min': { type: 'string' },
      'max-usd': { type: 'string' },
      'gate-threshold': { type: 'string' },
      claude: { type: 'string' },
      json: { type: 'boolean' },
      'json-out': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(CC_HELP);
    return 0;
  }
  const prompt = values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8') : positionals.join(' ').trim();
  if (!prompt) {
    console.error(CC_HELP);
    return 1;
  }
  const objective = (values.objective ?? process.env.FUSION_OBJECTIVE ?? 'balanced') as Objective;
  if (!['fast', 'balanced', 'quality'].includes(objective)) throw new Error(`unknown objective "${objective}"`);
  const pattern = (values.pattern ?? 'auto') as CcPattern | 'auto';
  if (!['auto', 'single', 'cascade', 'critique', 'guarded'].includes(pattern)) throw new Error(`unknown pattern "${pattern}"`);
  const difficulty = values.difficulty as Difficulty | undefined;
  if (difficulty && !['trivial', 'easy', 'medium', 'hard'].includes(difficulty)) throw new Error(`unknown difficulty "${difficulty}"`);

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const outcome = await runCc({
    prompt,
    appendSystem: values['append-system-file'] ? readFileSync(values['append-system-file'], 'utf8') : undefined,
    cwd: values.cwd ?? process.cwd(),
    claudePath: findClaude(values.claude),
    objective,
    pattern,
    sideEffects: values['side-effects'] === true,
    guardTools: (values['guard-tools'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    difficulty,
    router: values.router === 'heuristic' || process.env.FUSION_ROUTER === 'heuristic' ? 'heuristic' : 'model',
    tiers: tiers(values.tiers ?? process.env.FUSION_CC_TIERS),
    chrome: values.chrome === true,
    permissionMode: values['permission-mode'] ?? 'auto',
    legTimeoutMs: Number(values['leg-timeout-min'] ?? 20) * 60_000,
    maxUsd: Number(values['max-usd'] ?? 5),
    gateThreshold: Number(values['gate-threshold'] ?? 0.6),
    log: values.verbose ? (l) => console.error(`· ${l}`) : undefined,
    signal: controller.signal,
  });
  if (values['json-out']) writeFileSync(values['json-out'], JSON.stringify(outcome, null, 1));
  if (values.json) console.log(JSON.stringify(outcome));
  else {
    console.log(outcome.result);
    console.error(
      `\nFusion (Claude Code) · ${outcome.reason} · ${outcome.legs.length} legs · $${outcome.costUsd.toFixed(4)} est. · ${(outcome.ms / 1000).toFixed(1)}s${outcome.escalated ? ' · escalated' : ''}`,
    );
  }
  return outcome.ok ? 0 : 2;
}
