# Agent execution boundaries

This describes the boundaries configured by Gyro's current source. It is not a
claim that every provider integration has passed native runtime acceptance.
Approval, credential filtering, workspace path checks, and an OS sandbox are
separate controls. A worktree provides a separate checkout, not process isolation.

## Execution matrix

| Execution path | What Gyro controls | Limit |
| --- | --- | --- |
| Codex app-server | `codex_app_server_policy` requests read-only or workspace-write with network access disabled; explicit Full access can select danger-full-access. | The provider enforces its native sandbox. This is not a Gyro-wide boundary for other execution paths. |
| Codex exec fallback | `codex_chat_args` selects read-only, including resumed runs; explicit Full access can bypass approvals and sandboxing. | Provider-native tools and Gyro capabilities use different execution paths. |
| Claude CLI | `claude_chat_args` configures Plan/default permissions and Gyro approval callbacks; explicit Full access can skip permissions. | This launch configuration does not explicitly enable Claude's native sandbox. Permissions alone do not establish filesystem or network confinement. |
| ACP providers | `run_kimi_acp_chat` passes workspace, mode, per-provider credential policy, and approval handling; `KimiAcpConnection::start` launches the provider process. | ACP permission requests depend on provider behavior. Gyro does not add an OS sandbox around this shared ACP launcher. |
| Direct API / Ollama | Model-requested Gyro tools cross the capability broker, including policy, approval, ownership checks, and recorded results. API keys are used by the host-side runner. | A tool's own execution path determines its confinement; the broker is not an OS sandbox. |
| Model terminal / background workspace task | The broker binds the PTY to its authoritative workspace, filters credentials, and selects the macOS workspace filesystem policy unless explicit Full access applies. Restart retains confinement, rechecks Full access, and gets fresh scratch space. | IP networking remains allowed. The selected policy is reported in pane results; sandbox setup failure never retries unrestricted. |
| Foreground model workspace task/test | The broker approves execution and revalidates the owning workspace. `run_model_task_output_with_cancellation` applies the same credential filtering and macOS filesystem policy as model terminals. | Explicit Full access can bypass the filesystem policy. Cancellation and output bounds still apply. |
| Human terminal / governed provider CLI pane | Human terminal launch behavior remains unchanged. Governed CLI panes receive Gyro's provider approval bridge. | These panes retain their environment; the model-command credential policy is not inferred from a pane name or renderer input. |

Sources: desktop [provider dispatch, launch arguments, policy, and capability
execution](../apps/desktop/src-tauri/src/lib.rs),
[PTY execution](../apps/desktop/src-tauri/src/terminal_process.rs),
[model-command policy selection](../apps/desktop/src-tauri/src/command_execution.rs),
[macOS filesystem wrapper](../crates/gyro-core/src/workspace_sandbox.rs),
[ACP launcher](../crates/gyro-core/src/kimi_acp.rs),
[direct API runner](../apps/desktop/src-tauri/src/openai_compatible_runner.rs),
[Ollama capability bridge](../apps/desktop/src-tauri/src/ollama_runner.rs), and
[worktree creation](../crates/gyro-core/src/worktrees.rs).

## Credential filtering scope

The existing [credential policy](../crates/gyro-core/src/credentials.rs) removes
environment variables whose names match known credential names or structural
patterns such as `TOKEN`, `SECRET`, `PASSWORD`, and `API_KEY`. Provider launches
retain the launched provider's own authentication variables and can receive a
Keychain-stored provider key. Those retained keys can reach provider descendants.

The shell-command change closes two separate inheritance paths: final PTY
environments and foreground model task commands. It inspects inherited variables
and explicit command overrides, so a secret-shaped override cannot accidentally
restore a removed variable. Neither path needs provider credentials merely
because a model requested the command.

The [desktop subprocess tests](../apps/desktop/src-tauri/src/command_execution_tests.rs)
exercise inherited and explicitly added credentials, non-UTF-8 values, restart,
cancellation, and unchanged human/governed pane inheritance. These are source and
native subprocess checks, not acceptance of an installed Gyro build or every
provider integration.

Filtering names does not identify secrets in arbitrary variables such as
`DATABASE_URL`, remove secrets from command arguments, or by itself prevent
reading credential files or using operating-system services. Filtering alone does not prevent shell startup files
or child programs from loading credentials again.
Keychain storage and output redaction are useful controls with different scopes.

The shared [command runner](../crates/gyro-core/src/execution.rs) manages process
lifetime, cancellation, output bounds, and an explicit credential policy. These
features do not create a VM or a general filesystem/network sandbox. Credential
store path checks protect reads mediated by Gyro; they do not confine arbitrary
shell commands. Browser and web-fetch approvals likewise do not restrict shell
network traffic.

## macOS workspace filesystem policy

