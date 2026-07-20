import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  gyroLogoMark,
  type MenuBarJob,
  type MenuBarOutcome,
  type MenuBarSnapshot,
} from "@gyro-dev/ui";
import { useEffect, useMemo, useState } from "react";
import { menuBarModelProvider } from "./menu-bar-model-provider";

const EMPTY_SNAPSHOT: MenuBarSnapshot = {
  state: "idle",
  jobs: [],
  totalActive: 0,
  theme: "dark",
  reduceMotion: false,
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

function headerCopy(snapshot: MenuBarSnapshot) {
  if (snapshot.state === "attention") {
    return {
      title: "Needs your attention",
      detail: snapshot.jobs.some((job) => job.status === "waiting")
        ? "A Gyro job is waiting for you."
        : "Recent Gyro work needs review.",
    };
  }
  if (snapshot.recentOutcome?.status === "failed") {
    return {
      title: "Recent issue",
      detail: "Open the job in Gyro to review what happened.",
    };
  }
  if (snapshot.totalActive > 0) {
    return {
      title: `Working on ${snapshot.totalActive} ${snapshot.totalActive === 1 ? "job" : "jobs"}`,
      detail: "Gyro will keep going in the background.",
    };
  }
  if (snapshot.state === "complete") {
    return {
      title: "Work complete",
      detail: "Gyro finished the latest job.",
    };
  }
  return { title: "Gyro is ready", detail: "No background work is active." };
}

function jobStatusLabel(job: MenuBarJob) {
  if (job.status === "finished") return "Finished";
  if (job.status === "waiting") return "Waiting";
  if (job.status === "queued") return "Queued";
  return "Working";
}

function GyroMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        compact
          ? "gyro-menu-bar-brand-mark is-compact"
          : "gyro-menu-bar-brand-mark"
      }
    >
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
          <defs>
            <linearGradient id="menu-gemini" x1="2" x2="22" y1="22" y2="2">
              <stop stopColor="#4e84ee" />
              <stop offset="1" stopColor="#a76edb" />
            </linearGradient>
          </defs>
          <path
            d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
            fill="url(#menu-gemini)"
          />
        </svg>
      ) : providerId === "anthropic" ? (
        <svg viewBox="0 0 24 24">
          <path d="m4.714 15.956 4.718-2.648.079-.23-.079-.128h-.23l-3.486-.122-4.602-.218-.571-.122-.534-.704.055-.352.479-.322.686.061 3.795.261 4.098.352h.389l.054-.158-.237-.194-4.805-3.255-2.058-1.463-.364-.461-.158-1.008.656-.722.88.06.225.061 4.396 3.309 1.34 1.033.146-.103.018-.073-3.443-6.088-.17-.619c-.061-.255-.103-.467-.103-.729L6.287.134 6.7 0l.996.134.419.364 2.196 4.642 1.554 3.03.698 1.729.091.255h.158v-.146l.364-3.801.31-3.455.376-.911.747-.492.583.28.48.686-.067.443-1.208 6.697h.213l.243-.243 3.363-4.133 1.396-1.336h1.032l.759 1.129-.34 1.166-4.778 6.063.073.109.188-.018 6.235-1.202.832.389.091.394-.328.808-7.71 1.76-.043.031.049.06 5.828.407.789.522.474.638-.079.486-1.214.619-6.776-1.627h-.182v.109l6.704 6.278.128.577-.322.455-.34-.049-6.29-4.773h-.127v.17l2.787 4.171.121 1.081-.17.352-.607.213-.668-.122-3.543-5.288-.14.079-.674 7.255-.315.371-.729.279-.607-.461-.322-.747 1.311-6.221-.012-.043-.14.018-5.337 7.758-.412.164-.717-.371.067-.661.401-.589 5.683-7.091-.006-.158h-.055l-6.338 4.117-1.13.145-.485-.455.06-.747.231-.243Z" />
        </svg>
      ) : providerId === "xai" ? (
        <svg viewBox="0 0 24 24">
          <circle cx="4.1" cy="4.1" r="1.45" />
          <path d="M2.5 19.8c4.2-6.4 9.7-10.2 19-12.7-5.6.4-10.6 2.1-14.7 5.1l8.6 7.7h4.2l-9.8-9-2.6 2 7.6 6.9Z" />
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
  const visibleJobs = snapshot.jobs.slice(0, 3);
  const overflow = Math.max(0, snapshot.jobs.length - visibleJobs.length);
  const header = useMemo(() => headerCopy(snapshot), [snapshot]);
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
    document.documentElement.dataset.theme = snapshot.theme;
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

  return (
    <main className="gyro-menu-bar-shell">
      <section
        aria-label="Gyro background status"
        className="gyro-menu-bar-popover"
      >
        <header className="gyro-menu-bar-header">
          <GyroMark />
          <div className="gyro-menu-bar-header-copy">
            <strong>{header.title}</strong>
            <span>{header.detail}</span>
          </div>
          <i aria-label={snapshot.state} data-state={snapshot.state} />
        </header>

        {visibleJobs.length > 0 ? (
          <div aria-label="Active Gyro jobs" className="gyro-menu-bar-jobs">
            {visibleJobs.map((job) => (
              <article className="gyro-menu-bar-job" key={job.id}>
                <button
                  aria-label={`Open ${job.title}`}
                  className="gyro-menu-bar-job-main"
                  onClick={() => openTarget(job)}
                  type="button"
                >
                  {job.kind === "chat" ? (
                    <ModelMark job={job} />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="gyro-menu-bar-job-icon is-automation"
                    >
                      <svg viewBox="0 0 24 24">
                        <path d="M20 11a8 8 0 1 0-2.34 5.66" />
                        <path d="M20 4v7h-7" />
                      </svg>
                    </span>
                  )}
                  <span className="gyro-menu-bar-job-copy">
                    <strong>{job.title}</strong>
                    <small title={job.detail}>{job.detail}</small>
                  </span>
                  <span className="gyro-menu-bar-job-meta">
                    <em data-status={job.status}>{jobStatusLabel(job)}</em>
                    <small>
                      {job.status === "finished"
                        ? "Done"
                        : elapsedLabel(job.startedAt, now)}
                    </small>
                  </span>
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
            type="button"
          >
            <span aria-hidden="true">
              {recentOutcome.status === "failed" ? "!" : "✓"}
            </span>
            <span>
              <strong>{recentOutcome.title}</strong>
              <small>{recentOutcome.detail}</small>
            </span>
          </button>
        ) : (
          <div className="gyro-menu-bar-idle">
            <span aria-hidden="true">✓</span>
            <p>
              <strong>All caught up</strong>
              <small>Start work in Gyro and its status will appear here.</small>
            </p>
          </div>
        )}

        <footer className="gyro-menu-bar-footer">
          <button onClick={() => void invoke("show_main_window")} type="button">
            Open Gyro
          </button>
          <button
            onClick={() =>
              void invoke("open_menu_bar_target", {
                target: { kind: "settings", id: "general" },
              })
            }
            type="button"
          >
            Settings
          </button>
        </footer>
      </section>
    </main>
  );
}
