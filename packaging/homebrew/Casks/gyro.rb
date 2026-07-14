# Planned template only. The current alpha workflow emits architecture-specific
# DMGs and does not generate or validate this Cask; do not publish it as-is.
cask "gyro" do
  version "0.1.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

  url "https://github.com/gyro-dev/gyro/releases/download/v#{version}/Gyro_#{version}_universal.dmg"
  name "Gyro"
  desc "Open-source local-first coding agent workspace"
  homepage "https://github.com/gyro-dev/gyro"

  app "Gyro.app"

  zap trash: [
    "~/Library/Application Support/Gyro",
    "~/Library/Logs/Gyro",
    "~/Library/Preferences/dev.gyro.desktop.plist"
  ]
end
