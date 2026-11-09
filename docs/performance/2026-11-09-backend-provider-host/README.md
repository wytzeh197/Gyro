# Provider host extraction: native acceptance evidence

These bounded runs used the real debug desktop chat command, AppHandle, capability broker, run lease, cancellation and provider processes. Each process used its own temporary data store and disposable git workspaces. Launch PIDs and executable paths were checked with `ps` and recorded in `launches.json`. The installed app and its chat store were not changed. Frontend rendering and window interaction were not measured.

`all-hosts/` was built after all six runners switched to `RunnerHost` and the temporary legacy dispatcher was removed. Earlier cohorts retain the original failures for comparison. Each task includes a fresh turn and a separate session with a bootstrap turn followed by a resumed request. API runners use local conversation history rather than a native provider cursor, so `resumedActual: false` is expected for them.

| Provider | Observed result | Remaining acceptance limitation |
| --- | --- | --- |
| Codex | `core-reviewed`: fresh and resumed code tasks passed with two applied task-file proposals each; native resume confirmed. | Earlier append-only follow-ups changed repeated README content; retained as failed evidence. Extra compaction/MCP checks remain open. |
| Claude | `core-reviewed`: fresh and resumed code tasks passed with two native Edit approvals each; native resume confirmed. | `core-before-review` timed out waiting for native approval. The opt-in fixture reviewer now uses the real resolver. |
| DeepSeek | `core-reviewed`: fresh and local-history follow-up code tasks passed with two applied task-file proposals each. | The earlier core follow-up finished the edits but timed out on a read-only diff approval; retained as failed evidence. |
| Kimi | ACP process started and reported an MCP configuration rejection. | Installed `~/.kimi-code/bin/kimi` rejects a stdio entry without a runtime identity. Its bundled ACP converter accepts HTTP/SSE entries and drops other declared transports. The port preserves the existing stdio bridge; no provider protocol workaround was introduced. |
| Antigravity | `agy` started and returned its sign-in hint. | Google sign-in is required. Headless `agy` has no per-call approval dialog; its supported execution posture must be checked instead. |
| Ollama | Local daemon and installed `qwen3:0.6b` were reached. | Fresh run returned invalid tool arguments after its corrective retry; follow-up returned a response but failed the edit check. No model was downloaded or replaced. |

The live matrix is **partial**, not a passed Phase 2 acceptance gate. Successful process completion is not treated as task correctness or approval coverage. Reports contain generated fixture session identifiers and bounded, redacted failure details; credentials and native process logs are excluded.

The fixture harness now accepts `requireFileEditApproval: true` only together with `reviewFixtureEdits: true`, binds it to the isolated config, records the posture, and rejects resuming evidence under a different posture. Existing specs retain their previous default. The append instruction explicitly excludes trailing punctuation; the strict file verifier was not relaxed.

Automated validation of the completed port: locked all-targets desktop check with zero new warnings; 1,021 desktop tests passed, 12 ignored; workspace tests passed; formatting and architecture boundary checks passed. Local commits repeat these checks for their own source snapshots. Live limitations remain open regardless of those automated results.

The `core-reviewed/` cohort used the shared Codex, Claude, ACP and Antigravity adapters in core, plus the desktop API loop. All six Codex/Claude/DeepSeek records completed and passed the unchanged code verifier (inclusive clamp bounds, one added regression test, successful `node --test`, and edits confined to the two task files). Native edit approvals were resolved only for existing allowed fixture files; optional inspection reviews allow only diff/status calls once. Creates, deletes, moves, command approvals, unrelated files and project grants remain outside this reviewer. This is opt-in debug harness behavior, not a chat approval-policy change. The isolated run did not measure frontend interaction.

Automated reviewer checkpoint `81e1d83d`: 1,007 desktop tests passed (12 ignored), 1,002 core tests passed (2 ignored), locked all-targets check with zero new warnings, formatting and architecture checks passed.

The `all-core-runners/` cohort repeats all six code-task records after the API/Ollama loops, context policy and registry also moved to core. All six completed and passed task correctness with applied task-file approvals. Codex/Claude again reported actual native resume; the API follow-up used local history. The full workspace suite passed for this snapshot, including 1,004 desktop tests (12 ignored) and 1,005 core tests (2 ignored). No new compiler warnings were introduced. Kimi/Antigravity/Ollama and additional Codex compaction acceptance limitations above still apply.
