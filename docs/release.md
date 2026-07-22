# Release Process

Gyro ships a macOS 14+ public **Alpha** from GitHub Releases. The
[download site](https://usegyro.io/) is the user-facing front
door; GitHub remains the binary source of truth and fallback.

AI tools may assist release preparation, but they are not release evidence and
must not receive release secrets. Follow the
[AI-assisted development policy](ai-development.md) alongside this process.

Alpha app bundles are ad-hoc signed, not signed with an Apple Developer ID and
not notarized. Users must follow the documented one-time
[Open Anyway installation flow](install-macos.md). Never tell users to disable
Gatekeeper or remove quarantine globally.

## Release and update channel

The desktop updater and download site both resolve the latest published,
non-prerelease GitHub release. The updater reads:

```text
https://github.com/wytzeh197/Gyro/releases/latest/download/latest.json
```

Drafts and releases marked as prereleases are excluded from GitHub's latest
endpoint. Until Gyro has separate release channels, every public Alpha must be
visibly labeled **Alpha** but published as a non-prerelease. A draft becomes
available to the site and installed apps only after manual acceptance and
publication.

## Public artifact contract

Every release must contain one complete, version-aligned set:

- `Gyro_<version>_aarch64.dmg` for Apple Silicon.
- `Gyro_<version>_x64.dmg` for Intel.
- `gyro-cli-<version>-aarch64-apple-darwin.tar.gz` and its `.sha256` sidecar.
- `gyro-cli-<version>-x86_64-apple-darwin.tar.gz` and its `.sha256` sidecar.
- `Gyro_aarch64.app.tar.gz` and `.sig` updater artifacts.
- `Gyro_x64.app.tar.gz` and `.sig` updater artifacts.
- `latest.json`, `SHA256SUMS`, and the generated `gyro.rb` CLI Formula.
- Versioned release notes with install, update, and rollback guidance.

Do not add a universal DMG alias. Artifact names are a public interface used by
the site, updater, release checks, documentation, and Homebrew automation.

The CLI archives contain `gyro`, `LICENSE`, `README.md`, and a
`gyro.cli.archive.v1` manifest. Release finalization calculates immutable
architecture checksums and generates `gyro.rb` with URLs for the exact tag.

## macOS integrity contract

Tauri must set `bundle.macOS.signingIdentity` to `-` and
`bundle.macOS.minimumSystemVersion` to `14.0`. This produces an ad-hoc signature
without requiring an Apple account. It does not produce Apple trust or
notarization.

Before an architecture bundle can be uploaded, the macOS release verifier must:

- run `hdiutil verify` and mount the DMG read-only;
- require exactly one Gyro.app and an Applications shortcut;
- pass `codesign --verify --deep --strict` on Gyro.app;
- confirm an ad-hoc signature with no Developer ID authority or Team ID;
- confirm bundle identifier `dev.gyro.desktop`, release version, icon, and
  macOS 14 minimum;
- confirm the expected single architecture for that runner; and
- verify the final DMG digest recorded in `SHA256SUMS`.

`pnpm release:check` must fail if the Tauri settings or release workflow omit
these requirements. A partial or malformed signature is a release-blocking
failure, even when the app launches on the build machine.

The updater archives retain their Tauri updater signatures. Those signatures
authenticate Gyro-issued updates and are independent of the ad-hoc macOS code
signature. Direct app installs and updates must reject missing or invalid
updater signatures.

## Required repository configuration

The tagged release workflow needs:

- `TAURI_SIGNING_PRIVATE_KEY` Actions secret.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secret.
- `TAURI_UPDATER_PUBLIC_KEY` Actions variable.

The Homebrew publish workflow needs:

- `HOMEBREW_TAP_TOKEN`, a fine-grained token limited to
  `wytzeh197/homebrew-tap` with **Contents: Read and write**.

No Apple certificate or notarization secret belongs in the Alpha workflow.
Keep the updater private key backed up outside the repository; rotate it only
when no released app trusts the current public key.

Enable GitHub immutable releases before publishing the corrected Alpha. Draft
assets remain replaceable during acceptance; after publication, the tag and
assets must be locked. The release workflow must continue to refuse any attempt
to overwrite a published release.

## Release notes contract

Each versioned release body must include:

1. **Alpha notice:** macOS 14+, Apple Silicon and Intel, no Apple Developer ID
   signature or notarization, and a link to the
   [Open Anyway guide](https://github.com/wytzeh197/Gyro/blob/main/docs/install-macos.md).
2. **Direct downloads:** links to both versioned DMGs, labeled by architecture,
   plus the [download site](https://usegyro.io/) as the preferred
   chooser.
3. **Integrity:** a link to the tag's `SHA256SUMS` asset and a reminder to match
   the exact filename.
4. **Changes and known limits:** user-visible behavior and compatibility.
5. **Update and rollback:** the supported update route, data-backup step, prior
   version link, and any schema limitation.
6. **CLI:** architecture archives and the CLI-only Homebrew commands after the
   Formula is published.

Use direct links of this form, substituting the exact tag and version:

```text
https://github.com/wytzeh197/Gyro/releases/download/v<version>/Gyro_<version>_aarch64.dmg
https://github.com/wytzeh197/Gyro/releases/download/v<version>/Gyro_<version>_x64.dmg
https://github.com/wytzeh197/Gyro/releases/download/v<version>/SHA256SUMS
```

## Release branch policy

Prepare each product release on a short-lived `release/v<version>` branch cut
from `main`. Update every version surface, lockfile, and the matching versioned
release notes on that branch. Release preparation may include stabilization
fixes, but unrelated feature work should continue separately.

Open a pull request for the release branch and require CI to pass. Merge it into
`main`, then create the immutable `v<version>` tag on the exact merged commit.
Never tag or publish directly from an unmerged release branch. Pushing the tag
starts the draft release workflow described below.

Delete the release branch after it is merged. These branches are temporary
coordination points, not permanent branches for historic versions. Ordinary
feature and dependency changes continue to use normal short-lived branches and
do not require a product release by themselves.

## Draft, accept, and publish

1. On the release branch, update every version surface and add matching
   `docs/releases/v<version>.md` notes. Do not reuse a published tag.
2. Run the preflight checks below, merge the passing release pull request into
   `main`, then tag that exact merged commit and push the `v<version>` tag.
3. Let `.github/workflows/release.yml` build both native architectures, verify
   them, assemble `latest.json`, checksums and `gyro.rb`, and create one draft.
4. Download the draft assets exactly as a user would. Match every digest to
   `SHA256SUMS`, inspect the release body and install both architectures on the
   appropriate hardware.
5. Complete the clean-user Gatekeeper and updater acceptance checks. Publish
   the draft as a non-prerelease only when every check passes.
6. Confirm the Cloudflare Pages site and `/releases/latest` show the new version and that
   updater metadata resolves. The `release.published` workflow then validates
   the CLI Formula on Apple Silicon and Intel before updating the tap.
7. If the prior latest release is defective, mark its title and first release
   paragraph as superseded only after the replacement is live. Link to the
   fixed release; never replace the old assets in place.

After the Cloudflare Pages deployment is verified, set the GitHub repository homepage to
`https://usegyro.io/` and keep repository topics aligned with the
public product description.

## Homebrew CLI

`packaging/homebrew/Formula/gyro.rb` is a template containing checksum markers;
never publish it. The release-generated `gyro.rb` has real checksums. On
`release.published`, `.github/workflows/publish-homebrew.yml` preserves that
exact asset, installs and tests it on both architectures, then writes it to
`Formula/gyro.rb` in `wytzeh197/homebrew-tap`.

```bash
brew tap wytzeh197/tap
brew trust --formula wytzeh197/tap/gyro
brew install gyro
```

There is no Homebrew Cask for Gyro.app during the unsigned Alpha. See
[Homebrew packaging](homebrew.md) for tap setup and operations.

## Preflight and acceptance

Run before tagging:

```bash
pnpm install --frozen-lockfile
pnpm doctor
pnpm release:check
pnpm check
pnpm test
cargo fmt --all -- --check
cargo test --workspace
cargo build -p gyro-cli
pnpm release:cli:check
cargo run -p gyro-cli -- doctor --json
git diff --check
```

Manual acceptance must cover:

- both DMGs pass the full macOS integrity verifier and match `SHA256SUMS`;
- the Apple Silicon DMG installs on a clean macOS 14+ user and reaches
  **Open Anyway**, not a damaged/corrupt-app failure;
- the Intel app and CLI execute on the Intel runner or Intel hardware;
- both generated-Formula installs report the correct version, generate zsh,
  bash, and fish completions, and return `gyro.cli.v1` from `doctor --json`;
- an older approved Gyro installs the signed updater, relaunches, and preserves
  sessions;
- an invalid updater manifest or signature is rejected;
- CLI-created sessions open in Gyro.app and app-created sessions remain visible
  to the CLI; and
- the site handles missing release data without hiding the GitHub Releases
  fallback.
