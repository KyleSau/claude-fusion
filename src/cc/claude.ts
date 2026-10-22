import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Effort } from '../core/types';

/**
 * One headless Claude Code run (`claude -p`). Fusion's Claude Code backend drives the CLI you already
 * use, so every leg runs on your Claude Code login (a Claude subscription or whatever else the CLI is
 * signed in with) and counts toward that plan's usage, not an API key.
 */
export interface ClaudeRunOptions {
  claudePath: string;
  prompt: string;
  model: string;
  effort: Effort;
  cwd: string;
  appendSystem?: string;
  /** Claude Code permission mode for this leg (default "auto"). */
  permissionMode?: string;
  /** Run with no tools at all (judges and reviewers). */
  toolless?: boolean;
  /** Tool patterns this leg may not use, e.g. "mcp__claude_ai_Gmail__send_message". */
  disallowedTools?: string[];
  chrome?: boolean;
  /** Continue an earlier leg's session, keeping its context (escalation, revision). */
  resume?: string;
  /** Keep the session on disk so a later leg can resume it. */
  persist?: boolean;
  extraArgs?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolStep {
  name: string;
  input: string;
  result?: string;
  error?: boolean;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd: number;
  ms: number;
  turns: number;
  steps: ToolStep[];
  error?: string;
}

/** Finds the Claude Code CLI: $CLAUDE_PATH, then PATH, then the newest VS Code extension build. */
export function findClaude(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
    if (dir && process.platform === 'win32' && existsSync(join(dir, 'claude.cmd'))) return join(dir, 'claude.cmd');
  }
  const ext = join(homedir(), '.vscode', 'extensions');
  if (existsSync(ext)) {
    const builds = readdirSync(ext)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .map((d) => ({ d, v: (d.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number) }))
      .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
    for (const b of builds.reverse()) {
      const p = join(ext, b.d, 'resources', 'native-binary', exe);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('Claude Code CLI not found. Install it (https://code.claude.com) or pass --claude <path>.');
}

export function claudeArgs(o: ClaudeRunOptions): string[] {
  const args = ['-p', '--model', o.model, '--effort', o.effort, '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', o.permissionMode ?? 'auto', '--permission-prompts', 'none');
  if (o.toolless) args.push('--tools', '');
  if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));
  if (o.chrome && !o.toolless) args.push('--chrome');
  if (o.resume) args.push('--resume', o.resume);
  if (!o.persist && !o.resume) args.push('--no-session-persistence');
  if (o.appendSystem) args.push('--append-system-prompt', o.appendSystem);
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function textOfContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('');
  return '';
}

/** Parses `--output-format stream-json` lines into the final result plus a log of tool steps. */
export function parseStream(lines: string[]): Omit<ClaudeRunResult, 'ms'> {
  const steps: ToolStep[] = [];
  const byId = new Map<string, ToolStep>();
  let final: Record<string, unknown> | undefined;
  let lastText = '';
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = ev.message as { content?: unknown } | undefined;
    if (ev.type === 'assistant' && Array.isArray(msg?.content)) {
      for (const b of msg!.content as Record<string, unknown>[]) {
        if (b.type === 'tool_use') {
          const step = { name: String(b.name), input: clip(JSON.stringify(b.input ?? {}), 300) };
          steps.push(step);
          if (b.id) byId.set(String(b.id), step);
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          lastText = b.text;
        }
      }
    } else if (ev.type === 'user' && Array.isArray(msg?.content)) {
      for (const b of msg!.content as Record<string, unknown>[]) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const step = byId.get(String(b.tool_use_id));
          if (step) {
            step.result = clip(textOfContent(b.content), 400);
            step.error = b.is_error === true;
          }
        }
      }
    } else if (ev.type === 'result') {
      final = ev;
    }
  }
  if (!final) return { ok: false, text: lastText, costUsd: 0, turns: 0, steps, error: 'no result from claude' };
  const structured = final.structured_output;
  const text = structured !== undefined ? JSON.stringify(structured) : String(final.result ?? lastText ?? '');
  return {
    ok: final.is_error !== true && final.subtype !== 'error_max_turns',
    text,
    sessionId: typeof final.session_id === 'string' ? final.session_id : undefined,
    costUsd: Number(final.total_cost_usd) || 0,
    turns: Number(final.num_turns) || 0,
    steps,
    error: final.is_error === true ? String(final.result ?? final.subtype ?? 'error') : undefined,
  };
}

/** Runs one leg. Never throws for a failed run (ok: false); throws only when cancelled. */
export function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(o.claudePath, claudeArgs(o), { cwd: o.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buf = '';
    let stderr = '';
    let settled = false;
    const finish = (r: ClaudeRunResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      const parsed = parseStream(lines);
      finish({ ...parsed, ok: false, ms: Date.now() - started, error: `timed out after ${Math.round(o.timeoutMs / 1000)}s` });
    }, o.timeoutMs);
    const onAbort = () => {
      child.kill();
      finish(new Error('cancelled'));
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (err) => finish({ ok: false, text: '', costUsd: 0, turns: 0, steps: [], ms: Date.now() - started, error: err.message }));
    child.on('close', () => {
      if (buf.trim()) lines.push(buf.trim());
      const parsed = parseStream(lines);
      finish({ ...parsed, ms: Date.now() - started, error: parsed.error ?? (parsed.ok ? undefined : stderr.trim().slice(-500) || 'claude exited without a result') });
    });
    child.stdin.end(o.prompt);
  });
}

/** A short, judge-readable log of what a leg did: the evidence a gate or reviewer reads. */
export function workLog(steps: ToolStep[], maxChars = 8_000): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, s] of steps.entries()) {
    const line = `${i + 1}. ${s.name} ${s.input}${s.result !== undefined ? `\n   -> ${s.error ? 'ERROR: ' : ''}${s.result.replace(/\s+/g, ' ')}` : ''}`;
    if (used + line.length > maxChars) {
      out.push(`… ${steps.length - i} more steps omitted`);
      break;
    }
    out.push(line);
    used += line.length;
  }
  return out.join('\n');
}

/** Pulls the first JSON object out of a judge's answer (structured output, a fenced block, or bare). */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const v = tryParse(fenced[1]);
    if (v) return v;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : undefined;
}
