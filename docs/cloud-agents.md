# Gyro Cloud agents: hidden prototype

2026-11-16. Implemented source, local tests only. Nothing deployed or published.
The user-approved prototype exception does not remove the user-supplied gate of
15 December plus Anthropic's written approval for work beyond this prototype.
The app, CLI commands and subscription login are not part of this first phase.

## Decision

Use Cloudflare Workers plus a Durable Object and Linux container per run, with
Supabase Auth and Postgres. This keeps orchestration, alarms, outbound credential
injection and compute control together. It is a prototype selection, conditional
on testing the image, snapshots and private-repository access on the real service.

Current Cloudflare docs use the native Durable Object Container API and Sandbox
1.0. This new service pins `@cloudflare/sandbox` and its image shim to `1.0.3`,
Wrangler to `4.162.0`, Claude Code to `2.1.325`, and Codex to `0.169.0`.
The installed skill's older `@next` recommendation was checked against the
current registry and official 1.0 docs before selecting the stable 1.0 line.
[Cloudflare runner tutorial](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/),
[native container API](https://developers.cloudflare.com/containers/api/durable-object-container/).

Inspected `services/gyro-cloud`, `docs/vision.md`, `docs/usage-safety.md` and the
existing core redactor. `.wrangler/` had no reusable tracked configuration.
`docs/workspace-safety.md` does not exist in this checkout. The existing backup
Worker uses Supabase issuer verification and private R2 objects; it does not
already run agents. The new service stays separate from that backup API. The
auth pattern is reused with the real user UUID, rather than backup object hashes.

### Provider comparison

USD before tax, allowances, model charges, control-plane requests and egress.
These are current published rates and vendor startup claims, not Gyro benchmarks.
Pricing checked 2026-11-16. CPU, memory and disk allocations differ as shown.

| Provider                                                      | Hourly compute example                                                             | Startup evidence                                                                                                                                                 | Interactive CLI login capability                                                                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare, selected `standard-1`: 0.5 vCPU, 4 GiB, 8 GB disk | $0.038016 with no active CPU to $0.074016 with the full CPU allocation busy        | Published benchmark reports 648 ms median and 910 ms p95 under a 100-sandbox burst on the new scheduling policy. Our custom image and repo setup are unmeasured. | Native PTY supports interactive CLIs. Provider login and its policy eligibility have not been tested or approved here.                                                            |
| E2B default: 2 vCPU, 4 GiB, 10 GiB disk                       | $0.1656/hour; Hobby has no plan fee, Pro adds $150/month                           | Vendor describes approximately 150 ms initialization. Task-ready time is unmeasured.                                                                             | Codex execution is documented. A user-owned subscription login has not been verified in this prototype.                                                                           |
| Daytona comparison: 2 vCPU, 4 GiB, 8 GiB disk                 | $0.1656 compute + $0.000324 disk/hour if 3 GiB are billable after the first 5 free | Vendor claims under 90 ms sandbox creation; task-ready time is unmeasured.                                                                                       | Daytona documents opening a sandbox terminal and completing the CLI browser/code login yourself. This is technical documentation, not written approval for Gyro's business model. |

Sources: [Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/),
[Cloudflare startup benchmark report](https://blog.cloudflare.com/faster-agent-sandboxes/),
[E2B pricing](https://e2b.dev/pricing),
[E2B startup report](https://changelog.e2b.dev/customers/lindy-powers-ai-workflows-with-e2b-code-action),
[E2B Codex guide](https://e2b.dev/resources/python-guide-run-openai-codex-in-an-e2b-sandbox),
[Daytona pricing](https://www.daytona.io/pricing),
[Daytona startup claim](https://www.daytona.io/docs/),
[Daytona CLI login guide](https://www.daytona.io/docs/en/guides/claude/claude-code-run-cli-sandbox/).

For a comparable custom Cloudflare allocation of 2 vCPU, 4 GiB and 8 GB, the
published formula gives $0.038016 to $0.182016/hour. The selected small instance
is cheaper partly because it offers less CPU. We choose Cloudflare for its
control integration, not a claim that equal-sized compute is always cheaper.
Workers Paid adds $5/month; Supabase, Workers, DO usage and egress are separate.
Snapshots are currently free during Cloudflare's public beta, with future GA
pricing unknown. This is an infrastructure estimate, not a Gyro selling price.

## API contract for the app

Base path `/v1/cloud`. All routes require `Authorization: Bearer <Supabase access
JWT>` in a header, including SSE. Do not put JWTs, Git tokens or provider keys in
URLs, app session events, telemetry or localStorage. Token refresh stays in the
future app's core/Keychain layer. The Worker validates JWT claims against the
configured issuer, then asks that issuer to verify the token and confirmed user.
Only UUIDs in `CLOUD_AGENTS_USER_IDS` may use this prototype.

| Method and route                     | Result                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /balance`                       | Own `seconds`, `reserved_seconds`, and available `hour_balance`                                                                                              |
| `GET /runs`                          | Own newest 100 runs                                                                                                                                          |
| `POST /runs`                         | Reserve the cap and queue a run; 202. `Idempotency-Key` must be a fresh UUID. Retry the same request/key after an uncertain response.                        |
| `GET /runs/{id}`                     | Own run status, reason, generated branch, cap, cumulative settled seconds, segment, activation time and deadline                                             |
| `GET /runs/{id}/logs?after={cursor}` | Finite SSE batch with `log` events, IDs and `status`; reconnect after 2 seconds with the cursor/`Last-Event-ID`. Includes `truncated` for bounded retention. |
| `POST /runs/{id}/stop`               | Destroy compute, cancel, settle unused prepaid time                                                                                                          |
| `POST /runs/{id}/pause`              | Stop CLI, checkpoint files, destroy compute, settle; `waiting` with `manual_pause`                                                                           |
| `POST /runs/{id}/resume`             | Re-supply credentials; reserve the unused portion of the original cap, restore files and restart the agent; 202                                              |

Start JSON:

```json
{
  "repo": "https://github.com/owner/repository",
  "branch": "main",
  "task": "Add regression coverage for the parser",
  "provider": "claude",
  "capSeconds": 3600,
  "idleSeconds": 600,
  "credentials": {
    "apiKey": "<API key supplied from Keychain>",
    "gitToken": "<repository-scoped GitHub token supplied from Keychain>"
  }
}
```

`provider` is `claude` or `codex`; `model` is optional. The source branch may be
main, but the result branch is always `gyro/cloud/{run UUID}`. HTTPS GitHub URLs
only, with no embedded credentials, query or fragment. Caps are 60 to 3600 active
seconds; idle is 60 to 600 seconds, default 600. Resume JSON contains only the
`credentials` object. API keys only: OAuth/subscription tokens are rejected.
Use a fine-grained GitHub token with Contents read/write for just the selected
repository. No GitHub account-wide credential needs to enter the sandbox.

Errors are `{ "error": "code" }`: 401 sign-in required, 403 prototype access,
402 insufficient hours, 404 absent/foreign resource, 409 request conflict or
invalid state, 413 oversized input, 503 unavailable control/database. Unexpected
exceptions return a constant error. No upstream body or supplied key is echoed.

The wire statuses are exactly `queued/running/waiting/blocked/done/failed/cancelled`.
This requested list is not a single existing core enum: `AgentSessionState`
currently has queued/running/done/failed; `WorkflowRunStatus` uses completed and
also interrupted. The app must explicitly map Cloud `done` to workflow completed,
keep waiting/blocked reasons, and retain `executionOrigin: cloud` separately.
This phase does not change either local enum or pretend that adapter is built.

## Credentials and Git boundaries

The Worker encrypts provider and Git credentials using AES-256-GCM and a fresh IV
before durable storage, with the run UUID as authenticated context. Its encryption
key and Supabase service role credential are Worker secrets. Neither is client
configuration. No JWT is persisted by this service. There is no AI login endpoint.

The sandbox receives only placeholder API credentials. Its HTTP/HTTPS traffic is
intercepted with Internet access disabled. The Worker authenticates only that
run's provider API and original GitHub repository. Redirects are not followed
with credentials. Other network destinations, including package registries, are
blocked in this prototype. Bake needed dependencies into the image; arbitrary
repo dependency installation is not yet supported.
Codex uses a documented custom Responses provider with an environment-key
placeholder, rather than creating a login file.
[Codex custom provider configuration](https://developers.openai.com/codex/config-advanced/).

Git push is permitted only during the publish phase. Receive-pack command packets
are checked before forwarding; every ref must be exactly the generated branch,
and deletion is rejected. The wrapper uses a fixed repo URL and explicit
`HEAD:refs/heads/gyro/cloud/{id}`, disables Git hooks/helpers, and never merges or
force-pushes. The agent process runs with privileges and Linux capabilities
dropped; the trusted wrapper performs lifecycle operations. Actual Linux
capability behavior still needs image/runtime acceptance.

Keys are removed from durable run state on pause or termination. Resume requires
fresh keys. Snapshots contain files, not process memory, and no real credential is
given to the container environment or written to its files. User repo text may
itself contain secrets: known families and labelled secret values are redacted in
logs, following the current core families, but arbitrary unknown secrets cannot
be recognized. Logging is disabled at the Worker config; no request bodies or
headers are deliberately logged. App-side use of the core redactor is phase two.

## Lifecycle and accounting

1. Supabase Auth owns identity. Dedicated `cloud_agents.users`, `cloud_runs`,
   `usage_ledger` and `hour_balance` tables hold the prototype state. A fifth
   `control` table contains the global kill switch. All five have enabled and
   forced RLS. Users have owner-only SELECT policies on their data and no table
   write privileges; control has no client policy. The private schema is not
   intended for direct Data API exposure.
2. A service-only `SECURITY INVOKER` RPC locks a user's balance before their run.
   It atomically reserves the entire requested cap. No positive balance, no run;
   insufficient remaining time also refuses the cap. Clients cannot credit,
   change ownership or rewrite the append-only ledger. Idempotent manual topups
   use a unique reference UUID.
3. Durable initialization stores encrypted keys and arms an alarm before execution.
   Activation starts the segment's clock before boot/clone, so setup and publish
   time consume the cap too. A new branch is created, the unmodified agent runs,
   and the wrapper commits and pushes its result for later local review.
4. A sandbox watchdog checks both its absolute deadline and time since output.
   The DO checks every 15 seconds independently of the app. Log/status polling
   from the Mac does not count as task activity. A silent task pauses after the
   chosen idle timeout. A hard-cap run becomes blocked and cannot reset its cap.
5. Pause kills the agent, checkpoints its filesystem and destroys the container.
   Resume restores files and restarts the CLI on the same generated branch; it
   does not restore the exact process or model conversation. Paused time is not
   charged. Failure to save a checkpoint stops compute and reports failure.
6. Settlement charges elapsed active seconds, rounded up and clamped to the
   segment's reservation. Unused time is released. Reserve/charge/release entries
   are unique per run/segment; retries cannot double-charge. Destroy occurs before
   settlement, so database failure cannot leave compute running. Pending
   settlement is durably retried.
7. The database kill switch blocks starts and future authenticated outbound calls;
   active containers are destroyed at the next alarm. Control-read failures also
   fail closed. A one-minute reconciliation scan releases orphaned reservations
   and revisits overdue active runs. The platform has a 60-second inactivity
   fallback if the controller becomes inactive.

Hour caps bound the billed prepaid segment and agent runtime. Cloudflare alarm
delays, snapshot/stop latency, platform faults and base/control-plane charges can
produce infrastructure overhead outside prepaid seconds. This prototype is not a
guarantee that the provider bill can never exceed a run's CPU-time estimate.
Known AI API charges are separate from sandbox hours and charged to the user's
own provider key. There is no implemented retail price, margin, payment processor,
automatic topup or hosted provider-credit product.

## Isolated setup and kill switch

No hosted migration or deployment has been performed. Do not point this service
at production or the existing chat backup Worker. A separately approved private
test deployment needs an isolated Supabase project, applied migration, Worker
secrets, allowlisted test UUID, built image and a private route protected by
Cloudflare Access. `workers_dev` and preview URLs are disabled and no routes are
configured. Both feature flags default to zero and the database control defaults
to disabled; merely deploying the source does not enable runs.

Manual credit in the isolated project's SQL console (substitute the user's UUID
and a unique reference UUID; no service credential belongs in this SQL):

```sql
select public.cloud_agents_rpc('topup', '<user UUID>'::uuid, null,
  '{"seconds":3600,"reference":"<unique credit UUID>"}'::jsonb);
```

The account must already exist in Supabase Auth. Test activation requires setting
`cloud_agents.control.enabled` to true explicitly as an administrator, as well as
both Worker flags. Kill all runs by setting it false. Confirm each container stops
before declaring a kill-switch drill passed; the current tests are local.
Snapshots and bounded logs currently have no automatic retention/deletion policy;
do not admit external users until lifecycle/retention operations are added.

## Verification recorded for this change

- 23 Node tests: API guards/auth, tenant checks, encrypted/tamper-resistant keys,
  redaction, receive-pack branch restrictions, SSE cursors, lifecycle, cap/idle,
  pause/resume, crash and database-outage recovery, bounded DO log storage.
  A public-source boundary check rejects privileged Cloud credential references
  and Worker imports in desktop, CLI/core and shared packages.
- Real temporary Postgres 17: migration, RLS on all five tables, owner isolation,
  denied client writes and RPC execution, zero balance, duplicate credit/start/
  settle behavior, pause/resume, concurrent overspend prevention and kill switch.
- Four Python tests: actual local clone/edit/commit/push using a deterministic fake
  agent, main unchanged; real child-process idle/deadline termination; CLI argument
  construction and redaction. Linux isolation is substituted in the local harness.
- Generated Wrangler runtime types, TypeScript check and Worker-only dry-run pass.
- A local workerd smoke test loads the module and DO namespace, confirms the
  disabled route returns 404 and unauthenticated enabled access returns 401;
  initializes durable state over RPC and checks owner-only log access. No
  container is started by that test.
- Both existing chat backup Worker tests still pass.
- Gitleaks scanned 1,173 tracked/untracked public client/core source and
  prototype/document files
  with no findings. No secret values were printed. The app packaging config has
  no resource rule that includes the new Worker directory.
- The existing desktop `dist` was scanned separately, without rebuilding it.
  Two generic scanner matches in bundled xterm/TypeScript code were verified as
  unquoted JavaScript assignments, not credential values. Neither privileged
  Worker credential identifier appears in that bundle.
- Full image build was attempted but Docker was unavailable. The image, installed
  CLI flags in Linux, native Cloudflare alarms/intercepts/snapshots, private repo
  access, authenticated live model execution and Mac-sleep continuity are untested.
  No live AI call, deployment, topup, hosted schema change, purchase or push occurred.

App/CLI integration, core Keychain handoff, usage-safety preflight, unified run-list
UI and pull-into-local-worktree review remain phase two. They require their own
five-line plan and user OK before implementation.

App handoff finding: `crates/gyro-core/src/keychain.rs` currently routes normal
provider key reads/writes through `keychain/local_secrets.rs`, an owner-only local
file, despite the module name. Do not claim those helpers satisfy this feature's
Keychain requirement. Use actual macOS Keychain storage for the Cloud session and
Cloud BYOK credentials through core, while preserving unrelated credential
behavior. The existing Cloud Supabase store is a separate implementation to
inspect for reuse. UI should reuse the current Settings groups/rows, semantic
`--gyro-*` tokens, confirmation pattern and run surfaces; no new palette is
approved by this handoff.