For Gyro-owned model commands, the backend selects `workspace-filesystem` unless
all three existing Full access conditions hold: unrestricted normal-run settings,
Normal mode, and the delegated child's permission ceiling. The renderer cannot
select or override the policy. A model-terminal restart rechecks current Full
access settings and the child ceiling; it can tighten a pane but cannot
automatically upgrade a confined pane. An already running process retains its
original boundary. Human terminals and provider CLI launchers retain
their existing behavior. Credential filtering applies even with Full access.

The [profile](../crates/gyro-core/src/workspace_sandbox.sbpl) denies operations by
default and grants the process operations needed for child commands, PTYs,
selected system services, and IP networking. The wrapper grants writes within
the bound workspace and a unique temporary directory, with exceptions protecting
Git/Gyro/provider control metadata, known credential locations, home shell
startup files, and Gyro private application data. Workspace and protected-path
ancestors cannot be unlinked to replace the authority path. Paths become
`sandbox-exec` parameters; command arguments are preserved without shell joining.
Mutable symlink components in workspace/cwd authority paths are rejected.

Known credential stores and default provider authentication directories are
excluded from reads. Gyro private data is excluded too, with a carve-out for only
the exact active managed worktree or projectless workspace. Each command gets
private temporary/cache paths; other commands' scratch directories are excluded.
Normal completion, cancellation, and terminal close/restart release the scratch
owner after the existing process-group cleanup. This cleanup does not establish
that a descendant which detached into a different process group has exited. Its
filesystem restrictions remain inherited. Abrupt host termination can leave
scratch directories behind; crash recovery cleanup is not implemented here.

IP network access is intentionally allowed, including localhost services.
There is no destination allowlist, network approval enforcement, or protection
against sending readable project data out. Unix-socket access is limited to the
system DNS resolver; general Unix connections and Apple Events have no grant.
This may make Docker, SSH agents, and some desktop helpers unavailable. The profile does not grant the Keychain SecurityServer service, but
synthetic credential-file checks are not a complete Keychain security assessment.
Broad reads outside known protected locations remain available. Arbitrary secret
files, custom provider-auth directories, secrets in arguments, and secrets with
unrecognized environment-variable names are not discovered automatically.

Missing/unsupported sandbox support, invalid authority paths, and preparation
failures return errors. If `sandbox-exec` cannot apply its profile, the wrapped
command fails; Gyro does not retry it unrestricted. The selected `executionPolicy`
appears in command/pane results and model-tool summaries. It describes the policy
requested for that execution; it is not a claim that a failed launch ran safely,
a provider-native command used this wrapper, or the installed application has
passed acceptance.

Build tools that require writes outside the workspace/scratch or protected Git
metadata can fail under this policy. Approval of an individual command does not
silently relax the filesystem boundary. Full access is the existing explicit
unrestricted mode. This boundary is not a VM, a separate user, complete host
isolation, or a replacement for provider-native sandboxing.

## Verification recorded on 2026-10-15

- `cargo test --locked -p gyro-core workspace_sandbox -- --test-threads=1`:
  15 passed. Real macOS subprocesses exercise workspace/scratch writes, denied
  sibling writes and credential reads, symlink/hardlink attempts, uppercase
  startup-file aliases, protected roots/metadata, managed workspaces, argument
  preservation, and Unix versus IP sockets.
- `cargo test -p gyro-desktop --locked --lib command_execution::tests -- --nocapture`:
  10 passed; one ignored credential-fixture entrypoint is invoked by its parent
  tests. Includes real foreground commands and PTYs, restart policy tightening,
  failed refresh/preparation, Full access, and scratch cleanup.
- `cargo test -p gyro-desktop --locked --lib terminal_process::tests -- --nocapture`:
  all 6 existing terminal lifecycle tests passed.
- `cargo check -p gyro-desktop --locked` passed with 10 existing warnings.
- Current-profile compatibility probes passed a Node write, Rust compilation,
  a dependency-free offline Cargo test, and system curl HTTPS. These probes do
  not establish compatibility for every package manager or provider.
- Command-blocking, provider-capability manifest, terminal-profile, and workbench
  checks passed. The architecture-size guard still reports the pre-existing
  `App.tsx` overrun (20,338 lines versus 20,329); backend `lib.rs` remains below
  its 31,217-line ceiling.

No packaged application was installed or exercised for this change.

## Next steps

1. **Installed-app and provider acceptance.** Exercise the exact packaged runtime,
   common real build/package-manager workflows, provider handoffs, permission
   changes, and failure presentation. Preserve the distinction between selected
   policy and successful launch in future UI status.
2. **Network policy and secret use.** Investigate a destination-aware host-side
   broker that keeps tool credentials outside command processes. This needs
   provider/CLI compatibility work and is separate from environment filtering,
   Keychain storage, or this filesystem policy.
3. **Optional remote execution.** Keep Linux microVM work separate from the local
   macOS execution contract; the SPACE exploration and product questions live in
   the private Obsidian vault.

Verification should distinguish source configuration, subprocess tests, and full
provider runtime acceptance. A passing local shell test does not establish that
all provider tools, external services, or unattended workflows are confined.
See also [permissions](permissions.md) and [privacy](privacy.md).
