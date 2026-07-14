# Release Process

Gyro v1 targets macOS first through direct downloads, with CLI Homebrew support
planned through a dedicated tap. Preview
artifacts are currently built and hosted through GitHub Actions without Apple
Developer signing or notarization. They must be labeled as unsigned public
alphas rather than stable or production-ready releases. Tauri updater
signatures protect artifact integrity; they do not replace Apple code signing
or notarization.

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

- GitHub-built Apple Silicon DMG.
- GitHub-built Intel DMG.
- CLI tarballs for `aarch64-apple-darwin` and `x86_64-apple-darwin`.
- SHA256 checksums.
- Tauri updater artifacts.
- Release notes with upgrade and rollback notes.

The tagged workflow builds `gyro` natively on Apple Silicon and Intel runners.
Each archive is named
`gyro-cli-<version>-<target>.tar.gz`, contains the executable, license, README,
and a `gyro.cli.archive.v1` manifest, and has a matching `.sha256` sidecar. The
finalize job also publishes `SHA256SUMS` and a generated `gyro.rb` whose URLs
and architecture checksums point at that immutable tag.

Before upload, the workflow installs each archived CLI into an isolated
temporary home and runs `gyro --version`, zsh completion generation, and
`gyro doctor --json`. This catches a runnable-architecture or packaging failure
before a draft release is assembled.

The macOS job builds both architectures on GitHub-hosted macOS runners. The
updater archives are signed with the Tauri updater key, while the `.app` bundles
and DMGs remain explicitly not Apple-signed or notarized during the alpha.

## Required Secrets

Every tagged GitHub release build needs the updater-signing secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Add `TAURI_UPDATER_PUBLIC_KEY` as a GitHub Actions repository variable. The
release workflow injects it before preflight; the matching private key remains
only in GitHub Actions secrets.

`pnpm release:check` fails closed in GitHub Actions when either updater-signing
secret is absent. The release toolchain is pinned to `tauri-cli 2.11.4`, and the
job verifies that version before release configuration or updater signing
begins.

Generate the Tauri updater keypair before the first public release.

The committed updater public key is safe to distribute. Its matching private
key is stored in GitHub Actions secrets and backed up locally outside the repo.
Generate a replacement keypair only if no released build trusts the current key:

```bash
pnpm --filter @gyro-dev/desktop tauri signer generate
```

## Homebrew CLI Formula

Use a dedicated tap:

```text
gyro-dev/homebrew-tap
```

The current alpha workflow generates `Formula/gyro.rb` for the CLI. The
checked-in app Cask is a planned template only: it does not match the
architecture-specific DMGs and must not be published as-is. Install Gyro.app
from the matching direct-download DMG until a generated Cask is added to the
release workflow.

The checked-in Formula is a release template and intentionally contains
checksum markers. Do not publish that template. Download `gyro.rb` from the
draft release after both architecture jobs complete, inspect it, and copy that
generated file to the tap. It contains the real SHA256 values calculated from
the uploaded archives.

After the generated Formula is published to the tap, Homebrew CLI users should
update with:

```bash
brew update
brew upgrade gyro
```

Direct app installs should use Tauri updater artifacts and refuse unsigned or invalid updates.
The tagged workflow uploads `latest.json`, updater signatures, CLI archives and
checksums, the generated Homebrew Formula, GitHub-built app artifacts, DMGs, and
release notes for Apple Silicon and Intel macOS. It creates a draft; publishing
remains an explicit decision after the manual checks below.
Runs are serialized per tag. A rerun may refresh assets and notes only while the
release is still a draft and fails before upload if that tag has already been
published.

Direct CLI users can verify an archive before installation:

```bash
shasum -a 256 -c gyro-cli-<version>-<target>.tar.gz.sha256
tar -xzf gyro-cli-<version>-<target>.tar.gz
./gyro --version
./gyro doctor
```

## Preflight

Before tagging:

```bash
pnpm install
pnpm doctor
pnpm release:check
pnpm check
cargo test --workspace
cargo build -p gyro-cli
pnpm release:cli:check
cargo run -p gyro-cli -- doctor --json
node scripts/package-cli-release.mjs --help
pnpm --filter @gyro-dev/desktop tauri build
```

Manual checks:

- Install DMG on a clean macOS user.
- Confirm the unsigned alpha warning is expected and clearly disclosed in the
  release notes and README.
- Run `gyro doctor`.
- Verify both CLI checksum sidecars against `SHA256SUMS` and install the
  generated Formula from the draft release on matching hardware.
- Create a CLI session and open it in Gyro.app.
- Create an app session and read it from CLI.
- Verify updater signature failure is rejected using a deliberately invalid manifest in a staging channel.
