import { useState, type ReactNode } from "react";
import {
  FolderIcon,
  LaptopIcon,
  SmartphoneIcon,
  MoreHorizontalIcon,
  CloudIcon,
  UserRoundIcon,
  ChevronRightIcon,
} from "@gyro-dev/ui";
import "./cloud-v3-layout.css";

export type CloudTab = "projects" | "chats" | "usage";
export type CloudPanel =
  | "transfers"
  | "connection"
  | "billing"
  | "projects"
  | "chats"
  | "versions"
  | "reports"
  | "phone"
  | "assistance"
  | "devices"
  | "export";
export type CloudProfile = {
  accountId: string;
  email: string;
  displayName: string;
  deviceId?: string;
};
export const cloudBytes = (value: number) =>
  `${(value / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
export const cloudMoney = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value / 1e6);
const size = (value: number) =>
  value < 1e9
    ? `${(value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
    : cloudBytes(value);
const time = (value?: string) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Time not available";
const day = (value?: string) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
        new Date(value),
      )
    : "Not available";
const localNote =
  "Your local projects and providers work independently of Cloud.";

export function CloudMeter({
  label,
  used,
  limit,
  reserved = 0,
  heading = false,
}: {
  label: string;
  used: number;
  limit: number;
  reserved?: number;
  heading?: boolean;
}) {
  const measured = Number.isFinite(used) && Number.isFinite(limit) && limit > 0;
  const total = Math.max(0, used + reserved);
  const percent = measured ? Math.min(100, (total / limit) * 100) : 0;
  return (
    <div className={`gyro-cloud-meter${heading ? " is-heading" : ""}`}>
      <div>
        <span>{label}</span>
        <span>
          {measured
            ? `${cloudBytes(used)} of ${cloudBytes(limit)}`
            : "Usage unavailable"}
        </span>
      </div>
      <progress
        aria-label={label}
        value={measured ? percent : undefined}
        max={100}
        data-level={
          percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal"
        }
      />
      {reserved > 0 && (
        <small>{cloudBytes(reserved)} reserved for pending saves</small>
      )}
    </div>
  );
}

function LinkRow({
  title,
  detail,
  value,
  onClick,
}: {
  title: string;
  detail?: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="gyro-cloud-link-row" onClick={onClick}>
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {value && <span className="gyro-cloud-link-value">{value}</span>}
      <ChevronRightIcon size={16} aria-hidden="true" />
    </button>
  );
}

export function CloudDeviceList({
  devices,
  currentId,
  limit,
  compact = false,
  hideCount = false,
}: {
  devices: any[];
  currentId?: string;
  limit?: number;
  compact?: boolean;
  hideCount?: boolean;
}) {
  const active = devices.filter((d) => !d.revokedAt);
  return (
    <div className={`gyro-cloud-device-list${compact ? " is-compact" : ""}`}>
      {!hideCount && (
        <p className="gyro-cloud-caption">
          {active.length}
          {limit ? ` of ${limit}` : ""}{" "}
          {active.length === 1 ? "device" : "devices"}
        </p>
      )}
      {active.length === 0 ? (
        <p className="gyro-cloud-muted">No registered devices.</p>
      ) : (
        active.map((d) => {
          const phone = d.platform === "ios" || /iphone|ipad/i.test(d.label);
          const Icon = phone ? SmartphoneIcon : LaptopIcon;
          return (
            <div className="gyro-cloud-device-row" key={d.id}>
              <Icon size={22} aria-hidden="true" />
              <div>
                <strong>{d.label}</strong>
                {currentId === d.id ? (
                  <small className="gyro-cloud-this-device">This Mac</small>
                ) : (
                  <small>
                    {d.lastSeenAt
                      ? `Last seen ${time(d.lastSeenAt)}`
                      : "Last seen not available"}
                  </small>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function CloudAccountPage({
  profile,
  devices,
  usage,
  busy,
  previewLabel,
  onEdit,
  onPanel,
  onSignOut,
  children,
}: {
  profile: CloudProfile | null;
  devices: any[];
  usage: any;
  busy: boolean;
  previewLabel?: string;
  onEdit: (name: string) => Promise<void>;
  onPanel: (panel: CloudPanel) => void;
  onSignOut: () => void;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const displayName = profile?.displayName || "Gyro account";
  const initials = profile?.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((v) => v[0])
    .join("")
    .toUpperCase();
  return (
    <section
      className="gyro-cloud-workspace gyro-cloud-account-page"
      aria-labelledby="gyro-account-title"
    >
      <header className="gyro-cloud-page-header">
        <div>
          <h1 id="gyro-account-title">
            <UserRoundIcon size={22} aria-hidden="true" />
            Account
          </h1>
          <p>Your identity and access to Gyro Cloud.</p>
        </div>
        {previewLabel && (
          <span className="gyro-cloud-sample">{previewLabel}</span>
        )}
      </header>
      {children}
      <div className="gyro-cloud-account-summary">
        <span className="gyro-account-profile-avatar">
          {initials || <UserRoundIcon size={22} />}
        </span>
        <div>
          <strong>{displayName}</strong>
          <small>{profile?.email || "Profile could not be loaded"}</small>
        </div>
        <span className="gyro-cloud-signed-in">Signed in</span>
        {!editing && (
          <button
            type="button"
            className="gyro-primary-button"
            disabled={busy || !profile}
            onClick={() => {
              setName(profile?.displayName || "");
              setEditing(true);
            }}
          >
            Edit profile
          </button>
        )}
      </div>
      <section
        className="gyro-cloud-band"
        aria-labelledby="gyro-profile-heading"
      >
        <h2 id="gyro-profile-heading">Profile</h2>
        {editing ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await onEdit(name.trim());
                setEditing(false);
              } catch {
                /* Parent presents the actual error. */
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) setEditing(false);
            }}
          >
            <label className="gyro-cloud-profile-field">
              <span>Display name</span>
              <input
                autoFocus
                className="gyro-cloud-input"
                value={name}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="gyro-cloud-actions">
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button className="gyro-primary-button" disabled={busy}>
                {busy ? "Saving…" : "Save profile"}
              </button>
            </div>
          </form>
        ) : (
          <dl className="gyro-cloud-profile-details">
            <div>
              <dt>Display name</dt>
              <dd>{profile?.displayName || "Not set"}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{profile?.email || "Not available"}</dd>
            </div>
          </dl>
        )}
      </section>
      <section
        className="gyro-cloud-band"
        aria-labelledby="gyro-account-devices"
      >
        <div className="gyro-cloud-band-heading">
          <div className="gyro-cloud-device-heading">
            <h2 id="gyro-account-devices">Devices</h2>
            <span className="gyro-cloud-caption">
              {devices.filter((d) => !d.revokedAt).length}
              {usage?.policy.devices ? ` of ${usage.policy.devices}` : ""}{" "}
              devices
            </span>
          </div>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={() => onPanel("devices")}
          >
            Manage devices
          </button>
        </div>
        <CloudDeviceList
          hideCount
          devices={devices}
          currentId={profile?.deviceId}
          limit={usage?.policy.devices}
        />
      </section>
      <LinkRow
        title="Plan & billing"
        value={
          usage?.policy.id === "plus"
            ? "Gyro Plus"
            : usage?.active
              ? "Gyro Cloud"
              : "No active plan"
        }
        onClick={() => onPanel("billing")}
      />
      <div className="gyro-cloud-signout">
        <button
          type="button"
          className="gyro-cloud-text-button"
          disabled={busy}
          onClick={onSignOut}
        >
          Sign out
        </button>
        <p className="gyro-cloud-caption">
          Signing out keeps local projects and provider logins on this Mac.
        </p>
      </div>
    </section>
  );
}

export function CloudOverview({
  tab,
  onTab,
  onRefresh,
  checkAllowed,
  mobileAllowed,
  usage,
  wallet,
  versions,
  devices,
  profile,
  busy,
  stale,
  hasMore,
  previewLabel,
  pendingCount,
  preparedCount = pendingCount,
  onSave,
  onRestore,
  onPanel,
  children,
}: {
  tab: CloudTab;
  onTab: (tab: CloudTab) => void;
  onRefresh: () => void;
  checkAllowed: boolean;
  mobileAllowed: boolean;
  usage: any;
  wallet: any;
  versions: any[];
  devices: any[];
  profile: CloudProfile | null;
  busy: boolean;
  stale: boolean;
  hasMore: boolean;
  previewLabel?: string;
  pendingCount: number;
  preparedCount?: number;
  onSave: () => void;
  onRestore: (version: any) => void;
  onPanel: (panel: CloudPanel, objectId?: string) => void;
  children?: ReactNode;
}) {
  const projects = Array.from(
    new Set(
      versions.filter((v) => v.kind === "project").map((v) => v.object_id),
    ),
  ).map((id) => {
    const all = versions.filter(
      (v) => v.kind === "project" && v.object_id === id,
    );
    const latest = all.find((v) => v.id === v.head_id) || all[0];
    return {
      latest,
      count: all.length,
      hasHead: latest.id === latest.head_id,
      conflict: all.some((v) => v.conflict),
    };
  });
  return (
    <section
      className="gyro-cloud-workspace"
      data-cloud-tab={tab}
      aria-labelledby="gyro-cloud-title"
    >
      <header className="gyro-cloud-page-header">
        <div>
          <h1 id="gyro-cloud-title">
            <CloudIcon size="var(--gyro-font-lead)" aria-hidden="true" />
            Gyro Cloud
          </h1>
          <p>
            {tab === "usage"
              ? "See what you use and which devices have access."
              : "Save only the projects and chats you choose."}
          </p>
        </div>
        <div className="gyro-cloud-header-aside">
          {previewLabel && (
            <span className="gyro-cloud-sample">{previewLabel}</span>
          )}
          {tab !== "usage" && (
            <button
              type="button"
              className="gyro-cloud-text-button"
              onClick={() => onPanel("billing")}
            >
              Plan & billing
            </button>
          )}
        </div>
      </header>
      {children}
      {tab === "projects" && (
        <div className="gyro-cloud-page-action">
          <button
            type="button"
            className="gyro-primary-button"
            disabled={busy || stale || !usage?.active}
            onClick={onSave}
          >
            Save a project
          </button>
          {preparedCount > 0 && (
            <button
              type="button"
              className="gyro-cloud-text-button"
              onClick={() => onPanel("transfers")}
            >
              {pendingCount > 0
                ? `${pendingCount} pending ${pendingCount === 1 ? "save" : "saves"}`
                : `${preparedCount} prepared ${preparedCount === 1 ? "copy" : "copies"}`}
            </button>
          )}
        </div>
      )}
      <nav className="gyro-cloud-tabs" aria-label="Cloud pages">
        {(
          [
            ["projects", "Projects"],
            ["chats", "Chats"],
            ["usage", "Usage & devices"],
          ] as const
        ).map(([id, text]) => (
          <button
            type="button"
            key={id}
            className={tab === id ? "is-current" : undefined}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => onTab(id)}
          >
            {text}
            {tab === id && <span className="gyro-cloud-tab-indicator" aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <div className="gyro-cloud-tab-content">
        {tab === "projects" && (
          <>
            <section aria-labelledby="gyro-saved-projects">
              <h2 id="gyro-saved-projects">Saved projects</h2>
              {projects.length ? (
                <div
                  className="gyro-cloud-project-table"
                  role="table"
                  aria-label="Saved projects"
                >
                  <div className="gyro-cloud-project-columns" role="row">
                    <span role="columnheader">Project</span>
                    <span role="columnheader">Latest save</span>
                    <span role="columnheader">Versions</span>
                    <span
                      role="columnheader"
                      className="gyro-cloud-visually-hidden"
                    >
                      Actions
                    </span>
                  </div>
                  {projects.map(({ latest: v, count, hasHead, conflict }) => (
                    <div
                      className="gyro-cloud-project-row"
                      role="row"
                      key={v.object_id}
                    >
                      <div role="cell" className="gyro-cloud-project-name">
                        <FolderIcon size={23} aria-hidden="true" />
                        <div>
                          <strong>{v.label}</strong>
                          <small>
                            {size(Number(v.size_bytes))}
                            {v.device_label ? ` · ${v.device_label}` : ""}
                            {conflict ? " · Conflict preserved" : ""}
                          </small>
                        </div>
                      </div>
                      <span role="cell" className="gyro-cloud-project-date">
                        {time(v.created_at)}
                        {!hasHead && <small>Latest loaded save</small>}
                      </span>
                      <div role="cell">
                        <button
                          type="button"
                          className="gyro-cloud-text-button gyro-cloud-version-count"
                          onClick={() => onPanel("versions", v.object_id)}
                        >
                          {count}
                          {hasMore ? "+" : ""}{" "}
                          {count === 1 && !hasMore ? "version" : "versions"}
                        </button>
                      </div>
                      <div role="cell" className="gyro-cloud-project-controls">
                        <button
                          type="button"
                          className="gyro-secondary-button"
                          disabled={busy}
                          aria-label={`Restore copy of ${v.label}`}
                          onClick={() => onRestore(v)}
                        >
                          Restore copy
                        </button>
                        <button
                          type="button"
                          className="gyro-cloud-icon-button"
                          aria-label={`Manage versions of ${v.label}`}
                          onClick={() => onPanel("versions", v.object_id)}
                        >
                          <MoreHorizontalIcon size={19} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="gyro-cloud-empty">
                  <FolderIcon size={26} aria-hidden="true" />
                  <h3>
                    {stale
                      ? "Saved projects unavailable"
                      : "No projects saved yet"}
                  </h3>
                  <p>
                    Choose a project and review the files before anything leaves
                    this Mac.
                  </p>
                </div>
              )}
              <p className="gyro-cloud-caption">
                Restores create a new folder. Your local files stay untouched.
              </p>
              {hasMore && (
                <button
                  type="button"
                  className="gyro-cloud-text-button"
                  onClick={() => onPanel("versions")}
                >
                  Browse all saved versions
                </button>
              )}
            </section>
            <section
              className="gyro-cloud-storage-strip"
              aria-label="Shared Cloud storage"
            >
              {usage ? (
                <>
                  <CloudMeter
                    label="Storage"
                    used={usage.storage.used}
                    limit={usage.policy.storageBytes}
                    reserved={usage.storage.reserved}
                    heading
                  />
                  <button
                    type="button"
                    className="gyro-cloud-text-button"
                    onClick={() => onPanel("versions")}
                  >
                    Manage storage
                  </button>
                  <p className="gyro-cloud-caption">
                    Projects, chats and saved versions share this space.
                  </p>
                </>
              ) : (
                <p className="gyro-cloud-muted">
                  Storage usage is unavailable. Refresh status before saving.
                </p>
              )}
            </section>
            <LinkRow
              title="Selected chats"
              detail="Chat backup has its own consent"
              onClick={() => onTab("chats")}
            />
          </>
        )}
        {tab === "chats" && (
          <>
            {preparedCount > 0 && (
              <p className="gyro-cloud-feedback">
                <button
                  type="button"
                  className="gyro-cloud-text-button"
                  onClick={() => onPanel("transfers")}
                >
                  {pendingCount > 0 ? `${pendingCount} pending ${pendingCount === 1 ? "save" : "saves"} · continue transfer`
                    : `${preparedCount} prepared ${preparedCount === 1 ? "copy" : "copies"}`}
                </button>
              </p>
            )}
            <div className="gyro-cloud-band-heading">
              <div>
                <h2>Selected chats</h2>
                <p className="gyro-cloud-caption">
                  Choose and review each chat separately. Session permissions
                  stay on this Mac.
                </p>
              </div>
              <button
                type="button"
                className="gyro-primary-button"
                disabled={busy || stale || !usage?.active}
                onClick={() => onPanel("chats")}
              >
                Back up a chat
              </button>
            </div>
            {versions.some((v) => v.kind === "chat") ? (
              versions
                .filter((v) => v.kind === "chat")
                .map((v) => (
                  <LinkRow
                    key={v.id}
                    title={v.label}
                    detail={time(v.created_at)}
                    value="Read archive"
                    onClick={() => onPanel("versions", v.object_id)}
                  />
                ))
            ) : (
              <div className="gyro-cloud-empty">
                <h3>No chats backed up</h3>
                <p>
                  Your local chats stay private until you select and review a
                  backup.
                </p>
              </div>
            )}
            <LinkRow
              title="Agent handoffs & assistance"
              detail="Review selected context before sending it to the managed model."
              onClick={() => onPanel("assistance")}
            />
          </>
        )}
        {tab === "chats" && checkAllowed && (
          <LinkRow
            title="Saved Check reports"
            onClick={() => onPanel("reports")}
          />
        )}
        {tab === "usage" && (
          <>
            <div className="gyro-cloud-usage-grid">
              <div className="gyro-cloud-usage-main">
                <section className="gyro-cloud-band">
                  <h2>Storage</h2>
                  {usage ? (
                    <CloudMeter
                      label="Stored data"
                      used={usage.storage.used}
                      limit={usage.policy.storageBytes}
                      reserved={usage.storage.reserved}
                    />
                  ) : (
                    <p className="gyro-cloud-muted">Usage unavailable.</p>
                  )}
                  <p className="gyro-cloud-caption">
                    Projects, chats and saved versions share this space.
                  </p>
                  <button
                    type="button"
                    className="gyro-cloud-text-button"
                    onClick={() => onPanel("versions")}
                  >
                    Manage saved versions
                  </button>
                </section>
                <section className="gyro-cloud-band">
                  <h2>Monthly transfers</h2>
                  {usage ? (
                    <>
                      <CloudMeter
                        label="Uploaded"
                        used={usage.transfer.uploaded}
                        limit={usage.policy.uploadBytes}
                        reserved={usage.transfer.reserved}
                      />
                      <CloudMeter
                        label="Downloaded"
                        used={usage.transfer.downloaded}
                        limit={usage.policy.downloadBytes}
                      />
                      <p className="gyro-cloud-caption">
                        Resets {day(usage.resetAt)}
                        {Number.isSafeInteger(usage.operations) &&
                          Number.isSafeInteger(
                            usage.policy.operationsPerPeriod,
                          ) && (
                            <>
                              {" "}
                              · {usage.operations.toLocaleString()} /{" "}
                              {usage.policy.operationsPerPeriod.toLocaleString()}{" "}
                              standard operations
                            </>
                          )}
                      </p>
                      {usage.recoveryRequests && (
                        <p className="gyro-cloud-caption">
                          {usage.recoveryRequests.used.toLocaleString()} / {usage.recoveryRequests.limit.toLocaleString()} status and recovery requests · resets {day(usage.recoveryRequests.resetAt)} (UTC month). Account export and security controls use separate limits.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="gyro-cloud-muted">
                      Transfer usage unavailable.
                    </p>
                  )}
                </section>
                <section className="gyro-cloud-band">
                  <h2>Managed AI</h2>
                  {wallet ? (
                    <>
                      <p className="gyro-cloud-wallet-total">
                        {cloudMoney(wallet.availableMicros)} available of{" "}
                        {cloudMoney(wallet.includedMicros)} included
                      </p>
                      <dl className="gyro-cloud-wallet-ledger">
                        <div>
                          <dt>Spent</dt>
                          <dd>{cloudMoney(wallet.spentMicros)}</dd>
                        </div>
                        <div>
                          <dt>Held</dt>
                          <dd>{cloudMoney(wallet.heldMicros)}</dd>
                        </div>
                      </dl>
                      <p className="gyro-cloud-caption">
                        {usage?.policy.aiMicros === 0
                          ? "Managed AI is not included in this plan. Your own providers and local checks remain available."
                          : "Shared by eligible managed features. Stops at the allowance."}
                      </p>
                    </>
                  ) : (
                    <p className="gyro-cloud-muted">AI balance unavailable.</p>
                  )}
                  <button
                    type="button"
                    className="gyro-cloud-text-button"
                    onClick={() => onPanel("assistance")}
                  >
                    View usage & assistance
                  </button>
                </section>
              </div>
              <aside
                className="gyro-cloud-device-aside"
                aria-labelledby="gyro-cloud-devices"
              >
                <h2 id="gyro-cloud-devices">Devices</h2>
                <CloudDeviceList
                  devices={devices}
                  currentId={profile?.deviceId}
                  limit={usage?.policy.devices}
                  compact
                />
                <button
                  type="button"
                  className="gyro-primary-button"
                  disabled={busy}
                  onClick={() => onPanel("devices")}
                >
                  Manage devices
                </button>
                <div className="gyro-cloud-aside-links">
                  <LinkRow
                    title="Plan & billing"
                    onClick={() => onPanel("billing")}
                  />
                  <LinkRow
                    title="Export Cloud data"
                    onClick={() => onPanel("export")}
                  />
                </div>
              </aside>
            </div>
            <div className="gyro-cloud-local-footer">
              <p className="gyro-cloud-local-note">{localNote}</p>
              <button
                type="button"
                className="gyro-cloud-text-button"
                disabled={busy}
                onClick={onRefresh}
              >
                Refresh status
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
