# Contributing To Gyro

Gyro is an open-source coding agent workspace. Contributions are welcome once they keep the local-first, user-controlled security model intact.

## Development Setup

Install Node.js 22, pnpm 11, Rust 1.78+, and the Xcode command line tools.

```bash
pnpm install
pnpm check
cargo test --workspace
```

For desktop work:

```bash
pnpm --filter @gyro-dev/desktop tauri dev
```

For CLI work:

```bash
cargo run -p gyro-cli -- doctor
```

## Contribution Rules

- Keep user data local by default.
- Do not add telemetry unless it is opt-in and documented.
- Do not bypass command or file-edit approval gates.
- Keep model-provider credentials in the OS keychain.
- Do not write project metadata into user repositories unless the user explicitly opts in.
- Prefer small pull requests with tests for changed behavior.

## DCO

Gyro uses Developer Certificate of Origin signoff instead of a CLA.

Add signoff to every commit:

```bash
git commit -s
```

By signing off, you certify that you have the right to submit the contribution under the Apache-2.0 license.
