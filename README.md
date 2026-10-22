<p align="center"><img src="media/icon.png" width="96" alt="Fusion"></p>

# Fusion

**Pick “Fusion (multi model)” in your model picker, and each task runs on the cheapest Claude workflow likely to get it right.**

Fusion is a multi-model orchestrator for Claude. A fast router reads each new task and chooses between Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5, and between three workflows: one model answering directly, a cheap draft checked by a quality gate, or a draft reviewed by an independent critic and revised once. You see one answer. Drafts that were rejected or revised never reach your chat.

It works in two places:

- **VS Code chat:** "Fusion (multi model)" appears in the chat model picker, next to the other models.
- **Claude Code:** a local Anthropic-compatible gateway adds "Fusion (multi model)" to Claude Code's model menu, in the VS Code extension or the CLI.

Fusion is inspired by GitHub's [Project HydraFusion](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) research preview. It is an independent project, not affiliated with GitHub or Microsoft, and it has not been benchmarked. The figures in that post describe GitHub's system, not this one.

## How a task runs

For each new request, a router (Haiku 5.5 at low effort) rates the request's difficulty, risk and four capability signals: reasoning, code generation, debugging and tool use. A greeting or a one-line question skips this call. Fusion then runs one of three workflows:

| Workflow | What happens |
| --- | --- |
| **Single** | One model answers directly, streamed live. |
| **Cascade** | An efficient model does the work. Its tool calls stream to you live. Its final answer is held for a **quality gate**, which reads your request, a condensed log of what was done, and the proposed answer. If the gate accepts, you get the answer. If it rejects, a stronger model takes over the conversation from where it stands, with the gate's reasons, fixes what's wrong and answers. |
| **Critique** | The drafter's final answer is held for an **independent, read-only reviewer** (a "rubber duck" with no tools). If the reviewer finds substantive issues, the drafter revises once, using tools if it needs to. The revised answer is what you get. |

The default policy (objective: balanced):

| The router says | Workflow | Models (effort) |
| --- | --- | --- |
| trivial | single | Haiku 5.5 (low) |
| easy | cascade | Haiku 5.5 (medium) drafts → Sonnet 5.5 (low) gates → Sonnet 5.5 (medium) takes over if rejected |
| easy, chat only (no tools) | single | Haiku 5.5 (medium) |
| medium | cascade | Sonnet 5.5 (medium) drafts → Opus 5.5 (low) gates → Opus 5.5 (high) takes over if rejected |
| medium, mostly debugging or reasoning | critique | Sonnet 5.5 (high) drafts, Opus 5.5 (medium) reviews |
| hard | critique | Opus 5.5 (high) drafts, Sonnet 5.5 (medium) reviews |

High-risk tasks (data loss, security, deployments, migrations) are treated one level harder. **Fusion Fast** shifts the table toward speed and cost: Haiku answers easy tasks on its own. **Fusion Quality** shifts it toward quality: no Haiku drafts, and more review. The table is in [`src/core/policy.ts`](src/core/policy.ts).

In VS Code each final answer ends with a one-line summary of what happened (it can be turned off):

```
Fusion · cascade · escalated to Sonnet 5.5: Claims tests pass but none were run · 5 calls · $0.0412 · 38.2s
```

## Use it in VS Code chat

You need VS Code 1.104 or later with chat enabled, and an Anthropic API key. Fusion calls the Claude API with your key, so usage is billed to your API account.

1. Download `fusion-<version>.vsix` from [Releases](../../releases), then run `code --install-extension fusion-0.1.0.vsix` (or use **Extensions → … → Install from VSIX**).
2. Run **Fusion: Set Anthropic API Key** from the command palette. The key is kept in VS Code's secret storage. If you skip this, Fusion asks for the key the first time you use it.
3. In the chat view, open the model picker and choose **Fusion (multi model)**. **Fusion Fast** and **Fusion Quality** are also listed. If Fusion isn't listed, open **Manage Models** from the picker and enable it.

Fusion works in agent mode with the editor's tools. Tool calls are only handed to VS Code once a step has completed, so a failed or cut-off step never leaves a half-made edit. The status bar shows what Fusion is doing ("drafting · Haiku 5.5", "checking · Sonnet 5.5") and the session's estimated spend. Click it for the menu. **Fusion: Show Last Workflow** opens a per-call breakdown of the last task: models, effort, tokens, cost, latency, and the router's reasoning.

## Use it in Claude Code

Claude Code speaks the Anthropic Messages API, so Fusion includes a small local gateway. Requests for `fusion`, `fusion-fast` and `fusion-quality` go through Fusion. Requests for any other model are passed through unchanged, so your usual models keep working through the same URL.

