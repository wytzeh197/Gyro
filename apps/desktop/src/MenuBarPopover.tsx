import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  applyAppearancePreferences,
  gyroLogoMark,
  type MenuBarJob,
  type MenuBarOutcome,
  type MenuBarSnapshot,
  type WorkbenchPreferences,
} from "@gyro-dev/ui";
import { useEffect, useMemo, useState } from "react";
import { menuBarModelProvider } from "./menu-bar-model-provider";

const MAX_VISIBLE_JOBS = 4;

type StoredAppearance = Pick<
  WorkbenchPreferences,
  "interfaceSize" | "motionSpeed" | "mainColor" | "secondaryColor"
>;

function storedAppearancePreferences(): StoredAppearance | null {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem("gyro.workbench-state") ?? "null",
    ) as { preferences?: Partial<StoredAppearance> } | null;
    const preferences = stored?.preferences;
    if (!preferences?.mainColor || !preferences.secondaryColor) return null;
    return {
      interfaceSize: preferences.interfaceSize ?? "default",
      motionSpeed: preferences.motionSpeed ?? "default",
      mainColor: preferences.mainColor,
      secondaryColor: preferences.secondaryColor,
    };
  } catch {
    return null;
  }
}

const EMPTY_SNAPSHOT: MenuBarSnapshot = {
  state: "idle",
  jobs: [],
  totalActive: 0,
  theme: "dark",
  reduceMotion: false,
  notifications: { enabled: true, approvals: true, finished: true, failed: true },
};

function elapsedLabel(startedAt: string, now: number) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes < 60)
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

type HeaderPill = { label: string; tone: "warn" | "danger" | "accent" | "ok" };

function headerSummary(snapshot: MenuBarSnapshot): {
  title: string;
  pill?: HeaderPill;
} {
  const waiting = snapshot.jobs.filter((job) => job.status === "waiting").length;
  const running = snapshot.totalActive - waiting;
  if (snapshot.totalActive > 0) {
    const parts = [
      running > 0 ? `${running} running` : "",
      waiting > 0 ? `${waiting} waiting` : "",
    ].filter(Boolean);
    return {
      title: parts.join(" · "),
      pill:
        waiting > 0
          ? { label: "Needs you", tone: "warn" }
          : { label: "Working", tone: "accent" },
    };
  }
  if (snapshot.recentOutcome?.status === "failed") {
    return { title: "Recent issue", pill: { label: "Review", tone: "danger" } };
  }
  if (snapshot.state === "complete") {
    return { title: "Work complete", pill: { label: "Done", tone: "ok" } };
  }
  return { title: "Gyro is ready" };
}

function jobMeta(job: MenuBarJob, now: number) {
  if (job.status === "finished") return "Done";
  if (job.status === "queued") return "Queued";
  if (job.status === "waiting" && !job.approval) return "Waiting";
  return elapsedLabel(job.startedAt, now);
}

/** File changes need their diff read, so those only offer to open the chat. */
function approvalCanBeAnsweredInline(job: MenuBarJob) {
  return Boolean(job.approval && job.approval.approvalType !== "file-change");
}

function approvalPrompt(job: MenuBarJob) {
  const who = job.modelLabel ?? job.providerLabel ?? "The model";
  if (job.approval?.approvalType === "command") return `${who} wants to run`;
  if (job.approval?.approvalType === "file-change") {
    return `${who} wants to change files`;
  }
  return `${who} wants to use`;
}

function GyroMark() {
  return (
    <span aria-hidden="true" className="gyro-menu-bar-brand-mark">
      <img alt="" src={gyroLogoMark} />
    </span>
  );
}

