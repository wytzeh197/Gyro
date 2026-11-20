import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Copy,
  ShieldCheck,
} from "../../../../packages/ui/node_modules/lucide-react";
import { PairQr } from "./pair-qr";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  SettingsSegmented,
} from "../../../../packages/ui/src/settings-controls";
import {
  SettingsSection,
  SettingsStatus,
} from "../../../../packages/ui/src/settings-presentation";
import { SelectionTrack } from "../../../../packages/ui/src/selection-track";
import {
  DEVICE_KIND_OPTIONS,
  DeviceIcon,
  type DeviceKind,
  setDeviceKind,
  useDeviceKind,
} from "../../../../packages/ui/src/device-kind";
import { useRemoteAccess } from "./context";
import type { Peer } from "./types";
import { SshSettings } from "./ssh-settings";

/** Laptop or desktop icon for a Mac; the choice stays on this Mac. */
function DeviceKindPicker({
  id,
  name,
  compact = false,
}: {
  id: string;
  name: string;
  compact?: boolean;
}) {
  const kind = useDeviceKind(id, name);
  return (
    <SelectionTrack
      label={`Icon for ${name}`}
      className={`gyro-settings-segmented gyro-remote-device-kind${compact ? " is-compact" : ""}`}
      value={kind}
    >
      {DEVICE_KIND_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={kind === option.value}
          aria-label={compact ? option.label : undefined}
          title={compact ? option.label : undefined}
          className={kind === option.value ? "is-active" : ""}
          onClick={() => setDeviceKind(id, option.value)}
        >
          <DeviceIcon kind={option.value} size={14} aria-hidden />
          {!compact && <span>{option.label}</span>}
        </button>
      ))}
    </SelectionTrack>
  );
}

function PeerIcon({ peer, size = 18 }: { peer: Peer; size?: number }) {
  return (
    <DeviceIcon
      kind={useDeviceKind(peer.id, peer.name)}
      size={size}
      aria-hidden
    />
  );
}

/** A device asking to be trusted; phones compare one code, Macs two. */
function PendingApproval({
  peer,
  ownKind,
  primary,
  busy,
  onApprove,
  onReject,
}: {
  peer: Peer;
  ownKind: DeviceKind;
  primary: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isPhone = useDeviceKind(peer.id, peer.name) === "phone";
  return (
    <section
      className="gyro-remote-sheet"
      aria-label={`${peer.name} wants to connect`}
    >
      <strong className="gyro-remote-sheet-title">
        {peer.name} wants to connect
      </strong>
      <p>
        {isPhone
          ? "Approve only if your phone shows the same code. It can use shared projects, chats, files and terminals as this Mac's user."
          : "Approve only if both Macs show the same code."}
      </p>
      <div className={`gyro-remote-compare${isPhone ? " is-single" : ""}`}>
        {!isPhone && (
          <div>
            <DeviceIcon kind={ownKind} size={18} aria-hidden />
            <span>This Mac</span>
            <code>{fingerprint(peer.id)}</code>
          </div>
        )}
        <div>
          <PeerIcon peer={peer} />
          <span>{peer.name} should show</span>
          <code>{fingerprint(peer.id)}</code>
        </div>
      </div>
      <div className="gyro-remote-actions is-end">
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy}
          onClick={onReject}
        >
          Reject
        </button>
        <button
          type="button"
          className={primary ? "gyro-primary-button" : "gyro-secondary-button"}
          disabled={busy}
          onClick={onApprove}
        >
          <ShieldCheck size={14} aria-hidden /> Approve
        </button>
      </div>
    </section>
  );
}

