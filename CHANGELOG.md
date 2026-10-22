# Changelog

## 0.1.1 — 2026-10-21

- Gateway pass-through forwards the client's own headers (user agent, app and session ids, betas, auth) unchanged, so Claude Code's regular models behave exactly as without the gateway.
- The extension keeps the gateway running whenever Claude Code in VS Code is configured to use it.
- A missing API key is reported as a clear setup error instead of an authentication error that Claude Code would blame on its own login.

## 0.1.0 — 2026-10-21

First release.

- "Fusion (multi model)", "Fusion Fast" and "Fusion Quality" in VS Code's chat model picker.
- Router plus policy table that choose single, cascade (quality gate, escalation) or critique (independent review, one revision) per task across Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5.
- Anthropic-compatible gateway so Claude Code can use Fusion from its model menu; other models pass through unchanged.
- `fusion` CLI: `ask`, `route`, `models`, `gateway`.
- Per-call accounting (tokens, estimated cost, latency), status bar, workflow report.
- Models provided by other VS Code extensions can join the pool (`vscode:<vendor>/<id>`).
