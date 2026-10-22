import { parseArgs } from 'node:util';
import { resolveConfig, validateConfig, type FusionConfig } from './core/config';
import { formatUsd } from './core/ledger';
import { ANTHROPIC_MODELS } from './core/models';
import { errorMessage, type Logger } from './core/orchestrator';
import { oneLineSummary, textReport } from './core/report';
import type { Objective, Pattern, TurnSink } from './core/types';
import { DEFAULT_PORT, DEFAULT_UPSTREAM, Gateway } from './gateway/server';
import { createRuntime } from './runtime';
import { version } from '../package.json';

const HELP = `fusion ${version} — multi-model orchestration for Claude

Usage
  fusion gateway [--port ${DEFAULT_PORT}] [--host 127.0.0.1]   Anthropic-compatible endpoint (use it from Claude Code)
  fusion ask "<prompt>" [--objective fast|balanced|quality] [--pattern single|cascade|critique]
  fusion route "<prompt>" [--agentic]                     Show how a request would be routed (one router call)
  fusion models                                           Show the model pool and prices

Environment
  FUSION_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY   API key for Fusion's own model calls
  FUSION_UPSTREAM_URL                           Upstream API (default ${DEFAULT_UPSTREAM})
  FUSION_OBJECTIVE                              Objective for the plain "fusion" model (default balanced)
  FUSION_FAST_MODEL, FUSION_BALANCED_MODEL, FUSION_FRONTIER_MODEL
  FUSION_ROUTER=heuristic                       Route without the router model call
  FUSION_GATEWAY_TOKEN                          Require this token from gateway clients
  FUSION_REFUSAL_FALLBACK=1                     Add server-side refusal fallback to Fusion's solver calls`;

const env = process.env;

