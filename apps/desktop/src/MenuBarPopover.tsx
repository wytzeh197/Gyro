import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  SettingsIcon,
  SquareIcon,
  InlineMarkdown,
  ProviderLogo,
  RefreshIcon,
  isProviderId,
  gyroLogoMark,
  type MenuBarJob,
  type MenuBarOutcome,
  type MenuBarSnapshot,
} from "@gyro-dev/ui";
import { useEffect, useState } from "react";
import {
  approvalCanBeAnsweredInline,
  menuBarPresentation,
  menuBarStatus,
} from "./menu-bar-presentation";
import { menuBarModelProvider } from "./menu-bar-model-provider";

type ModelIdentity = Pick<
  MenuBarJob,
  "providerId" | "providerLabel" | "modelId" | "modelLabel"
>;

function modelLabel(identity: ModelIdentity) {
  return (
    identity.modelLabel ||
    identity.providerLabel ||
    identity.modelId ||
    identity.providerId
  );
}

function JobMark({
  job,
}: {
  job: ModelIdentity & { kind: MenuBarJob["kind"] };
}) {
  if (job.kind !== "chat")
    return (
      <span className="gyro-menu-bar-provider-mark" title="Automation">
        <RefreshIcon aria-hidden="true" />
      </span>
    );
  const inferred = menuBarModelProvider(job);
  // A legacy identity can still have a logo after leaving the selectable catalog.
  const providerId = isProviderId(job.providerId)
    ? job.providerId
    : inferred !== "unknown"
      ? inferred
      : "custom:unknown";
  return (
    <span
      className="gyro-menu-bar-provider-mark"
      title={modelLabel(job) || "Unknown provider"}
    >
      <ProviderLogo
        providerId={providerId}
        label={modelLabel(job) || "Unknown provider"}
      />
    </span>
  );
}

const EMPTY_SNAPSHOT: MenuBarSnapshot = {
  state: "idle",
  jobs: [],
  totalActive: 0,
  theme: "dark",
  reduceMotion: false,
  notifications: {
    enabled: true,
    approvals: true,
    finished: true,
    failed: true,
  },
};

