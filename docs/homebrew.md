# Homebrew Packaging

Gyro uses a dedicated tap for macOS distribution:

```bash
brew tap gyro-dev/tap
brew install --cask gyro
brew install gyro
```

The cask installs Gyro.app. The formula installs the `gyro` CLI.

The templates in `packaging/homebrew` must be copied to the public tap during release automation with real version numbers, URLs, and SHA256 values.
