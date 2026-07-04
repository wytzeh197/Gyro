class Gyro < Formula
  desc "Open-source local-first coding agent workspace CLI"
  homepage "https://github.com/gyro-dev/gyro"
  url "https://github.com/gyro-dev/gyro/releases/download/v0.1.0/gyro-cli-aarch64-apple-darwin.tar.gz"
  sha256 "REPLACE_WITH_CLI_SHA256"
  license "Apache-2.0"

  def install
    bin.install "gyro"
  end

  test do
    system "#{bin}/gyro", "doctor", "--json"
  end
end
