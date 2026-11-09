# Shared CLI provider host — Phase 3.3

Recorded 2026-11-09 on `Heads/v0.1.1`, based on `3117971e`.
This is a separate behaviour-change checkpoint. The remote PR has not been
created or pushed; the local review description is [review.md](review.md).

The CLI now calls the same `gyro-core::provider_runtime` registry and six actual
adapters as desktop. It no longer maintains separate Codex, Claude, ACP or Ollama
execution loops. The CLI host owns terminal output, private-store configuration,
durable events, deadlines/cancellation, acknowledged resume bindings and guarded
approvals. Claude usage accounting and adapter metadata are also shared.

The headless API/Ollama catalog exposes workspace list, bounded UTF-8 read/range,
and reviewed file proposals. Reads open every component relative to a workspace
descriptor without following symlinks. Existing-file writes require the observed
content hash and use the core mutation journal. Private data, sensitive paths,
unsupported capabilities and writes in plan/council mode fail closed. Spill
recovery accepts only bounded text this host observed during this turn. Native
adapters retain their provider-native tools and actual approval bridges.

Desktop browser, IDE, delegation, attachment ingestion and image storage services
are not provided by the CLI. They are not advertised as headless tools; Codex image
generation is disabled for this host. Non-Unix platforms do not advertise the
new descriptor-based file tools. Platform-native acceptance was performed on macOS.

## Verification

The locked full workspace suite passed with four test threads: desktop 993 tests
(12 ignored), core 1,019 (2 ignored), CLI 43 unit / 25 exit-code / 1 installation /
2 shared-API binary tests, plus core integration and doc targets. Two live Ollama
integration tests remain ignored. Eleven existing Claude accounting tests moved
from desktop to core; falling desktop counts reflect that move.

Locked desktop all-targets checking reports zero errors and zero new warnings
against the original warning keys. CLI all-targets checking is warning-free.
Formatting, architecture ratchets and diff checks pass. The CLI root ceiling fell
from 7,367 to 5,602 lines; desktop `lib.rs` remains 122 lines.

The API binary checks use a real local SSE endpoint to verify edits, refusal and
Ctrl-C, rather than substituting runner results. Host tests cover exact observed
hashes, durable application, stale proposals, cancellation, workspace/session
ownership, symlinks, sensitive paths, bounded reads and private spill ownership.

The live Claude test exposed a background-terminal read hang in its MCP permission
helper. The fix relays only the prompt/answer over a private bounded Unix socket to
the foreground host; the existing helper still records and applies the decision.
Tests cover accept/deny, foreign owners and termination during unanswered input.
The subsequent complete real Claude cohort passed. The original timeout remains
in the evidence. A separate earlier default-concurrency test run hit an existing
Ollama deadline timing assertion while live providers ran; the unchanged complete
suite then passed with the required four threads. No threshold was relaxed.

## Real terminal acceptance

Each cohort launched the actual `target/debug/gyro` under a controlling PTY,
verified its executable by PID, and used a disposable workspace and private Gyro
store. Existing provider-owned sign-in was retained. Only the selected API key was
passed in memory to the child environment; credentials, raw terminal transcripts
and provider conversations are excluded from these artifacts. Installed apps and
real Gyro stores were not modified.

Accept requires exact file bytes plus an applied approval record. Deny requires
an actual refusal and unchanged bytes. Resume requires the exact remembered
keyword and a reported resume. Cancellation requires Ctrl-C and exit 130.
No commands or unrelated paths were approved; no project-wide grant was issued.

| Provider / selected model | Accept | Deny | Resume | Ctrl-C |
| --- | --- | --- | --- | --- |
| Codex / gpt-5.6-sol | pass | pass | native pass | pass |
| Claude / claude-sonnet-5, after relay fix | pass | pass | native pass | pass |
| DeepSeek / deepseek-flash | pass | pass | local-history pass | pass |
| Ollama / installed qwen3:0.6b | fail: no requested edit | fail: no approval request | local-history pass | pass |
| Installed Kimi / k3 | blocked: subscription HTTP 403 | not reached | not reached | not reached |
| Installed Antigravity | blocked: Google sign-in required | not reached | not reached | not reached |

The Ollama model's success text did not satisfy disk-truth verification. Kimi
reached its authentication/subscription check without the desktop's stdio MCP
entry, but its plan denied access. Antigravity's supported posture has no per-call
approval dialog; its sign-in and supported permission behaviour remain unverified.
No model was downloaded, binary switched, sign-in performed or bypass added.

A fresh desktop-host-defaults cohort passed both fresh/resumed code tasks for
Codex and Claude with task-file approvals. DeepSeek's fresh turn requested the
wrong test path and failed strict verification; its subsequent local-history turn
passed. This failure remains recorded, alongside earlier successful desktop
cohorts in [provider-host evidence](../2026-11-09-backend-provider-host/README.md).
The scoped reviewer and verifier were not relaxed. Frontend/window interaction
was not measured.

**Code and automated validation are complete; the full live-provider acceptance
gate is partial.** Kimi entitlement, Antigravity sign-in/posture, a tool-capable
Ollama setup, and strict desktop task reliability still require verification.
This checkpoint does not claim installed-app or clean-machine acceptance.

Artifacts: [terminal records](terminal-acceptance.json),
[desktop recheck](desktop-defaults-acceptance.json), [checks](validation.json).
Raw logs remain in the temporary roots named by the records.
