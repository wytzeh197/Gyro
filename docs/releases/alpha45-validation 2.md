# Alpha 45 validation

Measured September 5, 2026 on an Apple M1 Mac. These are representative samples,
not a guarantee for every workspace or model.

## Performance

Optimized desktop bundle built from the release worktree. Verified executable:
`target/release/bundle/macos/Gyro.app/Contents/MacOS/gyro-desktop`, PID 49070,
owning the Gyro IPC socket. Included the four WebKit processes created with
that app; excluded older WebKit processes present before launch.

| Scenario                                       | Sample | Average CPU | Peak sampled CPU | Peak RSS |
| ---------------------------------------------- | ------ | ----------- | ---------------- | -------- |
| Completed conversation idle                    | 29.3 s | 0.99%       | 8.1%             | 262 MiB  |
| Explorer, editor, diff open/navigation/refresh | 29.4 s | 4.73%       | 60.3%            | 360 MiB  |

Average CPU is cumulative process CPU time divided by elapsed wall time; 100%
means one fully occupied core. Peak CPU is the sum of `ps` samples. RSS is summed
resident memory, which can count shared pages more than once. These samples
exclude external provider inference, build tools, and short-lived Git commands.
No sustained one-core saturation appeared in these samples. Large model inference
can independently use substantial CPU/GPU and memory.

Scheduling tests exercise actual app hooks with delayed RPCs: 100 simultaneous
Git refresh requests produce one in-flight operation and one follow-up; errors
release the guard, stale workspace responses stay hidden, and delayed Ollama
discovery does not block startup or overwrite newer preferences.

## Provider runtime

Fresh CLI chats used a temporary empty repository and a no-tools/no-edit prompt.
All returned the requested marker (the small local model wrapped it in Markdown).

| Provider | Duration | Exit code |
| -------- | -------- | --------- |
| codex    | 4780 ms  | 0         |
| claude   | 5841 ms  | 0         |
| kimi     | 6025 ms  | 0         |
| grok     | 4812 ms  | 0         |
| ollama   | 3573 ms  | 0         |

Codex was tested with `gpt-5.6-sol`. An earlier attempt inherited a locally
configured `gpt-6-astra` model and the upstream service rejected that installed
CLI version; the supported explicit model succeeded. Gemini was not installed
or authenticated on this Mac, so no live Gemini success is claimed. Its shared
ACP adapter is covered by fake-provider protocol and approval tests.

## Local models

Started the installed Ollama service and pulled `qwen3:0.6b` from its official
registry (522 MB). CLI inference succeeded. In the optimized desktop, a temporary
alias added after startup appeared through Refresh models and could be selected.
The alias was then removed and the original model restored. A desktop chat
exposed colon-tag truncation in model-menu actions; the parser was fixed and
regression cases cover tags and namespaced models. The final rebuilt desktop
then preserved `qwen3:0.6b` when selected and displayed
`GYRO_DESKTOP_LOCAL_READY` after six seconds, with no tool calls or file edits.

## Provider security

Scoped source audit covered provider integration, credential filtering/storage,
subprocess execution, Ollama endpoints, and relevant desktop/CLI consumers.
It identified two medium-severity broker-boundary issues, repaired before release:

- ACP write approval now binds the actual path and body to the mutation transaction.
  Regression tests verify rejection, distinct approval records, plan-mode rejection,
  and single application of the approved transaction.
- Direct ACP reads reject sensitive paths, including symlink aliases, and point
  providers to governed workspace tools. Native external CLI tools remain outside
  an OS filesystem sandbox; this release does not claim to sandbox them.

ACP output is also bounded before allocation, including newline-free frames.
Ollama uses loopback HTTP only and refuses redirects. Inference has a longer
bounded timeout than readiness probes; a delayed-response test exceeds the former
five-second limit and succeeds.

## Automated gates

Frontend reliability, type checks, workbench/UI smoke, Explorer, syntax, source
control lifecycle, release configuration, doctor, CLI archive verification and
site checks passed during preparation. The full Rust suite after the ACP output
race repair passed 543 tests; four existing desktop tests were ignored. Runtime
and release publication completion are recorded in the final release verification.
