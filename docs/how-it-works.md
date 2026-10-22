# How Fusion works

This document is for people changing Fusion or debugging it. For setup and usage, see the [README](../README.md).

## Where Fusion sits

Fusion does not run its own agent loop. The client does: VS Code's chat agent, or Claude Code. On each step the client sends the full conversation plus its tool definitions, and expects one assistant message back. That message is either text or tool calls, and the client executes any tool calls itself. Fusion answers each of those calls, so a "task" (everything that follows one user request) spans many calls. The workflow state lives in `SessionStore` (`src/core/sessions.ts`) between them.

```
client ──step──▶ Orchestrator.handleTurn ──▶ router (new task only) ──▶ policy ──▶ plan
                         │                                                  │
                         └──── solver / gate / critic calls through a Backend ◀┘
```

- **New task or continuation?** If the request ends with tool results, Fusion fingerprints the assistant turn those results answer (by its tool-call ids) and looks up the task that produced it. Any other request starts a new task. A new task gets a routing decision and a plan.
- **The plan is sticky.** A task keeps its solver model across steps (the "active" model), which keeps that model's prompt cache warm. It changes only when a cascade escalates.

## The three workflows

`Orchestrator.step` dispatches on the plan's pattern.

**Single.** A live call to the solver: events are streamed to the client as they arrive.

**Cascade.** The drafter runs in *speculative* mode. Its events are held until the step either:

- starts a `tool_use` block, which makes it a working step: everything held is flushed and the rest streams live; or
- ends without one, which makes it a final answer: nothing has been sent yet, so the gate can still decide.

The gate gets a condensed view of the task (`condenseWork` in `src/core/transcript.ts`): the request, any context the client wrapped around it, a numbered log of tool calls and truncated results, and the proposed answer. It returns `{issues, confidence, accept}`. If it accepts with enough confidence, the held events are replayed to the client. If not, the task escalates. The stronger model becomes the active model, and an orchestrator note goes at the end of the conversation with the gate's reasons and the rejected draft. The stronger model continues from the current state, tools and all. Escalation also happens when the drafter declines, hits the output limit, produces nothing, keeps calling tools past `cascade.maxDraftSteps`, or fails with a transient error.

**Critique.** The drafter's final answer is held the same way. The critic sees the same condensed view and returns issues with severities. Issues at or above `critique.minSeverity` trigger exactly one revision: a note with the issues and the draft is appended, and the drafter continues live. It may use tools, and whatever it ends with is delivered without another review.

The gate and the critic are tool-less, structured-output calls (`Backend.json`). They cannot change anything in the workspace. If one fails, the result depends on configuration: a failed gate escalates by default (`gate.onError`), and a failed critic means the draft ships.

## Routing

`Router.decide` (`src/core/router.ts`):

1. Extracts features from the request (`src/core/signals.ts`): length, code blocks, stack traces, whether tools are available, keyword counts, and "quick" or "think hard" hints. Copilot's `<userRequest>` wrapper and Claude Code's `<system-reminder>` blocks are separated from the request text.
2. Skips the model call for plainly trivial requests (greetings, short plain questions) and for requests the client marks as auxiliary.
3. Otherwise asks the router model for `{difficulty, reasoning, codegen, debugging, toolUse, risk, needsReview, rationale}`.

Structured outputs enforce only types, so the allowed values are given as descriptions and mapped afterwards (`normalizeRoute`). On any failure the router falls back to heuristics.

`planFor` (`src/core/policy.ts`) turns the decision into a plan using the table for the chosen objective. It then validates every model in the plan against the registry and the backends. A missing model is replaced by the nearest available tier, preferring the stronger one on ties, and the substitution is recorded in the plan's `reason`.

## Keeping conversations append-only

Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking block to the conversation that produced it: the system prompt, the tool set and every earlier message. If any of that changes, the API drops the block or rejects the request, and the prompt cache misses. Fusion edits conversations in two ways, and both are made replayable:

- **Orchestrator notes** (hand-offs and critiques) are mid-conversation `role: "system"` messages appended after the last user turn. Claude Code ends a conversation's first request with its own system message. In that case the note is added as an extra text block on that message (`appendNote`). Each note is recorded against the assistant turn generated right after it. When the client replays history, `SessionStore.restore` puts the note back in exactly the same place.
- **Thinking blocks in VS Code.** VS Code stores only text and tool calls for third-party models. Fusion records the exact blocks each step returned, including thinking blocks and their signatures. On the next step it swaps the client's copy of that turn for the original. The record is keyed by tool-call ids, or by a hash of the text with Fusion's summary footer removed.

As a safety net, solver calls send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` unless the client chose a value. If Fusion loses its in-memory records (a restart), history that no longer matches then costs the old reasoning rather than failing the request. Switching models (an escalation, or a fallback) never edits history. The API leaves out blocks the new model can't read, and Fusion passes everything through unchanged.

## Backends

- `AnthropicBackend` (`src/backends/anthropic.ts`) uses the official SDK. Solver steps are streamed with adaptive thinking and the planned `output_config.effort`. Fusion adds two cache breakpoints (the last system block, plus automatic caching of the conversation tail) only when the client set none. Forced `tool_choice` is mapped to `auto`, since the 5.5 models reject forced tool use. Sampling parameters are dropped. Client `oauth-*` betas are removed from Fusion's own calls, and per-message effort settings are stripped consistently on every request. `fallbacks: "default"` is added for Opus and Sonnet when enabled and when the request shape allows it.
- `VsCodeLmBackend` (`src/extension/vscodeBackend.ts`) uses models other VS Code extensions provide (`vscode:<vendor>/<id>`). It has no system role and no thinking, so notes become user text. Usage is estimated and not priced.

## Accounting

Every call becomes a `Leg` in the `Ledger`: role, model, effort, outcome, latency, tokens, and cost at list prices. Cache reads and both cache-write TTLs are priced separately, Haiku 5.5's second rate card applies above 100K prompt tokens, and each attempt of a server-side fallback is billed at its own model's rate. The VS Code footer, the status bar, **Show Last Workflow**, the gateway's `/fusion/stats` and the CLI's `ask` summary all read from the ledger.

## The gateway

`src/gateway/server.ts` serves:

- `POST /v1/messages` (with or without `?beta=true`)
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `HEAD /api/hello`
- `GET /fusion/stats`

Requests for `fusion*` models go through the orchestrator. Everything else is proxied: the request body and headers are forwarded unchanged, and the upstream response is piped back byte-for-byte, including SSE pings.

For `fusion*` streaming requests, HTTP headers are sent only when the first upstream event arrives. An error before that point is returned with the upstream status and body unchanged, which clients use to decide whether to retry. While a draft or a final answer is held, the gateway sends SSE `ping` events every few seconds, so clients that watch for stalled streams keep waiting.

Fusion's own calls use the configured API key. An inbound API key is used only when none is configured. An inbound OAuth token (a claude.ai login) is forwarded for pass-through requests only.

## Testing

`npm test` covers:

- the policy table, routing heuristics and pricing;
- the orchestrator's workflows across multi-step tool loops, with a scripted fake backend: escalation with note replay, revision, fallback, cancellation and budgets;
- the Anthropic request shape;
- VS Code message conversion;
- end-to-end gateway runs with the official SDK client against a mock Anthropic API (`test/support/mock-upstream.mjs`).

The mock can also record what a real client sends. Run `node test/support/mock-upstream.mjs 4646 ./capture` and point a gateway at it with `FUSION_UPSTREAM_URL=http://127.0.0.1:4646`.