function config(overrides: { objective?: Objective; pattern?: Pattern | 'auto' } = {}): FusionConfig {
  return resolveConfig({
    objective: (overrides.objective ?? env.FUSION_OBJECTIVE ?? 'balanced') as Objective,
    pool: {
      fast: env.FUSION_FAST_MODEL || undefined,
      balanced: env.FUSION_BALANCED_MODEL || undefined,
      frontier: env.FUSION_FRONTIER_MODEL || undefined,
    },
    router: { mode: env.FUSION_ROUTER === 'heuristic' ? 'heuristic' : 'model', model: env.FUSION_FAST_MODEL || undefined },
    forcePattern: overrides.pattern ?? 'auto',
  });
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

const logger = (verbose: boolean): Logger => ({
  info: (m) => verbose && console.error(dim(m)),
  warn: (m) => console.error(dim(`warn: ${m}`)),
  error: (m) => console.error(`error: ${m}`),
});

function runtime(cfg: FusionConfig, verbose: boolean) {
  const apiKey = env.FUSION_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  return createRuntime({
    config: () => cfg,
    credentials: () => (apiKey ? { apiKey } : undefined),
    allowDefaultCredentials: !apiKey,
    upstreamURL: env.FUSION_UPSTREAM_URL || DEFAULT_UPSTREAM,
    log: logger(verbose),
  });
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      objective: { type: 'string' },
      pattern: { type: 'string' },
      agentic: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (values.version) {
    console.log(version);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }

  const objective = values.objective as Objective | undefined;
  if (objective && !['fast', 'balanced', 'quality'].includes(objective)) throw new Error(`unknown objective "${objective}"`);
  const pattern = values.pattern as Pattern | undefined;
  if (pattern && !['single', 'cascade', 'critique'].includes(pattern)) throw new Error(`unknown pattern "${pattern}"`);
  const cfg = config({ objective, pattern });
  const { registry, orchestrator } = runtime(cfg, values.verbose || command === 'gateway');
  const problems = validateConfig(cfg, registry);
  if (problems.length) throw new Error(problems.join('; '));

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  switch (command) {
    case 'models': {
      for (const tier of ['fast', 'balanced', 'frontier'] as const) console.log(`${tier.padEnd(9)} ${cfg.pool[tier]}`);
      console.log('');
      for (const m of ANTHROPIC_MODELS) {
        const p = m.pricing!;
        console.log(`${m.id.padEnd(20)} $${p.input}/$${p.output} per MTok · cache read $${p.cacheRead.toFixed(3)} · ${m.contextWindow / 1000}K context`);
      }
      return 0;
    }

    case 'route': {
      const prompt = rest.join(' ').trim();
      if (!prompt) throw new Error('usage: fusion route "<prompt>"');
      const tools = values.agentic ? [{ name: 'run_in_terminal', description: 'Run a shell command', input_schema: { type: 'object' as const } }] : [];
      const { taskId, decision, plan } = await orchestrator.preview({
        messages: [{ role: 'user', content: prompt }],
        tools,
        objective: objective ?? cfg.objective,
        signal: controller.signal,
      });
      console.log(`difficulty ${decision.difficulty} · risk ${decision.risk} · signals ${JSON.stringify(decision.signals)}${decision.needsReview ? ' · review recommended' : ''}`);
      console.log(`${decision.source}: ${decision.rationale}`);
      console.log(`plan: ${plan.reason}`);
      console.log(dim(`router cost ${formatUsd(orchestrator.ledger.get(taskId)?.costUsd ?? 0)}`));
      return 0;
    }

    case 'ask': {
      const prompt = rest.join(' ').trim();
      if (!prompt) throw new Error('usage: fusion ask "<prompt>"');
      let inText = false;
      const sink: TurnSink = {
        event: (e) => {
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            process.stdout.write(e.delta.text);
            inText = true;
          }
        },
        progress: (p) => {
          if (p.stage !== 'done') console.error(dim(`· ${p.stage}${p.model ? ` (${registry.short(p.model)})` : ''}`));
        },
      };
      const outcome = await orchestrator.handleTurn(
        {
          system: [],
          messages: [{ role: 'user', content: prompt }],
          tools: [],
          objective: objective ?? cfg.objective,
          restoreAssistantBlocks: false,
          signal: controller.signal,
        },
        sink,
      );
      if (inText) process.stdout.write('\n');
      const task = orchestrator.ledger.get(outcome.taskId)!;
      console.error(`\n${dim(textReport(task, registry))}`);
      console.error(dim(oneLineSummary(task, registry)));
      return 0;
    }

    case 'gateway': {
      const gateway = new Gateway({
        orchestrator,
        port: values.port ? Number(values.port) : Number(env.FUSION_PORT) || DEFAULT_PORT,
        host: values.host ?? '127.0.0.1',
        upstreamURL: env.FUSION_UPSTREAM_URL || DEFAULT_UPSTREAM,
        defaultCredentials: () => {
          const apiKey = env.FUSION_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
          return apiKey ? { apiKey } : undefined;
        },
        token: env.FUSION_GATEWAY_TOKEN || undefined,
        defaultObjective: () => cfg.objective,
        countTokensModel: () => cfg.pool.balanced,
        refusalFallback: env.FUSION_REFUSAL_FALLBACK === '1',
        log: logger(true),
      });
      const address = await gateway.start();
      console.error(`Fusion gateway listening on ${address}`);
      console.error(`Models: fusion, fusion-fast, fusion-quality (anything else is passed through to ${env.FUSION_UPSTREAM_URL || DEFAULT_UPSTREAM})`);
      orchestrator.ledger.onChange((task) => {
        if (task.final) console.error(dim(`[${task.taskId}] ${oneLineSummary(task, registry)}`));
      });
      await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
      await gateway.stop();
      return 0;
    }

    default:
      console.error(`unknown command "${command}"\n`);
      console.log(HELP);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`fusion: ${errorMessage(err)}`);
    process.exitCode = 1;
  },
);
