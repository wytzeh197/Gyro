import { completedSave } from "./cloud-v3-transfer-state";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CloudIcon,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  UserRoundIcon,
  CloseIcon,
} from "@gyro-dev/ui";
import {
  CloudAccountPage,
  CloudOverview,
  type CloudTab,
  type CloudPanel,
  type CloudProfile,
} from "./cloud-v3-layout";
import { PendingCloudSaves } from "./cloud-v3-transfers";
import config from "../../../config/cloud-v3.json";
import availability from "../../../config/cloud-availability.json";
import "./gyro-cloud.css";
// Explicit local staging build only; the normal release stays disabled.
const cloudV3StagingBuild = import.meta.env.MODE === "cloud-v3-staging";
export const cloudV3Enabled = (availability.enabled && config.enabled) || cloudV3StagingBuild;
export type { V3Invoke } from "./cloud-v3-client";
import {
  verifiedV3Client,
  signOutAndRefresh,
  type V3Invoke,
} from "./cloud-v3-client";
const native: V3Invoke = (request) => invoke("cloud_v3", { request });
const gb = (n: number) =>
  `${(n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
const fileSize = (n: number) =>
  n < 1e6
    ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
    : n < 1e9
      ? `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
      : gb(n);
const usd = (n: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 3,
  }).format(n / 1e6);
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString() : "Not available";
type Preview = {
  ticket: string;
  files: { path: string; size: number }[];
  excluded: string[];
  sensitiveFindings: string[];
  payloadBytes: number;
};
/** Uses the product's existing settings blocks, controls and semantic tokens. */
export function CloudV3Settings({
  call: rawCall = native,
  previewLabel = cloudV3StagingBuild
    ? "Private staging · Test access · No real charges. Billing, managed AI, deletion and device revocation are unavailable."
    : undefined,
  page = "cloud",
  initialTab = "projects",
  openExternal = (url: string) =>
    invoke<void>("plugin:opener|open_url", { url }),
}: {
  call?: V3Invoke;
  previewLabel?: string;
  page?: "account" | "cloud" | "billing";
  initialTab?: CloudTab;
  openExternal?: (url: string) => Promise<void>;
}) {
  const call = useMemo(() => verifiedV3Client(rawCall), [rawCall]);
  const [tab, setTab] = useState<CloudTab>(initialTab);
  const [panel, setPanel] = useState<CloudPanel | null>(null);
  const [panelObject, setPanelObject] = useState<string | undefined>();
  const [profile, setProfile] = useState<CloudProfile | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (panel && dialog.current && !dialog.current.open)
      dialog.current.showModal();
    if (!panel && dialog.current?.open) dialog.current.close();
  }, [panel]);
  function openPanel(next: CloudPanel, objectId?: string) {
    setPanelObject(objectId);
    setRevoking(null);
    setPanel(next);
  }
  const [view, setView] = useState<any>(null),
    [usage, setUsage] = useState<any>(null),
    [wallet, setWallet] = useState<any>(null),
    [versions, setVersions] = useState<any[]>([]),
    [pending, setPending] = useState<any[]>([]),
    [devices, setDevices] = useState<any[]>([]);
  const [capabilities, setCapabilities] = useState<any>({ phone: false });
  const [catalog, setCatalog] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]),
    [reportPreview, setReportPreview] = useState<any>(null),
    [readReport, setReadReport] = useState<any>(null),
    [reportConsent, setReportConsent] = useState(false);
  const [phonePair, setPhonePair] = useState<any>(null),
    [phoneDevices, setPhoneDevices] = useState<any[]>([]),
    [phonePreview, setPhonePreview] = useState<any>(null),
    [phoneConsent, setPhoneConsent] = useState(false);
  const [runningTransfers, setRunningTransfers] = useState<string[]>([]);
  const [transferOutcomes, setTransferOutcomes] = useState<
    Record<string, string>
  >({});
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [codeRequested, setCodeRequested] = useState(false),
    [remember, setRemember] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null),
    [reviewed, setReviewed] = useState(false),
    [label, setLabel] = useState("Project"),
    [deleting, setDeleting] = useState<string | null>(null);
  const [chats, setChats] = useState<any[]>([]),
    [chatPreview, setChatPreview] = useState<any>(null),
    [chatConsent, setChatConsent] = useState(false),
    [readChat, setReadChat] = useState<any>(null);
  const [context, setContext] = useState(""),
    [task, setTask] = useState("handoff-summary"),
    [aiConsent, setAiConsent] = useState(false),
    [job, setJob] = useState<any>(null),
    [exportState, setExportState] = useState<any>(null);
  const inFlight = useRef(false),
    aiRequest = useRef<string | null>(null);
  const [stale, setStale] = useState(false),
    [checkedAt, setCheckedAt] = useState<string | null>(null),
    [targetObject, setTargetObject] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    setCheckedAt(null);
    setProfile(null);
    setVersions([]);
    setUsage(null);
    setWallet(null);
    setDevices([]);
    setPending([]);
    setTransferOutcomes({});
    setPreview(null);
    setChatPreview(null);
    setReadChat(null);
    setChats([]);
    setReviewed(false);
    setChatConsent(false);
    setContext("");
    setAiConsent(false);
    setJob(null);
    aiRequest.current = null;
    setExportState(null);
    setReports([]);
    setReportPreview(null);
    setReadReport(null);
    setReportConsent(false);
    setPhonePair(null);
    setPhoneDevices([]);
    setPhonePreview(null);
    setPhoneConsent(false);
    setCapabilities({ phone: false });
    setCatalog(null);
  }, [view?.accountId]);
  useEffect(() => {
    alive.current = true;
    void call({ operation: "view" })
      .then(setView)
      .catch(() =>
        setError("Cloud could not be checked. Local work remains available."),
      );
    return () => {
      alive.current = false;
    };
  }, [call]);
  useEffect(() => {
    if (view && !view.connected) {
      setCode("");
      setCodeRequested(false);
    }
  }, [view?.connected]);
  useEffect(() => {
    window.dispatchEvent(new Event("gyro-cloud-v3-account-changed"));
  }, [view?.connected, view?.accountId]);
  const notifyAccount = () =>
    window.dispatchEvent(new Event("gyro-cloud-v3-account-changed"));
  const disconnect = () => signOutAndRefresh(call, refresh, notifyAccount);
  const service = (operation: string, fields: Record<string, unknown> = {}) =>
    call({ operation: "service", command: { operation, ...fields } });
  async function refresh() {
    const v = await call({ operation: "view" });
    if (!alive.current) return;
    setView(v);
    if (v.connected) {
      const results = await Promise.allSettled([
        service("usage"),
        service("wallet"),
        service("versions", { objectId: null }),
        call({ operation: "pending" }),
        service("devices"),
        service("capabilities"),
        call({ operation: "profile" }),
        service("policy"),
      ]);
      setStale(results.some((r) => r.status === "rejected"));
      setCheckedAt(new Date().toISOString());
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") {
          setError(
            "Some Cloud status could not be refreshed. Displayed values may be stale.",
          );
          continue;
        }
        if (i === 2) setVersionCursor(r.value.nextCursor);
        [
          setUsage,
          setWallet,
          setVersions,
          setPending,
          setDevices,
          setCapabilities,
          setProfile,
          setCatalog,
        ][i]!(i === 4 || i === 2 ? r.value.items : r.value);
      }
    } else {
      setProfile(null);
      setPanel(null);
      setUsage(null);
      setWallet(null);
      setVersions([]);
      setPending([]);
      setDevices([]);
    }
  }
  useEffect(() => {
    if (view?.connected) void action(refresh);
  }, [view?.connected]);
  useEffect(() => {
    if (!view?.connected || !pending.some((p) =>
      p.localRunning || (transferOutcomes[p.requestId] || p.cloudStatus) === "verifying")) return;
    const waiting = new Set(pending.filter((p) =>
      p.localRunning || (transferOutcomes[p.requestId] || p.cloudStatus) === "verifying").map((p) => p.requestId));
    const deadline = Date.now() + 15 * 60 * 1000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const items = await call({ operation: "pending" });
        if (stopped) return;
        setPending(items);
        const observed = items.filter((p: any) => waiting.has(p.requestId));
        let done = false;
        for (const p of observed) if (completedSave(p)) {
          waiting.delete(p.requestId); done = true;
        }
        setTransferOutcomes((old) => {
          const next = { ...old };
          for (const p of observed) if (p.cloudStatus) next[p.requestId] = p.cloudStatus;
          return next;
        });
        if (done) { setNotice("Version saved to Cloud."); await refresh(); }
      } catch { /* Preserve the last verified state; next explicit refresh can retry. */ }
      if (!stopped && Date.now() < deadline) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [view?.connected, pending.some((p) =>
    p.localRunning || (transferOutcomes[p.requestId] || p.cloudStatus) === "verifying"), call]);
  async function action(work: () => Promise<void>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function resumeTransfer(requestId: string) {
    if (runningTransfers.includes(requestId)) return;
    setRunningTransfers((ids) => [...ids, requestId]);
    setError("");
    setNotice("");
    try {
      const r = await call({ operation: "resume", requestId });
      if (alive.current) {
        setTransferOutcomes((old) => ({
          ...old,
          [requestId]: String(r.status),
        }));
        setNotice(
          r.status === "verifying"
            ? "Upload received. Cloud is checking the save."
            : r.status === "committed"
              ? "Version saved to Cloud."
              : r.status === "conflict"
                ? "Saved as a separate conflict version."
                : "Cloud status checked.",
        );
      }
    } catch (e) {
      if (alive.current) {
        setTransferOutcomes((old) => ({ ...old, [requestId]: "paused" }));
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (alive.current) {
        setRunningTransfers((ids) => ids.filter((id) => id !== requestId));
        await refresh().catch(() => setStale(true));
      }
    }
  }
  async function openBilling(
    kind: "checkout" | "billing",
    planId: "cloud" | "plus" = "cloud",
  ) {
    const r = await service(
      kind,
      kind === "checkout" ? { requestId: crypto.randomUUID(), planId } : {},
    );
    if (typeof r.url !== "string") throw new Error("Billing URL unavailable.");
    const u = new URL(r.url);
    if (
      !["https://checkout.stripe.com", "https://billing.stripe.com"].includes(
        u.origin,
      )
    )
      throw new Error("Billing URL could not be verified.");
    await openExternal(r.url);
  }
  if (view?.configured && view.connected && !checkedAt)
    return (
      <SettingsSection
        icon={page === "account" ? UserRoundIcon : CloudIcon}
        title={
          page === "account"
            ? "Account"
            : page === "billing"
              ? "Plan & billing"
              : "Gyro Cloud"
        }
      >
        <p role={error ? "alert" : "status"}>
          {error || "Loading Cloud data…"}
        </p>
        {error && (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={() => void action(refresh)}
          >
            Try again
          </button>
        )}
      </SettingsSection>
    );
  const visibleVersions = panelObject
    ? versions.filter((v) => v.object_id === panelObject)
    : versions;
  const panelTitles: Record<CloudPanel, string> = {
    transfers: "Prepared Cloud saves",
    connection: "Cloud connection",
    billing: "Plan & billing",
    projects: "Review project save",
    chats: "Selected chat backup",
    versions: "Saved versions",
    reports: "Saved Check reports",
    phone: "Gyro Mobile · iOS",
    assistance: "Managed assistance",
    devices: "Manage devices",
    export: "Export Cloud data",
  };
  const workflows = {
    transfers: () => (
      <PendingCloudSaves
        items={pending}
        running={runningTransfers}
        outcomes={transferOutcomes}
        busy={busy}
        onClose={() => setPanel(null)}
        onResume={(id) => void resumeTransfer(id)}
        onRestart={(id) =>
          action(async () => {
            if (
              runningTransfers.includes(id) ||
              pending.find((p) => p.requestId === id)?.localRunning
            )
              throw new Error("Stop the active save before restarting it.");
            await call({ operation: "renew", requestId: id });
            setTransferOutcomes((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
            setNotice(
              "Upload restarted for your reviewed copy. Choose Upload to continue.",
            );
            await refresh();
          })
        }
        onRemove={(id) =>
          action(async () => {
            await call({ operation: "cancel", requestId: id });
            await refresh();
            setNotice(
              "Prepared copy removed. Original files and saved Cloud versions are preserved.",
            );
          })
        }
      />
    ),
    connection: () => (
      <SettingsGroup label="Connection" defaultOpen>
        {view.registered === false && (
          <SettingsRow
            label="Register this Mac"
            detail="If your device allowance is full, revoke a lost or unused device below, then retry. A previously revoked Mac needs a fresh sign-in and a new registration identity."
          >
            <div className="gyro-cloud-actions">
              <button
                className="gyro-secondary-button"
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "register-device",
                      newIdentity: false,
                    });
                    await refresh();
                  })
                }
              >
                Retry registration
              </button>
              <button
                className="gyro-secondary-button"
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "register-device",
                      newIdentity: true,
                    });
                    await refresh();
                  })
                }
              >
                Register a new device identity
              </button>
            </div>
          </SettingsRow>
        )}
        <SettingsRow
          label="Cloud account"
          detail="Local files and user-owned providers remain independent."
          value={stale ? "Signed in · status unavailable" : "Connected"}
        />
        <div className="gyro-cloud-actions">
          <button
            className="gyro-secondary-button"
            onClick={() => void action(refresh)}
          >
            Refresh status
          </button>
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                await disconnect();
              })
            }
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    ),
    billing: () =>
      usage ? (
        <SettingsGroup label="Plan & billing" defaultOpen>
          <SettingsRow
            label={
              usage.policy.id === "plus"
                ? "Gyro Plus"
                : usage.policy.id === "max"
                  ? "Gyro Max"
                  : "Gyro Cloud"
            }
            value={
              cloudV3StagingBuild
                ? usage.active
                  ? "Staging test access active"
                  : "No active staging test access"
                : usage.active
                  ? "Paid access active"
                  : "No active paid access"
            }
            detail={
              cloudV3StagingBuild
                ? "Temporary test access is verified by the staging service. No purchase or payment was made."
                : "Subscription status and allowances are verified by the Cloud service."
            }
          />
          <SettingsRow
            label="Current allowances"
            detail={`${usage.policy.devices ?? "Unreported"} devices · ${gb(usage.policy.storageBytes)} storage · ${gb(usage.policy.uploadBytes)} upload · ${gb(usage.policy.downloadBytes)} download per period`}
          />
          <SettingsRow label="Allowance reset" value={date(usage.resetAt)} />
          <SettingsRow
            label="Managed AI allowance"
            value={`${usd(wallet?.includedMicros ?? 0)} per period`}
            detail={
              usage.policy.aiMicros === 0
                ? "Managed AI is not included. Your own providers and local checks remain available."
                : "Eligible managed features share one pool. Usage stops at its limit; no automatic top-ups."
            }
          />
          {catalog ? (
            <>
              <SettingsRow
                label="Gyro Free"
                value="$0"
                detail="The local app, supported user-owned providers and local/BYO checks remain free. No Cloud account is required."
              />
              {(["cloud", "plus", "max"] as const).map((id) => {
                const p = catalog.plans[id];
                const available =
                  id === "cloud"
                    ? capabilities.cloudPurchase === true
                    : id === "plus"
                      ? capabilities.plusPurchase === true
                      : false;
                return (
                  <SettingsRow
                    key={id}
                    label={`Gyro ${id === "cloud" ? "Cloud" : id === "plus" ? "Plus" : "Max"} · ${available ? "Available" : id === "max" ? "Later" : "Not available yet"}`}
                    value={`${usd(p.priceMinor * 10000)}/month before tax`}
                    detail={`${p.devices} devices · ${gb(p.storageBytes)} shared storage · ${gb(p.uploadBytes)} upload / ${gb(p.downloadBytes)} download · ${p.operationsPerPeriod.toLocaleString()} standard operations · ${usd(p.aiMicros)} shared managed AI.${catalog.serviceLimits ? ` ${catalog.serviceLimits.recoveryOperations[id].toLocaleString()} status and recovery requests per UTC month; separate export and security limits.` : ""} Projects, chats and versions share storage.`}
                  />
                );
              })}
            </>
          ) : (
            <SettingsRow
              label="Plan details unavailable"
              detail="Refresh Cloud status to retrieve the server's current plan limits."
            />
          )}

          {!usage.active && (
            <SettingsRow
              label="Export access ends"
              value={date(usage.exportUntil)}
            />
          )}
          {!cloudV3StagingBuild && (
            <>
              <p>
                Cancelling keeps paid access through the paid period, followed
                by a 30-day read and export window. The billing page shows
                applicable tax and the final total before payment.
              </p>
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={() =>
                  void action(() =>
                    openBilling(usage.active ? "billing" : "checkout"),
                  )
                }
                disabled={
                  stale || (!usage.active && !capabilities.cloudPurchase)
                }
              >
                {usage.active
                  ? "Manage renewal and cancellation"
                  : capabilities.cloudPurchase
                    ? "Open Cloud checkout"
                    : "Cloud is not available for purchase yet"}
              </button>
              {!usage.active && capabilities.plusPurchase && (
                <button
                  type="button"
                  className="gyro-secondary-button"
                  onClick={() =>
                    void action(() => openBilling("checkout", "plus"))
                  }
                >
                  Open Plus checkout
                </button>
              )}
            </>
          )}
        </SettingsGroup>
      ) : (
        <p>
          Billing status is unavailable. Refresh Cloud status before continuing.
        </p>
      ),
    projects: () => (
      <SettingsGroup label="Project saves" defaultOpen>
        <SettingsRow
          label="Manual project save"
          detail="Review files and exclusions before upload. Git history, generated files and common credential files are excluded. Encryption is server-managed."
        >
          <button
            className={
              preview ? "gyro-secondary-button" : "gyro-primary-button"
            }
            disabled={!usage?.active || stale}
            onClick={() =>
              void action(async () => {
                const r = await call({ operation: "preview-project" });
                if (!r.cancelled) {
                  setPreview(r);
                  setReviewed(false);
                }
              })
            }
          >
            Choose project
          </button>
        </SettingsRow>
        {preview && (
          <div className="gyro-auth-card">
            <h2>Review project save</h2>
            <label className="gyro-auth-field">
              <span>Save version of</span>
              <select
                className="gyro-cloud-input"
                value={targetObject}
                onChange={(e) => setTargetObject(e.target.value)}
              >
                <option value="">New Cloud project</option>
                {versions
                  .filter(
                    (v, i, a) =>
                      v.kind === "project" &&
                      a.findIndex((x) => x.object_id === v.object_id) === i,
                  )
                  .map((v) => (
                    <option key={v.object_id} value={v.object_id}>
                      {v.label}
                    </option>
                  ))}
              </select>
            </label>
            <p>
              {preview.files.length} files · {fileSize(preview.payloadBytes)} ·
              maximum 2 GB
            </p>
            <label className="gyro-auth-field">
              <span>Name</span>
              <input
                className="gyro-cloud-input"
                value={label}
                maxLength={120}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <details>
              <summary>Included files</summary>
              <pre>{preview.files.map((f) => f.path).join("\n")}</pre>
            </details>
            <details>
              <summary>Excluded paths ({preview.excluded.length})</summary>
              <pre>{preview.excluded.join("\n") || "None"}</pre>
            </details>
            <p>
              Secret screening can miss credentials. Review the selection before
              saving. Chat backup and model context have separate consent.
            </p>
            {preview.sensitiveFindings.length > 0 && (
              <p role="alert">
                Review possible sensitive content:{" "}
                {preview.sensitiveFindings.join(", ")}
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />{" "}
              I reviewed the files, exclusions and sensitive findings and want
              to upload this project.
            </label>
            <div className="gyro-cloud-actions">
              <button
                className="gyro-secondary-button"
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "discard-preview",
                      ticket: preview.ticket,
                    });
                    setPreview(null);
                  })
                }
              >
                Close preview
              </button>
              <button
                className="gyro-primary-button"
                disabled={!reviewed}
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "prepare",
                      ticket: preview.ticket,
                      objectId: targetObject || crypto.randomUUID(),
                      baseRevisionId: targetObject
                        ? (versions.find((v) => v.object_id === targetObject)
                            ?.head_id ?? null)
                        : null,
                      label,
                      reviewed,
                    });
                    setPreview(null);
                    setNotice(
                      "Snapshot prepared on disk. Resume its upload below.",
                    );
                    await refresh();
                  })
                }
              >
                Prepare save
              </button>
            </div>
          </div>
        )}
        {pending.length > 0 && (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={() => openPanel("transfers")}
          >
            Continue {pending.length} prepared{" "}
            {pending.length === 1 ? "save" : "saves"}
          </button>
        )}
      </SettingsGroup>
    ),
    chats: () => (
      <SettingsGroup label="Selected chats" defaultOpen>
        <SettingsRow
          label="Chat backup"
          detail="Choose and review each supported text archive separately. Provider sessions, credentials and permissions are excluded."
        >
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () =>
                setChats((await call({ operation: "local-chats" })).items),
              )
            }
          >
            Choose chat
          </button>
        </SettingsRow>
        {chats.map((c) => (
          <SettingsRow key={c.id} label={c.title || "Untitled chat"}>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  setChatPreview(
                    await call({
                      operation: "preview-chat",
                      localId: c.id,
                      projectRevision: null,
                    }),
                  );
                  setChatConsent(false);
                  setChats([]);
                })
              }
            >
              Preview
            </button>
          </SettingsRow>
        ))}
        {chatPreview && (
          <div className="gyro-auth-card">
            <h2>Review chat backup</h2>
            <pre>
              {chatPreview.content.archive.messages
                .map((m: any) => `${m.role}: ${m.text}`)
                .join("\n\n")}
            </pre>
            <p>{chatPreview.content.unsupported.join(" ")}</p>
            <label>
              <input
                type="checkbox"
                checked={chatConsent}
                onChange={(e) => setChatConsent(e.target.checked)}
              />{" "}
              I want to save this selected chat to Cloud.
            </label>
            <button
              className="gyro-primary-button"
              disabled={!chatConsent}
              onClick={() =>
                void action(async () => {
                  await call({
                    operation: "save-chat",
                    ticket: chatPreview.ticket,
                    objectId: crypto.randomUUID(),
                    reviewed: chatConsent,
                  });
                  setChatPreview(null);
                  await refresh();
                  openPanel("transfers");
                })
              }
            >
              Prepare chat backup
            </button>
          </div>
        )}
      </SettingsGroup>
    ),
    versions: () => (
      <SettingsGroup label="Saved versions" defaultOpen>
        {versionCursor && (
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                const page = await service("versions", {
                  objectId: null,
                  cursor: versionCursor,
                });
                setVersions((old) => [...old, ...page.items]);
                setVersionCursor(page.nextCursor);
              })
            }
          >
            Load more versions
          </button>
        )}
        <p>
          Restores create a new local folder. Conflicting versions are
          preserved. Nothing is run or approved when you restore.
        </p>
        {visibleVersions.length === 0 ? (
          <SettingsRow
            label="No committed versions"
            detail="Only verified saves appear here."
          />
        ) : (
          visibleVersions.map((v) => (
            <SettingsRow
              key={v.id}
              label={`${v.label}${v.conflict ? " · conflict version" : ""}`}
              detail={`${gb(Number(v.size_bytes))} · ${date(v.created_at)}`}
            >
              <div className="gyro-cloud-actions">
                <button
                  className="gyro-secondary-button"
                  onClick={() =>
                    void action(async () => {
                      if (v.kind === "project") {
                        const restored = await call({
                          operation: "restore-project",
                          revisionId: v.id,
                        });
                        if (restored.cancelled) return;
                        setNotice("Project restored into a new local folder.");
                        await refresh();
                      } else if (v.kind === "report") {
                        setReadReport(
                          await call({
                            operation: "read-report",
                            revisionId: v.id,
                          }),
                        );
                      } else if (v.kind === "chat") {
                        setReadChat(
                          await call({
                            operation: "read-chat",
                            revisionId: v.id,
                          }),
                        );
                      }
                    })
                  }
                  disabled={!["project", "chat", "report"].includes(v.kind)}
                >
                  {v.kind === "chat"
                    ? "Read chat"
                    : v.kind === "report"
                      ? "Read report"
                      : "Restore copy"}
                </button>
                <button
                  className="gyro-secondary-button"
                  onClick={() => setDeleting(v.id)}
                >
                  Delete version
                </button>
              </div>
            </SettingsRow>
          ))
        )}
        {deleting && (
          <div role="group" aria-label="Confirm version deletion">
            <p>
              Delete this Cloud version? Local files stay on this Mac. Deletion
              is permanent.
            </p>
            <button
              className="gyro-secondary-button"
              onClick={() => setDeleting(null)}
            >
              Keep version
            </button>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  await service("delete-version", {
                    revisionId: deleting,
                  });
                  setDeleting(null);
                  await refresh();
                })
              }
            >
              Delete this version
            </button>
          </div>
        )}
        {readChat && (
          <div className="gyro-auth-card">
            <h2>Saved chat · read-only</h2>
            <pre>
              {readChat.archive.messages
                .map((m: any) => `${m.role}: ${m.text}`)
                .join("\n\n")}
            </pre>
            <p>{readChat.unsupported?.join(" ")}</p>
            <p>
              Review this context and copy it into a fresh agent session using
              current local permissions.
            </p>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  await navigator.clipboard.writeText(
                    readChat.archive.messages
                      .map((m: any) => `${m.role}: ${m.text}`)
                      .join("\n\n"),
                  );
                  setNotice(
                    "Reviewed context copied. Start a fresh agent session.",
                  );
                })
              }
            >
              Copy context
            </button>
            <button
              className="gyro-secondary-button"
              onClick={() => setReadChat(null)}
            >
              Close archive
            </button>
          </div>
        )}
      </SettingsGroup>
    ),
    reports: () => (
      <SettingsGroup label="Saved Check reports" defaultOpen>
        <SettingsRow
          label="Review a local report"
          detail="Local and user-owned checks stay free. Plus saves a reviewed text report with observed passed, failed and not-checked evidence; saved reports grant no execution permission."
        >
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                setChats((await call({ operation: "local-chats" })).items);
              })
            }
          >
            Choose a local chat
          </button>
        </SettingsRow>
        {chats.map((chat) => (
          <SettingsRow key={chat.id} label={chat.title}>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  const r = await call({
                    operation: "local-reports",
                    localId: chat.id,
                  });
                  setReports(
                    r.items.map((v: any) => ({
                      ...v,
                      localId: chat.id,
                    })),
                  );
                })
              }
            >
              List saved checks
            </button>
          </SettingsRow>
        ))}
        {reports.map((report) => (
          <SettingsRow
            key={report.id}
            label={`Check · ${date(report.finishedAt)}`}
            detail={
              report.stale
                ? "Potentially stale"
                : "Freshness is checked again before sharing."
            }
          >
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  setReportPreview(
                    await call({
                      operation: "preview-report",
                      localId: report.localId,
                      reportId: report.id,
                    }),
                  );
                  setReportConsent(false);
                })
              }
            >
              Review report
            </button>
          </SettingsRow>
        ))}
        {reportPreview && (
          <div className="gyro-auth-card">
            <pre>{reportPreview.content.text}</pre>
            <label>
              <input
                type="checkbox"
                checked={reportConsent}
                onChange={(e) => setReportConsent(e.target.checked)}
              />{" "}
              I reviewed this sanitized report and want to save it to Cloud.
            </label>
            <div className="gyro-cloud-actions">
              <button
                className="gyro-secondary-button"
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "discard-preview",
                      ticket: reportPreview.ticket,
                    });
                    setReportPreview(null);
                  })
                }
              >
                Cancel report save
              </button>
              <button
                className="gyro-button"
                disabled={!reportConsent}
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "save-report",
                      ticket: reportPreview.ticket,
                      objectId: crypto.randomUUID(),
                      reviewed: reportConsent,
                    });
                    setReportPreview(null);
                    await refresh();
                  })
                }
              >
                Prepare report save
              </button>
            </div>
          </div>
        )}
      </SettingsGroup>
    ),
    phone: () => (
      <SettingsGroup label="Gyro Mobile · iOS" defaultOpen>
        <SettingsRow
          label="Pair a phone"
          detail="Later feature under acceptance. Each phone counts as a device. Pairing expires in five minutes; no approvals, task starts or replies are available."
        >
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                setPhonePair(await service("phone-pair"));
              })
            }
          >
            Create pairing code
          </button>
        </SettingsRow>
        {phonePair && (
          <div className="gyro-auth-card">
            <p>
              Open {phonePair.url} on your phone. Expires{" "}
              {date(phonePair.expiresAt)}.
            </p>
            <label className="gyro-auth-field">
              <span>Pairing ID</span>
              <input
                className="gyro-cloud-input"
                readOnly
                value={phonePair.pairId}
              />
            </label>
            <label className="gyro-auth-field">
              <span>Pairing secret</span>
              <input
                className="gyro-cloud-input"
                type="password"
                readOnly
                value={phonePair.secret}
              />
            </label>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  await navigator.clipboard.writeText(phonePair.secret);
                  setNotice(
                    "Pairing secret copied. Paste it only into your companion page.",
                  );
                })
              }
            >
              Copy pairing secret
            </button>
            <button
              className="gyro-secondary-button"
              onClick={() => setPhonePair(null)}
            >
              Hide pairing code
            </button>
          </div>
        )}
        <SettingsRow
          label="Selected phone content"
          detail="Review up to three recent supported text messages before publishing a manual snapshot. Execution status is marked not checked. Automatic live status remains a later integration."
        >
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                setChats((await call({ operation: "local-chats" })).items);
              })
            }
          >
            Choose content
          </button>
        </SettingsRow>
        {chats.map((chat) => (
          <SettingsRow key={chat.id} label={chat.title}>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  setPhonePreview(
                    await call({
                      operation: "preview-phone",
                      localId: chat.id,
                    }),
                  );
                  setPhoneConsent(false);
                })
              }
            >
              Review phone snapshot
            </button>
          </SettingsRow>
        ))}
        {phonePreview && (
          <div className="gyro-auth-card">
            <pre>{JSON.stringify(phonePreview.content, null, 2)}</pre>
            <label>
              <input
                type="checkbox"
                checked={phoneConsent}
                onChange={(e) => setPhoneConsent(e.target.checked)}
              />{" "}
              Publish only this reviewed content to paired read-only phones.
            </label>
            <div className="gyro-cloud-actions">
              <button
                className="gyro-secondary-button"
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "discard-preview",
                      ticket: phonePreview.ticket,
                    });
                    setPhonePreview(null);
                  })
                }
              >
                Cancel publication
              </button>
              <button
                className="gyro-button"
                disabled={!phoneConsent}
                onClick={() =>
                  void action(async () => {
                    await call({
                      operation: "publish-phone",
                      ticket: phonePreview.ticket,
                      reviewed: phoneConsent,
                    });
                    setPhonePreview(null);
                    setNotice(
                      "Selected snapshot published. It becomes labelled offline when updates stop.",
                    );
                  })
                }
              >
                Publish selected snapshot
              </button>
            </div>
          </div>
        )}
        <SettingsRow label="Paired phones">
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () =>
                setPhoneDevices(await service("phone-devices")),
              )
            }
          >
            Refresh phones
          </button>
        </SettingsRow>
        {phoneDevices.map((d) => (
          <SettingsRow
            key={d.id}
            label={d.label}
            detail={d.revoked_at ? "Revoked" : `Expires ${date(d.expires_at)}`}
          >
            <button
              className="gyro-secondary-button"
              disabled={!!d.revoked_at}
              onClick={() =>
                void action(async () => {
                  await service("revoke-phone", { deviceId: d.id });
                  setPhoneDevices(await service("phone-devices"));
                })
              }
            >
              Revoke phone
            </button>
          </SettingsRow>
        ))}
      </SettingsGroup>
    ),
    assistance: () => (
      <SettingsGroup label="Managed assistance" defaultOpen>
        <SettingsRow
          label="Selected managed model"
          detail={
            wallet?.usable
              ? "Qualified model · uses the shared USD allowance"
              : "Managed assistance is unavailable or awaiting qualification"
          }
          value={wallet?.model ?? "Unavailable"}
        />
        <p>
          Review exactly the context you want to send to the displayed managed
          model. Saving a project does not authorize model access.
        </p>
        <label className="gyro-auth-field">
          <span>Feature</span>
          <select
            className="gyro-cloud-input"
            value={task}
            onChange={(e) => {
              setTask(e.target.value);
              aiRequest.current = null;
              setAiConsent(false);
            }}
          >
            <option value="handoff-summary">Draft an agent handoff</option>
            <option value="failure-explanation">
              Explain a selected error
            </option>
            {wallet?.checkAllowed && (
              <>
                <option value="check-plan">Propose a check plan</option>
                <option value="test-suggestions">Suggest tests</option>
                <option value="change-review">Review a selected diff</option>
                <option value="check-comparison">Compare check evidence</option>
              </>
            )}
          </select>
        </label>
        <label>
          <span>Selected context</span>
          <textarea
            className="gyro-cloud-input gyro-v3-context"
            value={context}
            onChange={(e) => {
              setContext(e.target.value);
              setAiConsent(false);
              aiRequest.current = null;
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={aiConsent}
            onChange={(e) => setAiConsent(e.target.checked)}
          />{" "}
          Send this context to the selected Gyro-managed model using my shared
          allowance.
        </label>
        <div className="gyro-cloud-actions">
          <button
            className="gyro-secondary-button"
            disabled={
              !aiConsent ||
              !context ||
              !wallet?.availableMicros ||
              !wallet?.usable ||
              stale
            }
            onClick={() =>
              void action(async () => {
                setJob(
                  await service("submit", {
                    requestId:
                      aiRequest.current ??
                      (aiRequest.current = crypto.randomUUID()),
                    task,
                    context,
                    sourceIds: [],
                    reviewed: aiConsent,
                  }),
                );
                await refresh();
              })
            }
          >
            Request draft
          </button>
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                setJob(await service("recover-last-job"));
                await refresh();
              })
            }
          >
            Recover last request
          </button>
          {job && (
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  setJob(await service("job", { jobId: job.id }));
                  await refresh();
                })
              }
            >
              Check request
            </button>
          )}
        </div>
        {job && (
          <p role="status">
            Request {job.status}
            {job.model ? ` · ${job.model}` : ""}
          </p>
        )}
        {job?.result && (
          <div>
            <p>{job.result.summary}</p>
            {job.result.items.map((i: any, n: number) => (
              <p key={n}>{i.text}</p>
            ))}
            <p>{job.result.limitations.join(" ")}</p>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                void action(async () => {
                  await navigator.clipboard.writeText(
                    [
                      job.result.summary,
                      ...job.result.items.map((i: any) => i.text),
                      ...job.result.limitations,
                    ].join("\n\n"),
                  );
                  setNotice(
                    "Draft copied for your review before sending to an agent.",
                  );
                })
              }
            >
              Copy draft for review
            </button>
          </div>
        )}
      </SettingsGroup>
    ),
    devices: () => (
      <SettingsGroup label="Devices" defaultOpen>
        {devices.map((d) => (
          <SettingsRow
            key={d.id}
            label={d.label}
            value={d.revokedAt ? "Revoked" : undefined}
          >
            {!d.revokedAt && (
              <button
                className="gyro-secondary-button"
                onClick={() =>
                  void action(async () => {
                    if (revoking !== d.id) {
                      setRevoking(d.id);
                      return;
                    }
                    await service("revoke-device", { deviceId: d.id });
                    setRevoking(null);
                    await refresh();
                  })
                }
              >
                {revoking === d.id ? "Confirm revoke" : "Revoke device"}
              </button>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
    ),
    export: () => (
      <SettingsGroup label="Account export" defaultOpen>
        <SettingsRow
          label="Export your saved data"
          detail="A separate bounded, resumable path remains available when normal transfer allowances are exhausted and for 30 days after paid access ends."
        >
          <button
            className="gyro-secondary-button"
            onClick={() =>
              void action(async () => {
                const r = await service("begin-export");
                setExportState(r);
                const saved = await call({
                  operation: "export-files",
                  exportId: r.id,
                });
                if (!saved.cancelled)
                  setNotice(
                    `Exported ${saved.exported} verified versions to a separate folder.`,
                  );
              })
            }
          >
            Prepare account export
          </button>
        </SettingsRow>
        {exportState && (
          <p role="status">
            Export ready until {date(exportState.expires_at)}. Export
            identifier: {exportState.id}. Separate retry budget at preparation:{" "}
            {fileSize(exportState.exportServedBytes)} used of{" "}
            {fileSize(exportState.exportByteLimit)};{" "}
            {exportState.exportOperationLimit.toLocaleString()} operations per
            paid period. Cancelling an export does not reset this budget.
            Contact support if recovery exhausts it; no paid overages apply.
          </p>
        )}
      </SettingsGroup>
    ),
  };
  const feedback = (
    <>
      {view?.connected && view?.registered === false && (
        <p role="status" className="gyro-cloud-feedback">
          This Mac needs registration before saving.{" "}
          <button
            type="button"
            className="gyro-cloud-text-button"
            disabled={busy}
            onClick={() => openPanel("connection")}
          >
            Register this Mac
          </button>
        </p>
      )}
      {stale && (
        <p role="status" className="gyro-cloud-feedback">
          Some Cloud status is unavailable. Values may be stale.{" "}
          <button
            type="button"
            className="gyro-cloud-text-button"
            disabled={busy}
            onClick={() => void action(refresh)}
          >
            Refresh status
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="gyro-cloud-feedback">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" aria-live="polite" className="gyro-cloud-feedback">
          {notice}
        </p>
      )}
      {usage &&
        [
          usage.storage.warning,
          usage.transfer.uploadWarning,
          usage.transfer.downloadWarning,
        ].some(Boolean) && (
          <p role="status" className="gyro-cloud-feedback">
            An allowance is near or at its limit. New saves stop at capacity.
            Local files and existing versions are preserved.{" "}
            <button
              type="button"
              className="gyro-cloud-text-button"
              onClick={() => openPanel("versions")}
            >
              Manage saved versions
            </button>
          </p>
        )}
    </>
  );
  const contractRights = (
        <SettingsGroup label="Terms and consumer rights" defaultOpen>
          <p>Stopping renewal, statutory withdrawal, refunds and deleting Cloud data are separate requests. Starting to use Cloud does not itself waive statutory withdrawal rights.</p>
          {([
            ["Cloud service terms", "Read terms", "https://usegyro.io/terms/"],
            ["Contract information", "Download copy", "https://usegyro.io/legal/2026-11-12-v4/cloud-contract.txt"],
            ["Statutory withdrawal", "Withdraw from contract", "https://usegyro.io/withdrawal/"],
            ["Privacy and deletion", "Read privacy notice", "https://usegyro.io/privacy/"],
            ["Product and billing support", "Contact support", "https://usegyro.io/contact/"],
          ] as const).map(([label, actionLabel, url]) => (
            <SettingsRow key={url} label={label}>
              <button type="button" className="gyro-secondary-button" onClick={() => void action(() => openExternal(url!))}>{actionLabel}</button>
            </SettingsRow>
          ))}
        </SettingsGroup>
  );
  if (!view)
    return (
      <SettingsSection
        icon={page === "account" ? UserRoundIcon : CloudIcon}
        title={page === "account" ? "Account" : "Gyro Cloud"}
      >
        <p role="status">{error || "Checking Cloud availability…"}</p>
        {page === "billing" && contractRights}
        {error && (
          <button
            className="gyro-secondary-button"
            onClick={() => void action(refresh)}
          >
            Try again
          </button>
        )}
      </SettingsSection>
    );
  if (!view.configured || !view.connected)
    return (
      <SettingsSection
        icon={page === "account" ? UserRoundIcon : CloudIcon}
        title={page === "account" ? "Account" : "Gyro Cloud"}
        description={
          page === "account"
            ? "Your identity and access to Gyro Cloud."
            : "Save only the projects and chats you choose."
        }
      >
        {previewLabel && <p className="gyro-cloud-sample">{previewLabel}</p>}
        {feedback}
        {!view.configured ? (
          <SettingsGroup label="Availability" defaultOpen>
            <SettingsRow
              label="Cloud is not enabled in this release"
              detail="Local work and your own providers remain available."
            />
          </SettingsGroup>
        ) : (
          <fieldset className="gyro-cloud-fieldset" disabled={busy}>
            <SettingsGroup label="Connect" defaultOpen>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    if (!codeRequested) {
                      await call({ operation: "begin", email, subscribe: false, remember });
                      setCodeRequested(true);
                      return;
                    }
                    try {
                      await call({ operation: "verify", code, remember });
                    } finally {
                      setCode("");
                    }
                    await refresh();
                  });
                }}
              >
                <label className="gyro-auth-field">
                  <span>Email</span>
                  <input
                    className="gyro-cloud-input"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label className="gyro-auth-field">
                  <span>Remember this Mac</span>
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                </label>
                {codeRequested ? (
                  <label className="gyro-auth-field">
                    <span>Email code</span>
                    <input
                      className="gyro-cloud-input"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                    />
                  </label>
                ) : null}
                <div className="gyro-cloud-actions">
                  {codeRequested ? (
                    <>
                      <button className="gyro-primary-button" type="submit">
                        Verify code
                      </button>
                      <button
                        className="gyro-secondary-button"
                        type="button"
                        onClick={() => {
                          setCode("");
                          setCodeRequested(false);
                          setError("");
                        }}
                      >
                        Start sign-in again
                      </button>
                    </>
                  ) : (
                    <>
                      {!cloudV3StagingBuild && (
                        <button
                          className="gyro-primary-button"
                          type="button"
                          onClick={() =>
                            void action(async () => {
                              await call({
                                operation: "begin",
                                email,
                                subscribe: true,
                                remember,
                              });
                              setCodeRequested(true);
                            })
                          }
                        >
                          Subscribe to Cloud
                        </button>
                      )}
                      <button
                        className={
                          cloudV3StagingBuild
                            ? "gyro-primary-button"
                            : "gyro-secondary-button"
                        }
                        type="button"
                        onClick={() =>
                          void action(async () => {
                            await call({
                              operation: "begin",
                              email,
                              subscribe: false,
                              remember,
                            });
                            setCodeRequested(true);
                          })
                        }
                      >
                        Sign in
                      </button>
                    </>
                  )}
                  <button
                    className="gyro-secondary-button"
                    type="button"
                    onClick={() =>
                      void action(async () => {
                        setNotice("Waiting for macOS Keychain. Approve any request directly on your Mac. Keychain access stops waiting after 30 seconds.");
                        try {
                          await call({ operation: "reconnect" });
                          await refresh();
                        } finally {
                          setNotice("");
                        }
                      })
                    }
                  >
                    Reconnect this Mac
                  </button>
                </div>
              </form>
            </SettingsGroup>
          </fieldset>
        )}
        {page === "billing" && contractRights}
      </SettingsSection>
    );
  if (page === "billing")
    return (
      <SettingsSection
        icon={CloudIcon}
        title="Plan & billing"
        description={
          cloudV3StagingBuild
            ? "Temporary test access. Purchases and billing changes are unavailable."
            : "Your verified Cloud subscription and billing controls."
        }
      >
        {previewLabel && <p className="gyro-cloud-sample">{previewLabel}</p>}
        {feedback}
        <fieldset className="gyro-cloud-fieldset" disabled={busy}>
          {workflows.billing()}
        </fieldset>
        {contractRights}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy}
          onClick={() => void action(refresh)}
        >
          Refresh status
        </button>
      </SettingsSection>
    );
  return (
    <>
      {page === "account" ? (
        <CloudAccountPage
          profile={profile}
          devices={devices}
          usage={usage}
          busy={busy}
          previewLabel={previewLabel}
          onPanel={openPanel}
          onEdit={async (displayName) => {
            const ok = await action(async () => {
              setProfile(
                await call({ operation: "update-profile", displayName }),
              );
              window.dispatchEvent(new Event("gyro-cloud-v3-account-changed"));
              setNotice("Profile updated.");
            });
            if (!ok) throw new Error("Profile update failed");
          }}
          onSignOut={() =>
            void action(async () => {
              await disconnect();
            })
          }
        >
          {feedback}
        </CloudAccountPage>
      ) : (
        <CloudOverview
          tab={tab}
          onTab={setTab}
          onRefresh={() => void action(refresh)}
          checkAllowed={Boolean(wallet?.checkAllowed)}
          mobileAllowed={capabilities.iosCompanion === true}
          usage={usage}
          wallet={wallet}
          versions={versions}
          devices={devices}
          profile={profile}
          busy={busy}
          stale={stale}
          hasMore={Boolean(versionCursor)}
          pendingCount={pending.filter((p) => !completedSave(p, transferOutcomes[p.requestId])).length}
          preparedCount={pending.length}
          previewLabel={previewLabel}
          onPanel={openPanel}
          onSave={() =>
            void action(async () => {
              const r = await call({ operation: "preview-project" });
              if (!r.cancelled) {
                setPreview(r);
                setReviewed(false);
                openPanel("projects");
              }
            })
          }
          onRestore={(v) =>
            void action(async () => {
              const result = await call({
                operation: "restore-project",
                revisionId: v.id,
              });
              if (!result?.cancelled) {
                setNotice("Project restored into a new local folder.");
                await refresh();
              }
            })
          }
        >
          {feedback}
        </CloudOverview>
      )}
      <dialog
        data-panel={panel}
        ref={dialog}
        className="gyro-cloud-dialog"
        aria-labelledby="gyro-cloud-panel-title"
        aria-describedby={
          panel === "transfers" ? "gyro-cloud-pending-description" : undefined
        }
        onCancel={() => setPanel(null)}
        onClose={() => setPanel(null)}
      >
        <header className="gyro-cloud-dialog-header">
          <h2 id="gyro-cloud-panel-title">
            {panel === "transfers" && (
              <CloudIcon size={24} aria-hidden="true" />
            )}
            {panel ? panelTitles[panel] : "Cloud"}
          </h2>
          <button
            type="button"
            className="gyro-cloud-icon-button"
            aria-label="Close panel"
            onClick={() => setPanel(null)}
          >
            <CloseIcon size={20} />
          </button>
        </header>
        {feedback}
        <fieldset className="gyro-cloud-fieldset gyro-settings-surface" disabled={busy}>
          {panel === "devices" && (
            <p>
              Revoking a device stops its Cloud access. Local files stay on that
              device. Confirm the device you want to revoke.
            </p>
          )}
          {panel &&
            (panel === "billing" && !usage ? (
              <p>
                Billing status is unavailable. Close this panel and refresh
                Cloud status.
              </p>
            ) : (
              workflows[panel]()
            ))}
        </fieldset>
        {readReport && (
          <div>
            <h3>Saved Check report · read-only</h3>
            <pre>{readReport.text}</pre>
            <p>
              This is a saved observation. Re-run checks for current evidence.
            </p>
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={() => setReadReport(null)}
            >
              Close report
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}