function ModelMark({ job }: { job: MenuBarJob }) {
  const providerId = menuBarModelProvider(job);
  const label = job.modelLabel ?? job.providerLabel ?? "Model";
  const fallback = (job.providerLabel ?? job.modelLabel ?? "M")
    .trim()
    .slice(0, 1)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`gyro-menu-bar-model-mark is-${providerId}`}
      title={label}
    >
      {providerId === "openai" ? (
        <svg viewBox="0 0 24 24">
          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .511 4.91 6.051 6.051 0 0 0 6.515 2.9A5.984 5.984 0 0 0 13.26 24a6.055 6.055 0 0 0 5.772-4.206 5.989 5.989 0 0 0 3.998-2.9 6.055 6.055 0 0 0-.748-7.073Zm-9.022 12.608a4.475 4.475 0 0 1-2.876-1.04l.142-.081 4.778-2.758a.795.795 0 0 0 .393-.682v-6.736l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494ZM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.758a.771.771 0 0 0 .781 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062l-4.84 2.791a4.499 4.499 0 0 1-6.14-1.646ZM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.814 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872Zm16.597 3.856-5.833-3.388 2.015-1.164a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.677a.79.79 0 0 0-.407-.666Zm2.01-3.024-.142-.085-4.773-2.782a.776.776 0 0 0-.786 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.499 4.499 0 0 1 6.68 4.66ZM8.306 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074a4.499 4.499 0 0 1 7.376-3.454l-.142.08-4.778 2.759a.795.795 0 0 0-.393.681Zm1.098-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
        </svg>
      ) : providerId === "gemini" ? (
        <svg viewBox="0 0 24 24">
          <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
        </svg>
      ) : providerId === "anthropic" ? (
        <svg viewBox="0 0 24 24">
          <path d="m4.714 15.956 4.718-2.648.079-.23-.079-.128h-.23l-3.486-.122-4.602-.218-.571-.122-.534-.704.055-.352.479-.322.686.061 3.795.261 4.098.352h.389l.054-.158-.237-.194-4.805-3.255-2.058-1.463-.364-.461-.158-1.008.656-.722.88.06.225.061 4.396 3.309 1.34 1.033.146-.103.018-.073-3.443-6.088-.17-.619c-.061-.255-.103-.467-.103-.729L6.287.134 6.7 0l.996.134.419.364 2.196 4.642 1.554 3.03.698 1.729.091.255h.158v-.146l.364-3.801.31-3.455.376-.911.747-.492.583.28.48.686-.067.443-1.208 6.697h.213l.243-.243 3.363-4.133 1.396-1.336h1.032l.759 1.129-.34 1.166-4.778 6.063.073.109.188-.018 6.235-1.202.832.389.091.394-.328.808-7.71 1.76-.043.031.049.06 5.828.407.789.522.474.638-.079.486-1.214.619-6.776-1.627h-.182v.109l6.704 6.278.128.577-.322.455-.34-.049-6.29-4.773h-.127v.17l2.787 4.171.121 1.081-.17.352-.607.213-.668-.122-3.543-5.288-.14.079-.674 7.255-.315.371-.729.279-.607-.461-.322-.747 1.311-6.221-.012-.043-.14.018-5.337 7.758-.412.164-.717-.371.067-.661.401-.589 5.683-7.091-.006-.158h-.055l-6.338 4.117-1.13.145-.485-.455.06-.747.231-.243Z" />
        </svg>
      ) : providerId === "xai" ? (
        <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
          <path d="M9.27 15.29 17.248 9.393c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 0 0-1.829-1A8.975 8.975 0 0 0 5.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
        </svg>
      ) : providerId === "kimi" ? (
        <svg viewBox="0 0 24 24">
          <path d="M5 4h4v6.1L14.9 4H20l-7 7.2 7.4 8.8h-5.2L10 13.8l-1 1V20H5Z" />
          <circle className="kimi-dot" cx="20.3" cy="4.2" r="1.7" />
        </svg>
      ) : (
        <strong>{fallback}</strong>
      )}
    </span>
  );
}

