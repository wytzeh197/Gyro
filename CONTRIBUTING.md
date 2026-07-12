# Contributing to Gyro

Thanks for helping build Gyro. Bug reports, documentation improvements, design
feedback, and focused code contributions are welcome.

Before participating, read the [Code of Conduct](CODE_OF_CONDUCT.md). For
questions and troubleshooting, use [Support](SUPPORT.md). Report vulnerabilities
privately using the [Security Policy](SECURITY.md).

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before a large feature or architectural change so direction can
  be agreed before significant work begins.
- Keep pull requests focused. Separate unrelated cleanup from behavioral changes.
- Never include credentials, private session logs, customer code, or other
  sensitive data in issues, tests, screenshots, or commits.

## Development Setup

Gyro development currently requires macOS 14+, Node.js 22+, pnpm 11+, Rust
1.78+, Git, and the Xcode command line tools.

```bash
git clone https://github.com/wytzeh197/Gyro.git
cd Gyro
corepack enable
pnpm install --frozen-lockfile
pnpm doctor
pnpm check
cargo test --workspace
```

Run commands from the repository root. Start the desktop app with the checked
root launcher:

```bash
pnpm desktop:dev
```

Try the CLI without installing it globally:

```bash
cargo run -p gyro-cli -- doctor
cargo run -p gyro-cli -- --help
```

## Development Principles

- Keep user data local by default.
- Do not add telemetry unless it is opt-in and documented.
- Do not bypass command, context, or file-edit approval gates.
- Keep provider credentials in provider-owned storage or macOS Keychain.
- Do not write Gyro metadata into a user repository without explicit opt-in.
- Preserve compatibility of stored sessions, configuration, and event payloads.
- Add or update tests for changed behavior and documentation for user-visible
  changes.

Architecture and product constraints are documented in
[docs/architecture.md](docs/architecture.md) and [docs/vision.md](docs/vision.md).

## Pull Requests

1. Create a branch from the latest `main`.
2. Make a focused change with tests where appropriate.
3. Run the required checks:

   ```bash
   pnpm check
   cargo test --workspace
   ```

4. Sign off every commit with `git commit -s`.
5. Explain the problem, solution, validation, and any security or migration
   impact in the pull request.

CI runs the Node workspace checks, Rust tests, and a desktop build smoke test.
Maintainers may request additional clean-machine or app-level verification for
release, storage, updater, provider, terminal, or approval changes.

## Developer Certificate of Origin

Gyro uses [Developer Certificate of Origin 1.1](https://developercertificate.org/)
signoff instead of a Contributor License Agreement.

Add a `Signed-off-by` line using Git's `-s` flag:

```bash
git commit -s -m "Describe the change"
```

By signing off, you certify that you have the right to submit the contribution
under the project's [Apache-2.0 license](LICENSE).
