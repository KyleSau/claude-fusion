# Changelog

## 0.1.0 — 2026-10-21

First release.

- "Fusion (multi model)", "Fusion Fast" and "Fusion Quality" in VS Code's chat model picker.
- Router plus policy table that choose single, cascade (quality gate, escalation) or critique (independent review, one revision) per task across Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5.
- Anthropic-compatible gateway so Claude Code can use Fusion from its model menu; other models pass through unchanged.
- `fusion` CLI: `ask`, `route`, `models`, `gateway`.
- Per-call accounting (tokens, estimated cost, latency), status bar, workflow report.
- Models provided by other VS Code extensions can join the pool (`vscode:<vendor>/<id>`).