export function MenuBarPopover() {
  const [snapshot, setSnapshot] = useState<MenuBarSnapshot>(EMPTY_SNAPSHOT);
  const [now, setNow] = useState(Date.now());
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const [approvingIds, setApprovingIds] = useState<string[]>([]);
  // Kept in step with MENU_BAR_MAX_VISIBLE_JOBS in menu_bar.rs, which sizes the
  // popover window; anything past the cap is summarised by the "+N more" row.
  const visibleJobs = snapshot.jobs.slice(0, MAX_VISIBLE_JOBS);
  const overflow = Math.max(0, snapshot.jobs.length - visibleJobs.length);
  const header = useMemo(() => headerSummary(snapshot), [snapshot]);
  const recentOutcome = snapshot.recentOutcome;

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void invoke<MenuBarSnapshot>("get_menu_bar_snapshot")
      .then((next) => {
        if (mounted) setSnapshot(next);
      })
      .catch(() => undefined);
    void listen<MenuBarSnapshot>("gyro://menu-bar-status", (event) => {
      if (mounted) setSnapshot(event.payload);
    }).then((dispose) => {
      if (mounted) unlisten = dispose;
      else dispose();
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = snapshot.theme;
    // Same origin as the main window, so the saved appearance is readable
    // here; applying it lets the shared tokens carry the user's accent and
    // interface size into the menu bar.
    const apply = () => {
      const preferences = storedAppearancePreferences();
      if (!preferences) return;
      applyAppearancePreferences(root, preferences, snapshot.theme);
      root.style.setProperty("--gyro-user-main", preferences.mainColor);
      root.style.setProperty("--gyro-user-secondary", preferences.secondaryColor);
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, [snapshot.theme]);

  useEffect(() => {
    if (snapshot.jobs.length === 0) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [snapshot.jobs.length]);

  useEffect(() => {
    const hideOnBlur = () => void invoke("hide_menu_bar_popover");
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideOnBlur();
    };
    window.addEventListener("blur", hideOnBlur);
    window.addEventListener("keydown", hideOnEscape);
    return () => {
      window.removeEventListener("blur", hideOnBlur);
      window.removeEventListener("keydown", hideOnEscape);
    };
  }, []);

  const openTarget = (job: MenuBarJob) => {
    void invoke("open_menu_bar_target", {
      target: { kind: job.kind, id: job.targetId },
    });
  };

  const openOutcome = (outcome: MenuBarOutcome) => {
    void invoke("open_menu_bar_target", {
      target: { kind: outcome.kind, id: outcome.targetId },
    });
  };

  const stopJob = (job: MenuBarJob) => {
    if (!job.canStop || stoppingIds.includes(job.id)) return;
    setStoppingIds((current) => [...current, job.id]);
    void invoke("stop_provider_chat", { sessionId: job.targetId }).catch(() =>
      setStoppingIds((current) => current.filter((id) => id !== job.id)),
    );
  };

  // The resolved approval reaches the main window as a provider-approval
  // event, and its next snapshot drops the approval from this row.
  const approveJob = (job: MenuBarJob) => {
    const approval = job.approval;
    if (!approval || approvingIds.includes(approval.id)) return;
    setApprovingIds((current) => [...current, approval.id]);
    void invoke("resolve_provider_approval", {
      request: { approvalId: approval.id, decision: "approve" },
    }).catch(() =>
      setApprovingIds((current) => current.filter((id) => id !== approval.id)),
    );
  };

  return (
    <main className="gyro-menu-bar-shell">
      <section
        aria-label="Gyro background status"
        className="gyro-menu-bar-popover"
      >
        <header className="gyro-menu-bar-header">
          <GyroMark />
          <strong>{header.title}</strong>
          {header.pill ? (
            <em className="gyro-menu-bar-pill" data-tone={header.pill.tone}>
              {header.pill.label}
            </em>
          ) : null}
        </header>

        {visibleJobs.length > 0 ? (
          <div aria-label="Active Gyro jobs" className="gyro-menu-bar-jobs">
            {visibleJobs.map((job) => (
              <article
                className="gyro-menu-bar-job"
                data-has-approval={job.approval ? "true" : undefined}
                key={job.id}
              >
                <div className="gyro-menu-bar-job-row">
                  <button
                    aria-label={`Open ${job.title}`}
                    className="gyro-menu-bar-job-main"
                    onClick={() => openTarget(job)}
                    title={job.detail}
                    type="button"
                  >
                    <i aria-hidden="true" data-status={job.status} />
                    <strong>{job.title}</strong>
                    {job.kind === "chat" ? (
                      <ModelMark job={job} />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="gyro-menu-bar-job-icon"
                      >
                        <svg viewBox="0 0 24 24">
                          <path d="M20 11a8 8 0 1 0-2.34 5.66" />
                          <path d="M20 4v7h-7" />
                        </svg>
                      </span>
                    )}
                    <small data-status={job.status}>{jobMeta(job, now)}</small>
                  </button>
                  {job.canStop ? (
                    <button
                      aria-label={`Stop ${job.title}`}
                      className="gyro-menu-bar-stop"
                      disabled={stoppingIds.includes(job.id)}
                      onClick={() => stopJob(job)}
                      title="Stop chat"
                      type="button"
                    >
                      {stoppingIds.includes(job.id) ? (
                        <span className="gyro-menu-bar-stop-progress">•••</span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="gyro-menu-bar-stop-icon"
                        />
                      )}
                    </button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </div>
                {job.approval ? (
                  <div className="gyro-menu-bar-approval">
                    <p>
                      <span>{approvalPrompt(job)}</span>
                      <code title={job.approval.summary}>
                        {job.approval.summary}
                      </code>
                    </p>
                    <div>
                      {approvalCanBeAnsweredInline(job) ? (
                        <button
                          className="is-primary"
                          disabled={approvingIds.includes(job.approval.id)}
                          onClick={() => approveJob(job)}
                          type="button"
                        >
                          {approvingIds.includes(job.approval.id)
                            ? "Approving…"
                            : "Approve"}
                        </button>
                      ) : null}
                      <button onClick={() => openTarget(job)} type="button">
                        {approvalCanBeAnsweredInline(job) ? "Open" : "Review"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
            {overflow > 0 ? (
              <button
                className="gyro-menu-bar-overflow"
                onClick={() => void invoke("show_main_window")}
                type="button"
              >
                +{overflow} more
              </button>
            ) : null}
          </div>
        ) : recentOutcome ? (
          <button
            className="gyro-menu-bar-outcome"
            data-status={recentOutcome.status}
            onClick={() => openOutcome(recentOutcome)}
            title={recentOutcome.detail}
            type="button"
          >
            <i aria-hidden="true" data-status={recentOutcome.status} />
            <strong>{recentOutcome.title}</strong>
            <small>
              {recentOutcome.status === "failed" ? "Failed" : "Done"}
            </small>
          </button>
        ) : null}

        <footer className="gyro-menu-bar-footer">
          <button onClick={() => void invoke("show_main_window")} type="button">
            Open Gyro
          </button>
          <button
            aria-label="Settings"
            className="gyro-menu-bar-icon-button"
            onClick={() =>
              void invoke("open_menu_bar_target", {
                target: { kind: "settings", id: "general" },
              })
            }
            title="Settings"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
        </footer>
      </section>
    </main>
  );
}