/** Trusted-device controls; phones only connect to Macs, so they host nothing. */
function TrustedDeviceRow({
  peer,
  connected,
  busy,
  enabled,
  onOpen,
  onRevoke,
}: {
  peer: Peer;
  connected: boolean;
  busy: boolean;
  enabled: boolean;
  onOpen: () => void;
  onRevoke: () => void;
}) {
  const isPhone = useDeviceKind(peer.id, peer.name) === "phone";
  const role = isPhone
    ? "Phone"
    : peer.role === "client"
      ? "Can connect to this Mac"
      : peer.role === "both"
        ? "Host and client"
        : "Host you can open";
  return (
    <SettingsRow label={peer.name} detail={`${role} · ${fingerprint(peer.id)}`}>
      {connected && <SettingsStatus status="good">Connected</SettingsStatus>}
      {isPhone ? (
        <span className="gyro-remote-device-kind-fixed" title="Phone">
          <DeviceIcon kind="phone" size={14} aria-label="Phone" />
        </span>
      ) : (
        <>
          <DeviceKindPicker id={peer.id} name={peer.name} compact />
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy || !enabled}
            onClick={onOpen}
          >
            {connected ? "Open projects" : "Connect"}
          </button>
        </>
      )}
      <button
        type="button"
        className="gyro-secondary-button"
        disabled={busy}
        onClick={onRevoke}
      >
        Revoke
      </button>
    </SettingsRow>
  );
}

/** Device keys are hex; group them so people can compare them aloud. */
const fingerprint = (id: string) =>
  /^[0-9a-f]+$/i.test(id)
    ? (id
        .slice(0, 16)
        .match(/.{1,4}/g)
        ?.join(" ") ?? id)
    : id;
