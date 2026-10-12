# Code Mode workspace inspection pilot

Code Mode lets a model discover and compose related workspace reads in a confined JavaScript-like interpreter. It remains an internal pilot: start a newly built desktop with GYRO_CODE_MODE=1 to advertise its tools. Unset the variable or set it to 0 to use ordinary tools. Availability also requires the bundled helper. No user-facing mode or settings change is added.

## Model contract

gyro_code_mode_discover returns up to four registry-generated tool descriptions and schemas, with query, offset, limit, hasMore, and nextOffset. The tools are gyro_workspace_list, gyro_workspace_search, gyro_workspace_read, and gyro_workspace_read_range.

gyro_code_mode_execute accepts label (1–100 characters) and code (1–16384 UTF-8 bytes). Use await tools.gyro_workspace_read({path:"src/example.ts"}) and return selected data. Each call returns {callId,status,summary,data,resource}. Search and read results remain untrusted observations; retain their truncation and continuation metadata when returning evidence.

Every child request uses a fresh call ID and the parent run's authenticated context, then re-enters the existing capability broker. Root IDs, sensitive-file approvals, current policy, workspace changes, cancellation, and scope checks are enforced there. Multi-root reads require an explicit rootId. Live editor text, writes, commands, browser tools, delegation, and nested execution are absent from the interpreter catalog.

## Bounds and failures

- Maximum four concurrent reads and 32 interpreter calls, including built-in tool search.
- One disposable native helper per workflow; no persistent script globals or cross-run state.
- 60-second total execution deadline, including approval waits. Expired waits are cancelled visibly.
- 256 MiB resident-memory ceiling on macOS, sampled every 100 ms.
- 16 KiB source, 16 KiB per observation, 512 KiB cumulative tool-response data, and bounded returned values/logs.
- No worker environment inheritance; the worker runs in a private temporary directory with no host extensions supplied to the interpreter. Gyro explicitly disables JavaScriptCore JIT in the helper so the desktop does not need additional JIT permissions.
- No automatic replay. Failure returns partial receipts; previously completed actions remain completed.
- Un-awaited work is interrupted. Warnings, incomplete results, and truncation are explicit.

The helper uses Gyro's existing crash-cleanup owner. Limits restrict script execution; host reads retain their existing bounds and cancellation behavior.

## Frontend and persistence

The parent capability event carries bounded, redacted codeMode metadata and the final outcome. Child events carry groupId. Their original call IDs and resource links remain intact. Final receipts include durations and restore details when child events are outside the loaded transcript window.

The transcript shows one expandable workflow card. It displays observed completed/running/failed/denied counts, individual action details, file navigation, returned results, and an optional technical disclosure. Pending approvals stay outside the disclosure. Terminal states distinguish Done, Partial, Failed, Denied, Cancelled, and Interrupted. Grouping is scoped to the same session and turn; older chats and orphaned child events remain readable.

A stopped provider turn cannot leave a workflow permanently Working. Terminal events win over late active updates.

## Building and checks

The package pins @opencode/codemode 2.0.27, Effect 4.0.1, and Bun 1.4.3. pnpm --filter @gyro-dev/codemode build produces the host macOS helper. TAURI_ENV_TARGET_TRIPLE selects aarch64-apple-darwin or x86_64-apple-darwin. Tauri packages it as gyro-codemode beside the desktop executable; development and release hooks build it first. No user-installed Node or Bun is needed.

- pnpm test:code-mode verifies source execution and transcript grouping.
- cargo test -p gyro-desktop code_mode::tests --lib verifies the compiled helper, concurrency, host confinement, memory limits, interruption, and timeout. Build the helper first.
- pnpm test:code-mode-native runs isolated real-broker acceptance without provider calls or user data. Set GYRO_CODE_MODE_SMOKE_BINARY to a built debug app executable to verify its packaged helper, rather than starting through Cargo.
- apps/desktop/code-mode-preview.html renders the actual production card with labeled fixtures.
- Set GYRO_CODE_MODE_WORKER to an absolute compiled-helper path when running the worker tests to verify that executable, including an Intel binary under Rosetta.

Third-party notices and runtime rebuild instructions are packaged with the helper.

## Performance and rollout gate

The deterministic native fixture compares one search plus two reads against the composed workflow and requires identical evidence. It counts three ordinary tool exchanges versus one execution, plus one discovery exchange on a cold catalog. One local run measured 64 ms for ordinary tools and 207 ms for Code Mode: helper startup costs more than it saves on this small local workload.

These are broker timings and scripted exchange counts, not measured model latency or token savings. Keep the pilot opt-in until representative real-model workflows measure elapsed time, tokens, evidence correctness, and denial/cancellation behavior. A single simple read should continue using its ordinary tool. Broader actions and default-on rollout require separate validation; nothing is published by this implementation.
