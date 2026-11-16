# Full pending app install — 15 November 2026

The user requested reinstalling **all pending app changes**, then pushing after verification. The install includes SSH remote access, browser reliability and window restoration, expandable Environment card, chat activity rendering, settings polish, workflow-menu placement, terminal guidance and web-fetch policy fixes.

A frozen source tree containing the 53 pending app-related paths was built with the normal optimized release profile. Scratch research/plans were left outside the application commit. Build dependencies and outputs were isolated so concurrent source changes could not leak into the installed bundle. The checkout was rechecked against that snapshot before installation.

Validation passed: workspace typecheck, production frontend/native bundle build, 26 remote transport tests plus the explicit real-OpenSSH integration test, 12 web-fetch tests, two ACP activity tests, browser runtime/subagent routing/chat-run/token checks, the complete remote browser regression suite, and a redacted secret scan.

Installed `/Users/wytze/Applications/Gyro.app` from that bundle with the existing local ad-hoc signing workflow. Strict deep signature verification passed; the installed executable UUID matched the built executable. All 218 original session IDs and 735 session files remained present. Configuration and credential file hashes were unchanged immediately after installation. A rollback app and data backup were retained privately outside the repository.

Native inspection confirmed Remote access **On · Reachable**, the Gyro pairing/SSH method switch, two shared sidebar projects, retained chat history, and the Environment card expanding from its collapsed header. No Keychain migration prompt appeared.

A temporary, loopback-only OpenSSH server with temporary keys authenticated to this macOS account and reached the installed app's private SSH socket. Hello, projects, sessions, snapshot and history requests succeeded: two shared projects, 185 sessions in the first project, and a valid session snapshot/history. This check did not invoke a model. The temporary server/keys were removed after the probe; no system SSH settings or user SSH keys were modified.

This is local native and loopback SSH evidence. It does not establish a physical MacBook-to-Mac-Mini connection or a new live-provider acceptance run. This branch push is not a signed/notarized public release.
