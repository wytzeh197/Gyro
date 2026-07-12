# Release Process

Gyro v1 targets macOS first through direct downloads and Homebrew. Until Apple
Developer signing is available, GitHub Releases provide an explicitly unsigned
private-preview bootstrap whose updater artifacts are still protected by Gyro's
Tauri signing key.

## Update Source

Gyro uses one Stable update stream hosted by the public GitHub repository. The
desktop updater reads:

```text
https://github.com/wytzeh197/Gyro/releases/latest/download/latest.json
```

Drafts and prereleases are not returned by GitHub's latest-release endpoint.
Publishing a verified non-prerelease draft makes it available to installed apps.

## Direct macOS Release

Each release should publish:

- Signed and notarized Apple Silicon DMG.
- Signed and notarized Intel DMG.
- CLI tarballs for `aarch64-apple-darwin` and `x86_64-apple-darwin`.
- SHA256 checksums.
- Tauri updater artifacts.
- Release notes with upgrade and rollback notes.

## Required Secrets

Private-preview GitHub builds need:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Add `TAURI_UPDATER_PUBLIC_KEY` as a GitHub Actions repository variable. The
release workflow injects it before preflight; the matching private key remains
only in GitHub Actions secrets.

Public signed and notarized builds additionally need:

GitHub Actions release builds need:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
  Generate the Tauri updater keypair before the first public release.

The committed updater public key is safe to distribute. Its matching private
key is stored in GitHub Actions secrets and backed up locally outside the repo.
Generate a replacement keypair only if no released build trusts the current key:

```bash
pnpm --filter @gyro-dev/desktop tauri signer generate
```

## Homebrew

Use a dedicated tap:

```text
gyro-dev/homebrew-tap
```

Publish:

- `Casks/gyro.rb` for Gyro.app.
- `Formula/gyro.rb` for the CLI.

Homebrew-installed users should update with:

```bash
brew update
brew upgrade --cask gyro
brew upgrade gyro
```

Direct app installs should use Tauri updater artifacts and refuse unsigned or invalid updates.
The tagged workflow uploads `latest.json`, updater signatures, signed artifacts,
DMGs, and release notes for Apple Silicon and Intel macOS.

## Preflight

Before tagging:

```bash
cd "/Users/wytzehemrica/Documents/Gyro"
pnpm install
pnpm doctor
pnpm release:check
pnpm check
cargo test --workspace
cargo run -p gyro-cli -- doctor --json
pnpm --filter @gyro-dev/desktop tauri build
```

Manual checks:

- Install DMG on a clean macOS user.
- Run `gyro doctor`.
- Create a CLI session and open it in Gyro.app.
- Create an app session and read it from CLI.
- Verify updater signature failure is rejected using a deliberately invalid manifest in a staging channel.