**From VS Code (recommended):** run **Fusion: Use Fusion in Claude Code…** and choose **Claude Code in VS Code**. Fusion adds the following to the `claudeCode.environmentVariables` setting, then starts the gateway inside VS Code:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:4545
ANTHROPIC_CUSTOM_MODEL_OPTION=fusion
ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=Fusion (multi model)
ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION=Routes each task across Haiku, Sonnet and Opus
CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
```

Start a new Claude Code session and pick **Fusion (multi model)** from the model menu, or type `/model fusion`. The same command can remove these entries again.

**From a terminal:** run the gateway yourself and add the same variables to the `env` block of `~/.claude/settings.json`:

```bash
git clone https://github.com/KyleSau/fusion && cd fusion && npm install
ANTHROPIC_API_KEY=sk-ant-... node dist/cli.js gateway        # listens on 127.0.0.1:4545
```

How the gateway treats Claude Code:

- **Credentials.** Fusion's own calls use your Anthropic API key. If you log in to Claude Code with a Claude subscription, that login still covers every non-Fusion model you pick. Fusion never uses it for its own calls.
- **Wire format.** It keeps Claude Code's prompt caching, betas, `context_management` and thinking blocks. Upstream errors are forwarded unchanged, so Claude Code's own retries still work.
- **Background requests.** Claude Code's background requests (titles, summaries) go straight to Haiku without routing.
- **Context window.** Claude Code doesn't know the `fusion` model id, so it assumes a 200K context window and 32K output tokens. See [Claude Code's model configuration](https://code.claude.com/docs/en/model-config) to change that.
- **When the gateway is down.** If `ANTHROPIC_BASE_URL` points at the gateway and the gateway isn't running, Claude Code can't connect. That's why the VS Code-only setup is the default.

## Command line

```bash
node dist/cli.js ask "Why does my React effect run twice?"     # run one request, print the answer and the per-call breakdown
node dist/cli.js route "Migrate the billing tables to the new schema" --agentic   # show the plan without running it
node dist/cli.js models                                          # model pool and prices
node dist/cli.js gateway --port 4545                             # Anthropic-compatible endpoint
```

`npm install -g .` installs it as `fusion`.

## Configuration

VS Code settings (`fusion.*`):

| Setting | Default | |
| --- | --- | --- |
| `fusion.objective` | `balanced` | Objective for **Fusion (multi model)** and the gateway's `fusion` id: `fast`, `balanced` or `quality`. |
| `fusion.models.fast` / `.balanced` / `.frontier` | Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | Model for each tier. Any Anthropic model id, or `vscode:<vendor>/<id>` for a model another VS Code extension provides. |
| `fusion.models.critic` | (policy default) | Reviewer for the critique workflow. A model from another family gives the most independent review. |
| `fusion.router.mode` | `model` | `heuristic` routes with keyword and shape rules only, with no extra call. |
| `fusion.forcePattern` | `auto` | Force `single`, `cascade` or `critique`, for comparing workflows. |
| `fusion.gate.threshold` | `0.6` | Minimum gate confidence for a draft to ship. |
| `fusion.cascade.maxDraftSteps` | `40` | A drafter still working after this many tool steps hands the task over. |
| `fusion.budget.maxTaskUsd` | `5` | Once a task has cost this much, the gate, review and escalation steps are skipped. Calls that do the actual work are never cut off. |
| `fusion.showSummary` | `true` | The one-line summary under each final answer. |
| `fusion.progressUpdates` | `true` | Short progress notes before tool calls (Opus and Sonnet 5.5 return them as thinking summaries). |
| `fusion.refusalFallback` | `true` | Server-side refusal fallback on Opus and Sonnet calls, so a safety-classifier false positive is retried on another model instead of failing. |
| `fusion.maxInputTokens` | `200000` | Context window reported to VS Code. |
| `fusion.gateway.autoStart` / `.port` | `false` / `4545` | Run the gateway inside VS Code. It listens on 127.0.0.1 only. |

CLI and gateway: `ANTHROPIC_API_KEY` (or `FUSION_ANTHROPIC_API_KEY`), `FUSION_OBJECTIVE`, `FUSION_FAST_MODEL`, `FUSION_BALANCED_MODEL`, `FUSION_FRONTIER_MODEL`, `FUSION_ROUTER=heuristic`, `FUSION_GATEWAY_TOKEN` (require a token from clients), `FUSION_UPSTREAM_URL`, `FUSION_REFUSAL_FALLBACK=1`.

## Design principles

| Principle | In Fusion |
| --- | --- |
| Complete accounting | Every call is recorded with its role, model, effort, tokens, estimated cost (at list prices, cache reads and writes included) and latency. That covers routing, drafts, gate checks, reviews, revisions, escalations and fallbacks. See **Show Last Workflow**, or `GET /fusion/stats` on the gateway. |
| Bounded execution | Router, gate and critic calls have timeouts. Every call is cancelled with the request. A per-task budget caps the optional steps. |
| Isolated review | The gate and the critic run in fresh, tool-less contexts on a condensed transcript, so they cannot touch your workspace. |
| Fail-safe application | Held drafts never reach the client. Tool calls are released only when a step completes. A call that fails before anything has been streamed falls back to the neighbouring tier. |
| Validated routing | Every model in a plan is checked before the task starts. A missing tier is replaced by the nearest available one, and the plan says so. |

Fusion also keeps every conversation **append-only**, as the 5.5-generation models require. They bind thinking blocks to the exact conversation that produced them, and prompt caching depends on the same thing. Fusion's hand-off and review notes go in as mid-conversation system messages and are replayed in place on every later request. In VS Code, the original thinking blocks are restored on each step, because VS Code doesn't store them. [docs/how-it-works.md](docs/how-it-works.md) covers this and the rest of the design.

## Limits worth knowing

- **No benchmarks yet.** The policy table is a reasonable starting point, not a tuned one. To compare workflows on your own work, use `fusion.forcePattern` and **Show Last Workflow**.
- **An escalation costs one uncached read.** Prompt caches are per model, so a handover re-reads the conversation once without the cache. Otherwise a task stays on one model.
- **Held answers add latency.** Tool steps stream live, but a gated or reviewed final answer appears only after the check.
- **The critic shares a family by default.** It uses a different Claude tier, not a different model family. HydraFusion uses a critic from a different family; set `fusion.models.critic` to a model another extension provides to get one.
- **No thinking display in VS Code.** VS Code's public chat API doesn't let a third-party model show thinking, so Fusion reports progress in the status bar and, optionally, as short notes before tool calls.

## Development

```bash
npm install          # also builds dist/
npm test             # unit tests plus end-to-end gateway tests against a mock Anthropic API
npm run typecheck
npm run package      # builds fusion-<version>.vsix
```

## License

MIT