function elapsedLabel(startedAt: string, now: number) {
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  if (!Number.isFinite(seconds)) return "Working";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function approvalPrompt(job: MenuBarJob) {
  const who = job.modelLabel ?? job.providerLabel ?? "The model";
  if (job.approval?.approvalType === "command") return `${who} wants to run`;
  if (job.approval?.approvalType === "file-change")
    return `${who} wants to change files`;
  return `${who} wants to use`;
}

type MenuBarPopoverViewProps = {
  snapshot: MenuBarSnapshot;
  now?: number;
  loading?: boolean;
  unavailable?: boolean;
  onOpen: (target: Pick<MenuBarJob, "kind" | "targetId">) => Promise<void>;
  onApprove: (job: MenuBarJob) => Promise<void>;
  onStop: (job: MenuBarJob) => Promise<void>;
  onOpenGyro: () => Promise<void>;
  onOpenSettings: () => Promise<void>;
};

/** The production view is also used by the interactive menu-bar fixture. */
export function MenuBarPopoverView({
  snapshot,
  now = Date.now(),
  loading = false,
  unavailable = false,
  onOpen,
  onApprove,
  onStop,
  onOpenGyro,
  onOpenSettings,
}: MenuBarPopoverViewProps) {
  const { visibleJobs, summary } = menuBarPresentation(snapshot);
  const status = unavailable
    ? { label: "Unavailable", tone: "danger" }
    : loading
      ? { label: "Loading…", tone: "neutral" }
      : menuBarStatus(snapshot);
  const [pending, setPending] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function act(id: string, action: () => Promise<void>) {
    if (pending.includes(id)) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    setPending((current) => [...current, id]);
    try {
      await action();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setPending((current) => current.filter((key) => key !== id));
    }
  }

  function outcomeRow(outcome: MenuBarOutcome) {
    return (
      <button
        className="gyro-menu-bar-outcome"
        aria-label={`Open ${outcome.title}${modelLabel(outcome) ? `, ${modelLabel(outcome)}` : ""}`}
        onClick={() => void act(outcome.id, () => onOpen(outcome))}
        type="button"
      >
        <JobMark job={outcome} />
        <span className="gyro-menu-bar-job-copy">
          <strong>{outcome.title}</strong>
          <small>
            {errors[outcome.id] ||
              [
                modelLabel(outcome),
                outcome.status === "failed" ? "Review issue" : "View result",
              ]
                .filter(Boolean)
                .join(" · ")}
          </small>
        </span>
        <ChevronRightIcon aria-hidden="true" />
      </button>
    );
  }

  return (
    <main
      className="gyro-menu-bar-shell"
      data-reduce-motion={snapshot.reduceMotion || undefined}
    >
      <section
        aria-label="Gyro background status"
        className="gyro-menu-bar-popover"
      >
        <header className="gyro-menu-bar-header">
          <img alt="" className="gyro-menu-bar-brand-mark" src={gyroLogoMark} />
          <strong>Gyro</strong>
          <span
            className="gyro-menu-bar-status"
            data-tone={status.tone}
            role="status"
            title={status.label}
          >
            {status.tone === "ok" ? (
              <CheckIcon aria-hidden="true" />
            ) : (
              <i aria-hidden="true" />
            )}
            <span>{status.label}</span>
          </span>
          <button
            aria-label="Settings"
            className="gyro-menu-bar-icon-button"
            onClick={() => void act("settings", onOpenSettings)}
            title="Settings"
            type="button"
          >
            <SettingsIcon aria-hidden="true" />
          </button>
        </header>

        <div className="gyro-menu-bar-content">
          {visibleJobs.map((job) => {
            const approvalKey = `approve:${job.id}:${job.approval?.id}`;
            const approving = pending.includes(approvalKey);
            const stopping = pending.includes(`stop:${job.id}`);
            const error =
              errors[approvalKey] || errors[`stop:${job.id}`] || errors[job.id];
            const identity = job.kind === "chat" ? modelLabel(job) : undefined;
            const activity =
              job.detail === `${job.providerLabel} is working` ||
              job.detail === "Gyro is working"
                ? "Working"
                : job.detail;
            const secondary = job.question
              ? `${job.modelLabel ?? job.providerLabel ?? "The model"} has a question`
              : job.approval
                ? approvalPrompt(job)
                : job.status === "finished"
                  ? "View result"
                  : job.status === "queued"
                    ? "Queued"
                    : job.status === "waiting"
                      ? "Waiting for your input"
                      : activity;
            const detail =
              job.approval || job.question
                ? secondary
                : [identity, secondary].filter(Boolean).join(" · ");
            return (
              <article className="gyro-menu-bar-job" key={job.id}>
                <div
                  className="gyro-menu-bar-job-row"
                  data-can-stop={job.canStop || undefined}
                >
                  <button
                    aria-label={`Open ${job.title}${identity ? `, ${identity}` : ""}`}
                    className="gyro-menu-bar-job-main"
                    onClick={() => void act(job.id, () => onOpen(job))}
                    title={job.detail}
                    type="button"
                  >
                    <JobMark job={job} />
                    <span className="gyro-menu-bar-job-copy">
                      <strong>{job.title}</strong>
                      <small
                        className={error ? "gyro-menu-bar-error" : undefined}
                        role={error ? "alert" : undefined}
                        title={error || detail}
                      >
                        {error || detail}
                      </small>
                    </span>
                    {job.status === "running" ? (
                      <span className="gyro-menu-bar-elapsed">
                        {elapsedLabel(job.startedAt, now)}
                      </span>
                    ) : job.status === "finished" ||
                      (!job.approval && !job.question) ? (
                      <ChevronRightIcon aria-hidden="true" />
                    ) : null}
                  </button>
                  {job.canStop ? (
                    <button
                      aria-label={`Stop ${job.title}`}
                      className="gyro-menu-bar-stop"
                      disabled={stopping}
                      onClick={() =>
                        void act(`stop:${job.id}`, () => onStop(job))
                      }
                      title="Stop chat"
                      type="button"
                    >
                      {stopping ? (
                        <span className="gyro-menu-bar-stop-progress">…</span>
                      ) : (
                        <SquareIcon aria-hidden="true" fill="currentColor" />
                      )}
                    </button>
                  ) : null}
                </div>
                {job.approval ? (
                  <div className="gyro-menu-bar-approval">
                    <code tabIndex={0}>{job.approval.summary}</code>
                    <div className="gyro-menu-bar-actions">
                      {approvalCanBeAnsweredInline(job) ? (
                        <button
                          className="is-primary"
                          disabled={approving}
                          onClick={() =>
                            void act(approvalKey, () => onApprove(job))
                          }
                          type="button"
                        >
                          {approving ? "Approving…" : "Approve"}
                        </button>
                      ) : null}
                      <button
                        className={
                          approvalCanBeAnsweredInline(job)
                            ? undefined
                            : "is-primary"
                        }
                        onClick={() => void act(job.id, () => onOpen(job))}
                        type="button"
                      >
                        {approvalCanBeAnsweredInline(job)
                          ? "Open chat"
                          : "Review changes"}
                      </button>
                    </div>
                  </div>
                ) : job.question ? (
                  <div className="gyro-menu-bar-question">
                    <p tabIndex={0}>
                      <InlineMarkdown text={job.question.summary} />
                    </p>
                    <div className="gyro-menu-bar-actions">
                      <button
                        className="is-primary"
                        onClick={() => void act(job.id, () => onOpen(job))}
                        type="button"
                      >
                        Reply in chat <ArrowRightIcon aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
          {summary ? (
            <button
              className="gyro-menu-bar-overflow"
              onClick={() => void act("open", onOpenGyro)}
              type="button"
            >
              {summary}
              <ChevronRightIcon aria-hidden="true" />
            </button>
          ) : null}
          {!visibleJobs.length && snapshot.recentOutcome
            ? outcomeRow(snapshot.recentOutcome)
            : null}
        </div>

        <footer className="gyro-menu-bar-footer">
          <button onClick={() => void act("open", onOpenGyro)} type="button">
            <span className="gyro-menu-bar-job-copy">
              Open Gyro
              {errors.open || errors.settings ? (
                <small
                  className="gyro-menu-bar-error"
                  role="alert"
                  title={errors.open || errors.settings}
                >
                  {errors.open || errors.settings}
                </small>
              ) : null}
            </span>
            <ChevronRightIcon aria-hidden="true" />
          </button>
        </footer>
      </section>
    </main>
  );
}

export function MenuBarPopover() {
  const [snapshot, setSnapshot] = useState<MenuBarSnapshot>();
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now());
  const hasRunningJobs =
    snapshot?.jobs.some((job) => job.status === "running") ?? false;

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const update = (next: MenuBarSnapshot) => {
      if (mounted) {
        setSnapshot(next);
        setUnavailable(false);
      }
    };
    void invoke<MenuBarSnapshot>("get_menu_bar_snapshot")
      .then(update)
      .catch(() => {
        if (mounted) setUnavailable(true);
      });
    void listen<MenuBarSnapshot>("gyro://menu-bar-status", (event) =>
      update(event.payload),
    )
      .then((dispose) => {
        if (mounted) unlisten = dispose;
        else dispose();
      })
      .catch(() => {
        if (mounted) setUnavailable(true);
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (snapshot) document.documentElement.dataset.theme = snapshot.theme;
  }, [snapshot?.theme]);
  useEffect(() => {
    if (!hasRunningJobs) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasRunningJobs]);
  useEffect(() => {
    const hide = () => {
      void invoke("hide_menu_bar_popover").catch(() => undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("blur", hide);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  return (
    <MenuBarPopoverView
      snapshot={snapshot ?? EMPTY_SNAPSHOT}
      now={now}
      loading={!snapshot && !unavailable}
      unavailable={unavailable}
      onOpen={(target) =>
        invoke("open_menu_bar_target", {
          target: { kind: target.kind, id: target.targetId },
        })
      }
      onOpenGyro={() => invoke("show_main_window")}
      onOpenSettings={() =>
        invoke("open_menu_bar_target", {
          target: { kind: "settings", id: "general" },
        })
      }
      onStop={(job) =>
        invoke("stop_provider_chat", { sessionId: job.targetId })
      }
      onApprove={(job) =>
        invoke("resolve_provider_approval", {
          request: { approvalId: job.approval!.id, decision: "approve" },
        }).then(() => undefined)
      }
    />
  );
}
