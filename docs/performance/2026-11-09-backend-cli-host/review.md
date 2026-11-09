# Run CLI providers through the shared core adapters

The CLI previously maintained its own native provider loops and could diverge
from desktop execution, tool policy and resume behaviour. Route execution through
`gyro-core::provider_runtime` with a terminal host, remove the duplicate loops,
and retain explicit CLI protocol budgets, deadlines and acknowledged cursors.

The host supplies durable terminal approvals and guarded file application. API
and Ollama runners receive a bounded workspace catalog with observed-hash writes;
GUI-only services remain desktop-owned. Claude permission prompts are relayed to
the foreground process so background MCP children do not read the terminal.
A failed Claude turn now retains only an acknowledged native session id, avoiding
unresumable bindings made from proposed UUIDs. Stale cursors are cleared with an
explicit retry request; tool turns are never automatically replayed.

Validation: locked workspace suite, desktop/CLI all-targets checks, original
zero-new-warning comparison, formatting, ratchets and diff checks pass. Native
PTY Codex, Claude and DeepSeek each passed exact edit/application, refusal, resume
and Ctrl-C. New binary API peers verify real tool use and cancellation. The
[acceptance record](README.md) retains the fixed Claude hang, an existing timing
assertion failure under concurrent load, model/task failures and setup blocks.

Available live CLI acceptance (Codex, Claude and DeepSeek) passed. Wytze confirmed
on 2026-11-09 that Kimi/Antigravity access and a downloaded Ollama model are
unavailable, with no budget or disk space to add them. These providers are outside
the current acceptance scope; no purchase, setup or download is required. Earlier
failed probes remain historical evidence, not setup blockers. The desktop recheck
passed Codex/Claude; DeepSeek's fresh wrong-path failure is retained. No live
coverage of unavailable providers, installed-app/frontend or clean-machine
acceptance is claimed. No new dependencies or crate were introduced.

Local review base: `3117971e`. Keep this behaviour change separate from the
preceding provider moves and the subsequent crate/measurement decision. No push
or remote PR has been performed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
