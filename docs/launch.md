# Launch Plan

## Launch Film

The canonical repository copy of the current launch film lives with the launch
documentation:

- [Watch the 22-second cinematic launch film](media/launch/gyro-launch-film.mp4)
- [Open the launch poster](media/launch/gyro-launch-poster.png)
- [Read the asset and delivery notes](media/launch/README.md)

The repository tracks the channel-ready H.264 master and poster. High-bitrate
mezzanine renders and working production artifacts stay outside ordinary Git
history so clones remain lightweight.

## Local App Launch

Use the dev launcher only while developing:

```bash
pnpm desktop:dev
```

For app-like testing, build the macOS bundle and open the bundle:

```bash
pnpm desktop:bundle
open target/release/bundle/macos/Gyro.app
```

For repeat local Finder or Dock testing, install a local app copy:

```bash
pnpm desktop:install-local
```

`desktop:install-local` builds `Gyro.app`, copies it to
`~/Applications/Gyro.app`, attempts an ad-hoc local signature, and opens that app
bundle. Set `GYRO_SKIP_LOCAL_CODESIGN=1` to skip the ad-hoc signing step.

Avoid opening or pinning `target/debug/gyro-desktop`. It is the raw Tauri debug
executable, not the macOS app bundle, and it expects the dev server path. When
opened directly from Finder or the Dock it can show a blank white window and a
generic `exec` Dock icon.

## Alpha

Run a private alpha with 20-50 macOS developers.

Acceptance goals:

- Fresh Gyro.app install succeeds from the matching architecture DMG through
  the documented one-time **Open Anyway** flow.
- The CLI installs independently from `wytzeh197/tap` on Apple Silicon and
  Intel.
- `gyro doctor` reports useful setup status.
- CLI-created sessions open in Gyro.app.
- App-created sessions can be continued from CLI.
- Users understand BYOK provider setup.
- Command and file-edit approvals are clear.

## Public Developer Preview

Public install instructions should identify the build as an unsigned Alpha and
link to [Install Gyro on macOS](install-macos.md). Publish only after the
ad-hoc-signed DMGs pass strict signature, checksum, and clean-machine
installation checks. Do not suggest disabling Gatekeeper or removing
quarantine.

Launch order:

1. GitHub public repository and manually accepted, immutable Alpha release.
2. [Download site](https://wytzeh197.github.io/Gyro/) with direct Apple Silicon
   and Intel choices, the unsigned disclosure, and install help.
3. CLI-only Homebrew tap after both native Formula validations pass.
4. Show HN with concrete technical details and a working download.
5. Product Hunt after initial GitHub/HN feedback.
6. Focused posts in Rust, Tauri, open-source, local-first AI, and coding-agent
   communities.

## Positioning

Primary line:

> Gyro is an open-source coding agent workspace that runs as a macOS app, CLI, and eventually an IDE layer.

Avoid claiming Gyro replaces VS Code in v1. v1 is an agent workspace with chat, terminal, editor surface, diffs, settings, and CLI attach.

## Metrics

- Activation: user opens a repo and completes one accepted file edit.
- Reliability: crash-free sessions and successful CLI-to-app attach.
- Distribution: successful installs and updates.
- OSS health: external issues closed, external PRs merged, repeat contributors.