const countdown = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
export default function RemoteAccessSettings() {
  const pairingScopeId = useId();
  const [method, setMethod] = useState<"pairing" | "ssh">("pairing");
  const {
    status,
    error: loadError,
    action,
    refresh,
    connectedHostIds,
    selectHost,
  } = useRemoteAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState(status?.settings.name ?? "This Mac");
  const [invitation, setInvitation] = useState<{
    invitation: string;
    expiresAt: number;
  }>();
  const [pasted, setPasted] = useState("");
  const [pending, setPending] = useState<{
    hostId: string;
    peerId: string;
    status: string;
  }>();
  const [paired, setPaired] = useState<Peer>();
  // The pairing sheet stays open while its invitation is created, live or
  // expired; it closes once a device uses the invitation or it is cancelled.
  const [pairOpen, setPairOpen] = useState(false);
  const [pairTarget, setPairTarget] = useState<"phone" | "mac">("phone");
  const [inviteError, setInviteError] = useState<string>();
  const [justApproved, setJustApproved] = useState<string>();
  const peersRef = useRef(status?.peers);
  peersRef.current = status?.peers;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status) setName(status.settings.name);
  }, [status?.settings.name]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // An expired invitation stays on screen so the sheet can offer a new one.
    if (
      invitation &&
      status?.invitationActive === false &&
      invitation.expiresAt * 1000 > now
    ) {
      setInvitation(undefined);
      setPairOpen(false);
    }
  }, [invitation, status?.invitationActive, now]);
  useEffect(() => {
    if (!justApproved) return;
    const t = setTimeout(() => setJustApproved(undefined), 8000);
    return () => clearTimeout(t);
  }, [justApproved]);
  useEffect(() => {
    if (!pending || pending.status !== "pending") return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await action<{ status: string }>({
          action: "pairStatus",
          hostId: pending.hostId,
        });
        if (disposed) return;
        setError(undefined);
        if (result.status === "approved") {
          setPending(undefined);
          setPasted("");
          setPaired({
            id: pending.hostId,
            name:
              peersRef.current?.find((p) => p.id === pending.hostId)?.name ??
              "Paired Mac",
            role: "both",
          });
        } else if (result.status !== "pending")
          setPending({ ...pending, status: result.status });
      } catch {
        if (!disposed)
          setError(
            "Host unavailable. Keep Gyro open on both Macs and try again.",
          );
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), 2000);
    void poll();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [pending, action]);
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const expired = invitation && invitation.expiresAt * 1000 <= now;
  const secondsLeft = invitation
    ? Math.max(0, Math.ceil((invitation.expiresAt * 1000 - now) / 1000))
    : 0;
  const pairedPeers =
    status?.peers.filter((peer) => peer.transport !== "ssh") ?? [];
  const enabled = Boolean(status?.settings.enabled);
  const ownKind = useDeviceKind(status?.deviceId, status?.settings.name);
  const hostingDown = enabled && status?.hostingActive === false;
  const controls = status ? Object.entries(status.controls) : [];
  const peerName = (id: string) =>
    status?.peers.find((p) => p.id === id)?.name ?? "a paired device";
  const liveInvitation = invitation && !expired ? invitation : undefined;
  const pendingCount = status?.pending.length ?? 0;
  // One primary action per screen: approving a waiting device beats the
  // pairing sheet's own action, which beats opening the sheet.
  const pairIsPrimary = !pendingCount && !pairOpen;
  const sheetIsPrimary = !pendingCount;
  async function startInvitation() {
    if (busy) return;
    setPairOpen(true);
    setInviteError(undefined);
    setInvitation(undefined);
    setBusy(true);
    try {
      setInvitation(await action({ action: "invite" }));
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const closePairing = () =>
    void run(async () => {
      if (liveInvitation) await action({ action: "cancelInvitation" });
      setInvitation(undefined);
      setInviteError(undefined);
      setPairOpen(false);
    });
  return (
    <SettingsSection
      title="Remote access"
      description="Connect to another Mac using Gyro pairing or SSH. Phone pairing is coming soon."
    >
      <div className="gyro-remote-settings">
        {(error || (status && loadError)) && (
          <p className="gyro-remote-error" role="alert">
            {error ?? loadError}
          </p>
        )}
        {!status && !loadError ? (
          <SettingsEmptyState
            title="Loading remote access…"
            description="Reading this Mac's remote access state."
          />
        ) : !status ? (
          <SettingsEmptyState
            title="Remote access settings did not load"
            description={
              loadError ?? "Gyro could not read this Mac's remote access state."
            }
          >
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={() => void refresh()}
            >
              Retry loading settings
            </button>
          </SettingsEmptyState>
        ) : (
          <>
            <section className="gyro-remote-hero" aria-label="This Mac">
              <span className="gyro-remote-hero-icon" aria-hidden>
                <DeviceIcon kind={ownKind} size={18} />
              </span>
              <div className="gyro-remote-hero-text">
                <strong>{status.settings.name}</strong>
                <span role="status">
                  {hostingDown ? (
                    <SettingsStatus status="warning">
                      Unavailable
                    </SettingsStatus>
                  ) : enabled ? (
                    <SettingsStatus status="good">
                      {status.hostingActive ? "On · Reachable" : "On"}
                    </SettingsStatus>
                  ) : (
                    <SettingsStatus status="neutral">Off</SettingsStatus>
                  )}
                </span>
                {method === "pairing" && status.deviceId && (
                  <span className="gyro-remote-hero-code">
                    Device code{" "}
                    <code title="This Mac's device code">
                      {fingerprint(status.deviceId)}
                    </code>
                  </span>
                )}
              </div>
              <SettingsSwitch
                checked={status.settings.enabled}
                disabled={busy}
                label="Allow remote access"
                onChange={(next) =>
                  void run(async () => {
                    await action({ action: "configure", enabled: next, name: next ? name : status.settings.name });
                    setInvitation(undefined);
                    setPairOpen(false);
                  })
                }
              />
            </section>
            <div className="gyro-remote-methods">
              <SettingsSegmented
                label="Connection method"
                value={method}
                options={[
                  { label: "Gyro pairing", value: "pairing" },
                  { label: "SSH", value: "ssh" },
                ]}
                onChange={setMethod}
              />
            </div>
            {method === "ssh" ? (
              <SshSettings />
            ) : (
              <div className="gyro-remote-pairing" aria-label="Gyro pairing">
                <div className="gyro-remote-hero-meta">
                  <span>
                    {pairedPeers.length}{" "}
                    {pairedPeers.length === 1
                      ? "trusted device"
                      : "trusted devices"}
                  </span>
                  <span aria-hidden="true" className="gyro-remote-meta-dot">
                    ·
                  </span>
                  <span>
                    {status.projects.length}{" "}
                    {status.projects.length === 1
                      ? "shared project"
                      : "shared projects"}
                  </span>
                  {!enabled && (
                    <span className="gyro-remote-meta-hint">
                      Turn on remote access to pair
                    </span>
                  )}
                  {!pairOpen && (
                    <button
                      aria-describedby={pairingScopeId}
                      type="button"
                      className={
                        pairIsPrimary
                          ? "gyro-primary-button"
                          : "gyro-secondary-button"
                      }
                      disabled={busy || !enabled}
                      title={
                        enabled ? undefined : "Turn on remote access to pair"
                      }
                      onClick={() => void startInvitation()}
                    >
                      Pair a device
                    </button>
                  )}
                  {!pairOpen && (
                    <p className="gyro-remote-pairing-scope" id={pairingScopeId}>
                      Devices you approve can access shared projects, chats,
                      files, and terminals as this Mac’s user.
                    </p>
                  )}
                </div>
                {justApproved && (
                  <div className="gyro-remote-actions" role="status">
                    <SettingsStatus status="good">Paired</SettingsStatus>
                    <span>{justApproved} can now connect to this Mac.</span>
                  </div>
                )}
                {status.pending.map((peer, index) => (
                  <PendingApproval
                    key={peer.id}
                    peer={peer}
                    ownKind={ownKind}
                    primary={index === 0}
                    busy={busy}
                    onReject={() =>
                      void run(() =>
                        action({ action: "reject", peerId: peer.id }),
                      )
                    }
                    onApprove={() =>
                      void run(async () => {
                        await action({ action: "approve", peerId: peer.id });
                        setJustApproved(peer.name);
                      })
                    }
                  />
                ))}
                {pairOpen && (
                  <section
                    className="gyro-remote-sheet"
                    aria-label="Pair a device"
                  >
                    <div className="gyro-remote-sheet-head">
                      <strong className="gyro-remote-sheet-title">
                        Pair a device
                      </strong>
                      <SettingsSegmented
                        label="Device to pair"
                        value={pairTarget}
                        options={[
                          { label: "Phone (Coming soon)", value: "phone" },
                          { label: "Mac", value: "mac" },
                        ]}
                        onChange={setPairTarget}
                      />
                    </div>
                    {!invitation && inviteError ? (
                      <div className="gyro-remote-actions">
                        <SettingsStatus status="critical">
                          {pairTarget === "phone"
                            ? "Couldn't create a code"
                            : "Couldn't create an invitation"}
                        </SettingsStatus>
                        <span>{inviteError}</span>
                        <span className="gyro-remote-spacer" />
                        <button
                          type="button"
                          className="gyro-secondary-button"
                          disabled={busy}
                          onClick={closePairing}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className={
                            sheetIsPrimary
                              ? "gyro-primary-button"
                              : "gyro-secondary-button"
                          }
                          disabled={busy}
                          onClick={() => void startInvitation()}
                        >
                          Retry
                        </button>
                      </div>
                    ) : pairTarget === "phone" ? (
                      <>
                        <div className="gyro-remote-pair-phone">
                          {invitation ? (
                            <PairQr
                              value={invitation.invitation}
                              label="Pairing code for your phone"
                              faded={expired}
                            />
                          ) : (
                            <div
                              className="gyro-remote-qr is-loading"
                              role="status"
                            >
                              Creating a code…
                            </div>
                          )}
                          <div className="gyro-remote-pair-phone-text">
                            <ol className="gyro-remote-steps">
                              <li>
                                <span>1</span> Open Gyro on your phone
                              </li>
                              <li
                                className={
                                  invitation && !expired
                                    ? "is-active"
                                    : undefined
                                }
                              >
                                <span>2</span> Scan this code
                              </li>
                              <li>
                                <span>3</span> Check the code matches
                              </li>
                            </ol>
                            <p>
                              Only pair a phone you trust. It can use shared
                              projects, chats, files and terminals as this
                              Mac's user.
                            </p>
                          </div>
                        </div>
                        {expired ? (
                          <div className="gyro-remote-actions">
                            <SettingsStatus status="warning">
                              Expired
                            </SettingsStatus>
                            <span>Codes work for 5 minutes.</span>
                            <span className="gyro-remote-spacer" />
                            <button
                              type="button"
                              className="gyro-secondary-button"
                              disabled={busy}
                              onClick={closePairing}
                            >
                              Close
                            </button>
                            <button
                              type="button"
                              className={
                                sheetIsPrimary
                                  ? "gyro-primary-button"
                                  : "gyro-secondary-button"
                              }
                              disabled={busy}
                              onClick={() => void startInvitation()}
                            >
                              New code
                            </button>
                          </div>
                        ) : (
                          <div className="gyro-remote-actions">
                            <span role="timer">
                              {invitation
                                ? `Expires in ${countdown(secondsLeft)} · works once`
                                : "Codes work once, for 5 minutes."}
                            </span>
                            <span className="gyro-remote-spacer" />
                            <button
                              type="button"
                              className="gyro-secondary-button"
                              disabled={busy}
                              onClick={closePairing}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="gyro-secondary-button"
                              disabled={!invitation}
                              title="For a phone that can't scan: paste this in Gyro on the phone"
                              onClick={() =>
                                invitation &&
                                void run(() =>
                                  navigator.clipboard.writeText(
                                    invitation.invitation,
                                  ),
                                )
                              }
                            >
                              <Copy size={14} aria-hidden /> Copy code instead
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <ol className="gyro-remote-steps">
                          <li className="is-done">
                            <Check size={14} aria-hidden /> Create an invitation
                          </li>
                          <li
                            className={
                              invitation && !expired ? "is-active" : undefined
                            }
                          >
                            <span>2</span> Paste it on your other Mac
                          </li>
                          <li>
                            <span>3</span> Check the code matches
                          </li>
                        </ol>
                        <p>
                          On the other Mac, open Remote access › Join with an
                          invitation. Only pair devices you trust: a remote
                          terminal runs with this Mac user's access.
                        </p>
                        {!invitation ? (
                          <code className="gyro-remote-invite" role="status">
                            Creating an invitation…
                          </code>
                        ) : expired ? (
                          <div className="gyro-remote-actions">
                            <SettingsStatus status="warning">
                              Expired
                            </SettingsStatus>
                            <span>Invitations work for 5 minutes.</span>
                            <span className="gyro-remote-spacer" />
                            <button
                              type="button"
                              className="gyro-secondary-button"
                              disabled={busy}
                              onClick={closePairing}
                            >
                              Close
                            </button>
                            <button
                              type="button"
                              className={
                                sheetIsPrimary
                                  ? "gyro-primary-button"
                                  : "gyro-secondary-button"
                              }
                              disabled={busy}
                              onClick={() => void startInvitation()}
                            >
                              New invitation
                            </button>
                          </div>
                        ) : (
                          <>
                            <code
                              id="gyro-copy-invitation"
                              className="gyro-remote-invite"
                              aria-label="Invitation for your other Mac"
                              title={invitation.invitation}
                            >
                              {invitation.invitation}
                            </code>
                            <div className="gyro-remote-actions">
                              <span role="timer">
                                Expires in {countdown(secondsLeft)} · works
                                once
                              </span>
                              <span className="gyro-remote-spacer" />
                              <button
                                type="button"
                                className="gyro-secondary-button"
                                disabled={busy}
                                onClick={closePairing}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className={
                                  sheetIsPrimary
                                    ? "gyro-primary-button"
                                    : "gyro-secondary-button"
                                }
                                onClick={() =>
                                  void run(() =>
                                    navigator.clipboard.writeText(
                                      invitation.invitation,
                                    ),
                                  )
                                }
                              >
                                <Copy size={14} aria-hidden /> Copy invitation
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </section>
                )}
                {hostingDown && (
                  <p className="gyro-remote-error" role="status">
                    This Mac isn't reachable. Turn remote access off and on to
                    retry; check the connection and try again.
                  </p>
                )}
                <SettingsGroup id="remote-this-mac" label="This Mac">
                  <SettingsRow
                    label="Device name"
                    detail="Shown on devices you pair with. Traffic is end-to-end encrypted; relay operators can see connection metadata."
                  >
                    <input
                      className="gyro-settings-input"
                      aria-label="Device name"
                      value={name}
                      maxLength={80}
                      onChange={(event) => setName(event.target.value)}
                      onBlur={(event) => {
                        if (event.relatedTarget?.getAttribute("aria-label") === "Allow remote access") return;
                        if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) {
                          setError("Use a device name between 1 and 80 characters");
                          return;
                        }
                        if (name !== status.settings.name)
                          void run(() =>
                            action({
                              action: "configure",
                              enabled: status.settings.enabled,
                              name,
                            }),
                          );
                      }}
                    />
                  </SettingsRow>
                  {status.deviceId && (
                    <SettingsRow
                      label="Icon"
                      detail="How this Mac appears in your sidebar and settings."
                    >
                      <DeviceKindPicker
                        id={status.deviceId}
                        name={status.settings.name}
                      />
                    </SettingsRow>
                  )}
                </SettingsGroup>
                <SettingsGroup
                  id="remote-shared-projects"
                  label="Shared projects"
                  summary={
                    status.projects.length
                      ? `${status.projects.length} shared`
                      : undefined
                  }
                  description="Projects in your sidebar are automatically available to paired devices while remote access is on."
                >
                  {status.projects.length === 0 && (
                    <SettingsEmptyState
                      title="No sidebar projects yet"
                      description="Add a project to your sidebar to make it available to paired devices."
                    />
                  )}
                  {status.projects.map((project) => (
                    <SettingsRow
                      key={project.id}
                      label={project.name}
                      detail={project.path}
                    />
                  ))}
                </SettingsGroup>
                <SettingsGroup
                  id="remote-trusted-devices"
                  label="Trusted devices"
                  defaultOpen={pairedPeers.length > 0}
                  summary={
                    pairedPeers.length
                      ? `${pairedPeers.length} ${pairedPeers.length === 1 ? "device" : "devices"}`
                      : undefined
                  }
                >
                  {pairedPeers.length === 0 && (
                    <SettingsEmptyState
                      title="No trusted devices yet"
                      description="Devices you pair appear here."
                    />
                  )}
                  {pairedPeers.map((peer) => (
                    <TrustedDeviceRow
                      key={peer.id}
                      peer={peer}
                      connected={connectedHostIds.includes(peer.id)}
                      busy={busy}
                      enabled={enabled}
                      onOpen={() => selectHost(peer)}
                      onRevoke={() =>
                        void run(() =>
                          action({ action: "revoke", peerId: peer.id }),
                        )
                      }
                    />
                  ))}
                </SettingsGroup>
                {controls.length > 0 && (
                  <SettingsGroup
                    id="remote-session-control"
                    label="Session control"
                    attention={controls.some(
                      ([, control]) =>
                        control.owner === "local" && Boolean(control.requestedBy),
                    )}
                    description="One device controls a coding session at a time."
                  >
                    {controls.map(([sessionId, control]) => (
                      <SettingsRow
                        key={sessionId}
                        label={`Session ${sessionId.slice(0, 8)}`}
                        detail={
                          control.owner === "local"
                            ? control.requestedBy
                              ? `${peerName(control.requestedBy)} asked for control`
                              : "Controlled on this Mac"
                            : `Controlled by ${peerName(control.owner)}`
                        }
                      >
                        {control.owner === "local" && control.requestedBy && (
                          <button
                            type="button"
                            className="gyro-secondary-button"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                action({
                                  action: "transfer",
                                  sessionId,
                                  peerId: control.requestedBy,
                                }),
                              )
                            }
                          >
                            Allow requesting device
                          </button>
                        )}
                        <button
                          type="button"
                          className="gyro-secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              action({
                                action:
                                  control.owner === "local"
                                    ? "release"
                                    : "reclaim",
                                sessionId,
                              }),
                            )
                          }
                        >
                          {control.owner === "local"
                            ? "Release control"
                            : "Take control"}
                        </button>
                      </SettingsRow>
                    ))}
                  </SettingsGroup>
                )}
                <SettingsGroup
                  id="remote-connect"
                  label="Join with an invitation"
                  description="Paste an invitation created on the Mac you want to use."
                >
                  <div className="gyro-remote-stack">
                    <textarea
                      id="gyro-paste-invitation"
                      aria-label="Invitation from the host Mac"
                      className="gyro-settings-input"
                      placeholder="gyro-pair-v1:…"
                      value={pasted}
                      onChange={(event) => setPasted(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <div className="gyro-remote-actions">
                      <button
                        type="button"
                        className="gyro-secondary-button"
                        disabled={busy || !pasted.trim()}
                        onClick={() =>
                          void run(async () => {
                            setPending(
                              await action({
                                action: "pair",
                                invitation: pasted,
                              }),
                            );
                            setPasted("");
                          })
                        }
                      >
                        {busy ? "Connecting…" : "Request pairing"}
                      </button>
                      {pending && (
                        <span role="status">
                          {pending.status === "pending" ? (
                            <SettingsStatus status="info">
                              Waiting for approval · check the host shows{" "}
                              {fingerprint(pending.peerId)}
                            </SettingsStatus>
                          ) : pending.status === "approved" ? (
                            <SettingsStatus status="good">
                              Approved
                            </SettingsStatus>
                          ) : (
                            <SettingsStatus status="critical">
                              Rejected or expired
                            </SettingsStatus>
                          )}
                        </span>
                      )}
                      {paired && (
                        <button
                          type="button"
                          className="gyro-secondary-button"
                          onClick={() => selectHost(paired)}
                        >
                          Open remote workspace
                        </button>
                      )}
                    </div>
                  </div>
                </SettingsGroup>
              </div>
            )}
          </>
        )}
        {status && <SettingsGroup label="Recent device activity" description="Latest 50 records. Repeated actions are counted together. Prompts, file contents and terminal input are never recorded here.">
          {!status.activity?.length ? <SettingsEmptyState title="No device activity yet" description="Actions from connected devices appear here." /> : status.activity.map((entry) => (
            <SettingsRow key={entry.id} label={`${status.peers.find((peer) => peer.id === entry.peerId)?.name ?? (entry.peerId.startsWith("ssh:") ? "SSH device" : fingerprint(entry.peerId))} · ${entry.action}`}
              detail={`${new Date(entry.at * 1000).toLocaleString()}${entry.count > 1 ? ` · ${entry.count} times` : ""}${entry.sessionId ? ` · Chat ${entry.sessionId.slice(0, 8)}` : ""}`}>
              <SettingsStatus status={entry.ok ? "good" : "critical"}>{entry.ok ? "Succeeded" : "Failed"}</SettingsStatus>
            </SettingsRow>
          ))}
        </SettingsGroup>}
      </div>
    </SettingsSection>
  );
}
