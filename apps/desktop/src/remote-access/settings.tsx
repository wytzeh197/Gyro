import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ShieldCheck,
} from "../../../../packages/ui/node_modules/lucide-react";
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
  setDeviceKind,
  useDeviceKind,
} from "../../../../packages/ui/src/device-kind";
import { useRemoteAccess } from "./context";
import type { Peer } from "./types";
import { SshSettings } from "./ssh-settings";

/** Laptop or desktop icon for a device; the choice stays on this Mac. */
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
    if (
      invitation &&
      (status?.invitationActive === false || invitation.expiresAt * 1000 <= now)
    )
      setInvitation(undefined);
  }, [invitation, status?.invitationActive, now]);
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
  // One primary action per screen: approving a waiting device beats copying
  // a live invitation, which beats starting a new pairing.
  const pairIsPrimary = !pendingCount && !liveInvitation;
  const startInvitation = () =>
    void run(async () => {
      setInvitation(await action({ action: "invite" }));
    });
  return (
    <SettingsSection
      title="Remote access"
      description="Connect to another Mac and keep working in the same chats."
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
                    await action({ action: "configure", enabled: next, name });
                    setInvitation(undefined);
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
                  <button
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
                    onClick={startInvitation}
                  >
                    {liveInvitation ? "New invitation" : "Pair a device"}
                  </button>
                </div>
                {status.pending.map((peer, index) => (
                  <section
                    key={peer.id}
                    className="gyro-remote-sheet"
                    aria-label={`${peer.name} wants to connect`}
                  >
                    <strong className="gyro-remote-sheet-title">
                      {peer.name} wants to connect
                    </strong>
                    <p>Approve only if both Macs show the same code.</p>
                    <div className="gyro-remote-compare">
                      <div>
                        <DeviceIcon kind={ownKind} size={18} aria-hidden />
                        <span>This Mac</span>
                        <code>{fingerprint(peer.id)}</code>
                      </div>
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
                        onClick={() =>
                          void run(() =>
                            action({ action: "reject", peerId: peer.id }),
                          )
                        }
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className={
                          index === 0
                            ? "gyro-primary-button"
                            : "gyro-secondary-button"
                        }
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            action({ action: "approve", peerId: peer.id }),
                          )
                        }
                      >
                        <ShieldCheck size={14} aria-hidden /> Approve
                      </button>
                    </div>
                  </section>
                ))}
                {invitation && (
                  <section
                    className="gyro-remote-sheet"
                    aria-label="Pair a device"
                  >
                    <strong className="gyro-remote-sheet-title">
                      Pair a device
                    </strong>
                    <ol className="gyro-remote-steps">
                      <li className="is-done">
                        <Check size={14} aria-hidden /> Create an invitation
                      </li>
                      <li className={expired ? undefined : "is-active"}>
                        <span>2</span> Paste it on your other Mac
                      </li>
                      <li>
                        <span>3</span> Check the code matches
                      </li>
                    </ol>
                    <p>
                      On the other Mac, open Remote access › Join with an
                      invitation. Only pair devices you trust: a remote terminal
                      runs with this Mac user's access.
                    </p>
                    {expired ? (
                      <div className="gyro-remote-actions">
                        <SettingsStatus status="warning">
                          Expired
                        </SettingsStatus>
                        <span>Create a new invitation to pair.</span>
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
                            Expires in {countdown(secondsLeft)} · works once
                          </span>
                          <span className="gyro-remote-spacer" />
                          <button
                            type="button"
                            className="gyro-secondary-button"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await action({ action: "cancelInvitation" });
                                setInvitation(undefined);
                              })
                            }
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className={
                              pendingCount
                                ? "gyro-secondary-button"
                                : "gyro-primary-button"
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
                      onBlur={() => {
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
                  description="Projects in your sidebar are automatically available to paired Macs while remote access is on."
                >
                  {status.projects.length === 0 && (
                    <SettingsEmptyState
                      title="No sidebar projects yet"
                      description="Add a project to your sidebar to make it available to paired Macs."
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
                    <SettingsRow
                      key={peer.id}
                      label={peer.name}
                      detail={`${peer.role === "client" ? "Can connect to this Mac" : peer.role === "both" ? "Host and client" : "Host you can open"} · ${fingerprint(peer.id)}`}
                    >
                      {connectedHostIds.includes(peer.id) && (
                        <SettingsStatus status="good">Connected</SettingsStatus>
                      )}
                      <DeviceKindPicker id={peer.id} name={peer.name} compact />
                      <button
                        type="button"
                        className="gyro-secondary-button"
                        disabled={busy || !enabled}
                        onClick={() => selectHost(peer)}
                      >
                        {connectedHostIds.includes(peer.id)
                          ? "Open projects"
                          : "Connect"}
                      </button>
                      <button
                        type="button"
                        className="gyro-secondary-button"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            action({ action: "revoke", peerId: peer.id }),
                          )
                        }
                      >
                        Revoke
                      </button>
                    </SettingsRow>
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
      </div>
    </SettingsSection>
  );
}
