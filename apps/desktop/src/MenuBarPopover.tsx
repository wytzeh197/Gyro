import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  gyroLogoMark,
  type MenuBarJob,
  type MenuBarOutcome,
  type MenuBarSnapshot,
} from "@gyro-dev/ui";
import { useEffect, useMemo, useState } from "react";

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

export function MenuBarPopover() {
  const [snapshot, setSnapshot] = useState<MenuBarSnapshot>(EMPTY_SNAPSHOT);
  const [now, setNow] = useState(Date.now());
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const visibleJobs = snapshot.jobs.slice(0, 3);
  const overflow = Math.max(0, snapshot.totalActive - visibleJobs.length);
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
                    <GyroMark compact />
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
                    <small>{elapsedLabel(job.startedAt, now)}</small>
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
