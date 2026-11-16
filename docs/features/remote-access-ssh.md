# Remote access over SSH

Gyro supports two connection methods in **Settings → Remote access**:

- **Gyro pairing** keeps the existing device invitation flow.
- **SSH** connects to a host Mac through its existing SSH setup, using the same remote projects, sessions, composer, live provider events, usage, files, Git, terminal, approvals, and run controls.

## Connect

1. Run a Gyro build containing SSH support on both Macs. On the host, open Gyro and turn on Remote access. Its sidebar projects become the shared scope.
2. Enable macOS Remote Login on the host and make it reachable over your LAN, VPN, or existing SSH route. Gyro does not enable Remote Login or change network settings.
3. Ensure your OpenSSH setup can authenticate with a key or SSH agent and trusts the host key. First-time or changed host keys are rejected; verify the host through your normal `ssh` workflow before connecting in Gyro. Password-only and interactive passphrase prompts are not supported by this connection flow; load encrypted keys into your SSH agent first.
4. On the client, choose **SSH**, select a named host from your SSH config, or enter an address manually. Advanced settings support a port override, identity file, and an absolute remote socket path for custom Gyro data directories.
5. Click **Connect**. Successful connections are saved; host projects appear in the normal sidebar and new-session folder picker. Use the host's menu to open projects, reconnect, disconnect, or remove it.

The client's local hosting toggle can stay off. Outgoing SSH connections do not initialize the Gyro pairing identity or read its Keychain entry. Saved connection settings contain host names and key paths, never private-key contents or passwords. Connections are not silently restarted on application launch; reconnect explicitly from settings or a disconnected chat.

## Transport and authority

The app starts `/usr/bin/ssh` directly, with separate arguments. OpenSSH resolves the user's configuration, identities, proxy/jump configuration, and known hosts. Literal alias discovery follows bounded `Include` files without evaluating `Match exec` or proxy commands. Hostnames and usernames are validated; the remote bridge command is fixed, with shell-quoted optional socket paths.

OpenSSH runs the host Mac's `/usr/bin/nc -U` against `~/Library/Application Support/Gyro/remote-access/ssh.sock`. No extra remote CLI installation or public Gyro TCP port is needed. The socket directory is private (`0700`), the socket is `0600`, and the listener checks the OS peer UID. SSH must log in as the account running the host Gyro app. Agent/X11 forwarding, configured extra forwards, local commands, and connection-master reuse are disabled for this stream; strict host-key checks and batch key authentication remain on.

The private socket accepts a bounded versioned protocol, not arbitrary shell commands. SSH-authenticated same-account callers receive the reserved `ssh:<client UUID>` origin; Iroh device origins cannot use that namespace. Shared roots, operation allowlists, approvals, receipts, and controller-generation checks remain authoritative. Both transports publish the same live provider events and use the same snapshot catch-up. Closing the last connection from a device releases its controls and remote terminals. Local private IPC assumes the usual same-account trust boundary; it is not isolation from other processes running as that macOS account.

Requests and events are multiplexed over one SSH process per connected host. Frames are bounded, request concurrency and saved-host count are limited, event queues are bounded, and watch cancellation identifies the specific watch so an old cancellation cannot remove its replacement. SSH server keepalives detect broken links. Failed or timed-out mutations are not automatically replayed as new requests; existing receipt recovery remains available.

## Validation — 15 November 2026

- `cargo test -p gyro-remote --lib --locked`: 26 passed; one environment-specific OpenSSH test excluded by default.
- Explicit `actual_openssh_carries_requests_and_live_events -- --ignored`: passed using an isolated high-port local sshd, temporary keys/known-hosts, and a private socket. Verified real encrypted request/event delivery, unknown-host-key rejection, and host-socket cleanup on disconnect. No system SSH configuration or user's SSH keys were changed.
- Desktop `cargo check --locked`, workspace frontend typecheck, and production Vite build passed.
- Expanded production-component browser regression suite passed, including SSH validation/errors, host selection, saved-host reconnect/disconnect/remove, and sidebar discovery while local hosting is off. Existing pairing/chat/file/Git/terminal/usage checks still pass.
- Browser UI captures use explicit sample hosts. The complete app was subsequently reinstalled and checked natively on the Mac Mini. A temporary local OpenSSH server connected to the installed app and successfully read its two shared projects, a session snapshot, and chat history. The native SSH tab and expandable Environment card were inspected. MacBook-to-Mac-Mini physical acceptance and a new live-provider run remain outstanding.

See [OpenSSH ssh](https://man.openbsd.org/ssh) and [ssh_config](https://man.openbsd.org/ssh_config) for configuration and authentication behavior.
