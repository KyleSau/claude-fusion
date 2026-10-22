import { AnthropicBackend, type AnthropicCredentials } from './backends/anthropic';
import type { Backend } from './core/backend';
import type { FusionConfig } from './core/config';
import { ModelRegistry } from './core/models';
import { Orchestrator, type Logger } from './core/orchestrator';
import { DEFAULT_UPSTREAM, inboundCredentials } from './gateway/server';

export interface RuntimeOptions {
  config: () => FusionConfig;
  /** Fusion's own Anthropic credentials. */
  credentials: () => AnthropicCredentials | undefined;
  /** Let the SDK find credentials on its own (env vars, `ant auth login`) when none are configured. */
  allowDefaultCredentials?: boolean;
  upstreamURL?: string;
  /** SDK-level retries per call (default 2). */
  maxRetries?: number;
  registry?: ModelRegistry;
  extraBackends?: Backend[];
  log: Logger;
}

/** Wires the model registry, backends and orchestrator together (shared by the CLI and the extension). */
export function createRuntime(opts: RuntimeOptions) {
  const registry = opts.registry ?? new ModelRegistry();
  const anthropic = new AnthropicBackend(
    {
      // Inside a gateway request, credentials chosen for that request win.
      credentials: () => inboundCredentials.getStore() ?? opts.credentials(),
      baseURL: opts.upstreamURL ?? DEFAULT_UPSTREAM,
      allowDefaultCredentials: opts.allowDefaultCredentials,
      maxRetries: opts.maxRetries,
    },
    registry,
  );
  const orchestrator = new Orchestrator({
    registry,
    backends: [anthropic, ...(opts.extraBackends ?? [])],
    config: opts.config,
    log: opts.log,
  });
  return { registry, anthropic, orchestrator };
}
