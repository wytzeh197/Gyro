import {
  CalendarClock,
  FolderOpen,
  History,
  MessageSquare,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { WorkflowLibraryPanel } from "./library";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WorkflowEditor, emptyWorkflow } from "./editor";
import { WorkflowSetupPanel } from "./setup";
import { WorkflowExtractionPanel } from "./extraction";
import { WorkflowRuns } from "./runs";
import type {
  WorkflowDefinition,
  WorkflowDraft,
  WorkflowExtractionRequest,
  WorkflowJob,
  WorkflowLibrary,
  WorkflowListing,
  WorkflowProject,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowRuntime,
} from "./types";
import "./workflows.css";
type Editor = {
  definition: WorkflowDefinition;
  hash: string | null;
  existing: boolean;
  key: string;
};
export function WorkflowDestination({
  runtime,
  children,
  initialSessionId,
  onOpenSession,
  openSchedulesToken = 0,
  extractionRequest,
  onExtractionHandled,
}: {
  runtime?: WorkflowRuntime;
  children: ReactNode;
  initialSessionId?: string;
  onOpenSession?: (id: string) => void;
  openSchedulesToken?: number;
  extractionRequest?: WorkflowExtractionRequest;
  onExtractionHandled?: () => void;
}) {
  const [view, setView] = useState<"workflows" | "schedules" | "runs">(
    "workflows",
  );
  const [projects, setProjects] = useState<WorkflowProject[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(
    extractionRequest?.sessionId ?? initialSessionId,
  );
  const [library, setLibrary] = useState<WorkflowLibrary>();
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [drafts, setDrafts] = useState<WorkflowDraft[]>([]);
  const [editor, setEditor] = useState<Editor>();
  const [setup, setSetup] = useState<{
    listing: WorkflowListing;
    job?: WorkflowJob;
  }>();
  const [extraction, setExtraction] = useState<{
    turnId?: string;
    draft?: WorkflowDraft;
  }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const libraryGeneration = useRef(0);
  const project = projectId
    ? projects.find((project) => project.sessionId === projectId)
    : projects[0];
  const currentProject = useRef(project?.sessionId);
  currentProject.current = project?.sessionId;
  const refresh = useCallback(async () => {
    if (!runtime) return;
    const sequence = ++generation.current;
    try {
      const [projects, jobs, runs, drafts] = await Promise.all([
        runtime.run<WorkflowProject[]>("projects"),
        runtime.run<WorkflowJob[]>("jobs"),
        runtime.run<WorkflowRunSummary[]>("runs"),
        runtime.extraction<WorkflowDraft[]>("list"),
      ]);
      if (sequence !== generation.current) return;
      setProjects((current) => {
        const extra = current.filter(
          (project) =>
            !projects.some((next) => next.sessionId === project.sessionId),
        );
        return [...extra, ...projects];
      });
      setJobs(jobs);
      setRuns(runs);
      setDrafts(drafts);
    } catch (error) {
      if (sequence === generation.current) setError(String(error));
    }
  }, [runtime]);
  const refreshLibrary = useCallback(async () => {
    if (!runtime || !project) return;
    const sequence = ++libraryGeneration.current;
    try {
      const next = await runtime.definition<WorkflowLibrary>(
        "list",
        project.sessionId,
        project.rootId,
      );
      if (sequence === libraryGeneration.current) setLibrary(next);
    } catch (error) {
      if (sequence === libraryGeneration.current) setError(String(error));
    }
  }, [runtime, project?.sessionId, project?.rootId]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
      libraryGeneration.current++;
    };
  }, [refresh]);
  useEffect(() => {
    setLibrary(undefined);
    void refreshLibrary();
  }, [refreshLibrary]);
  useEffect(
    () =>
      runtime?.subscribe(() => {
        void refresh();
        void refreshLibrary();
      }),
    [runtime, refresh, refreshLibrary],
  );
  useEffect(() => {
    if (openSchedulesToken) setView("schedules");
  }, [openSchedulesToken]);
  useEffect(() => {
    if (!runtime || !projectId || project) return;
    let active = true;
    void runtime
      .run<WorkflowProject>("project", {}, projectId)
      .then((source) => {
        if (active)
          setProjects((current) =>
            current.some((item) => item.sessionId === source.sessionId)
              ? current
              : [source, ...current],
          );
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [runtime, projectId, project?.sessionId]);
  useEffect(() => {
    if (!runtime || !extractionRequest) return;
    const request = extractionRequest;
    setProjectId(request.sessionId);
    setView("workflows");
    setExtraction(undefined);
    let active = true;
    void runtime
      .run<WorkflowProject>("project", {}, request.sessionId)
      .then((project) => {
        if (!active) return;
        setProjects((current) =>
          current.some((item) => item.sessionId === project.sessionId)
            ? current
            : [project, ...current],
        );
        setExtraction({ turnId: request.turnId });
        onExtractionHandled?.();
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [runtime, extractionRequest?.token]);
  async function edit(listing: WorkflowListing) {
    if (!runtime || !project || !listing.definition) return;
    const sequence = libraryGeneration.current;
    setBusy(true);
    setError("");
    try {
      const source = await runtime.definition<{
        definition: WorkflowDefinition;
        expectedHash: string;
      }>("read", project.sessionId, project.rootId, { path: listing.path });
      if (sequence === libraryGeneration.current)
        setEditor({
          definition: source.definition,
          hash: source.expectedHash,
          existing: true,
          key: listing.path,
        });
    } catch (error) {
      if (sequence === libraryGeneration.current) setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function save(definition: WorkflowDefinition) {
    if (!runtime || !project || !editor) return;
    const identity = project.sessionId;
    setBusy(true);
    setError("");
    try {
      await runtime.definition("save", identity, project.rootId, {
        definition,
        expectedHash: editor.hash,
      });
      if (identity === currentProject.current) {
        setEditor(undefined);
        setNotice(
          "Workflow saved. Choose Run workflow when you’re ready to use it.",
        );
        void refreshLibrary();
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function openDraft(draft: WorkflowDraft) {
    if (!runtime) return;
    try {
      const source = await runtime.run<WorkflowProject>(
        "project",
        {},
        draft.sourceSessionId,
        draft.rootId,
      );
      setProjects((current) =>
        current.some((item) => item.sessionId === source.sessionId)
          ? current
          : [source, ...current],
      );
      setProjectId(source.sessionId);
      setExtraction({ draft });
      setView("workflows");
    } catch (error) {
      setError(String(error));
    }
  }
  async function updateJob(job: WorkflowJob) {
    if (!runtime) return;
    const source = job.execution.workflowBinding;
    try {
      const project = await runtime.run<WorkflowProject>(
        "project",
        {},
        source.sourceSessionId,
        source.rootId,
      );
      const current = await runtime.definition<WorkflowLibrary>(
        "list",
        project.sessionId,
        project.rootId,
      );
      const listing = current.definitions.find(
        (item) => item.definition?.id === source.definition.id,
      );
      if (!listing?.definition || !listing.hash)
        throw Error(
          "The workflow definition is unavailable or invalid. Open its project to repair it.",
        );
      setProjects((items) =>
        items.some((item) => item.sessionId === project.sessionId)
          ? items
          : [project, ...items],
      );
      setProjectId(project.sessionId);
      setSetup({ listing, job });
      setView("workflows");
    } catch (error) {
      setError(String(error));
    }
  }
  async function toggle(job: WorkflowJob) {
    if (!runtime) return;
    try {
      await runtime.run("toggle-job", {
        jobId: job.id,
        paused: job.status !== "paused",
      });
      void refresh();
    } catch (error) {
      setError(String(error));
    }
  }
  const scheduledJobs = jobs.filter((job) => job.schedule !== "manual");
  const showingLibrary = Boolean(
    runtime && project && !editor && !setup && !extraction,
  );
  function changeView(view: "workflows" | "schedules" | "runs") {
    if (editor) {
      setNotice("Save or discard your workflow edits before switching views.");
      return;
    }
    setView(view);
    setError("");
  }
  return (
    <div className="gyro-workflows-destination">
      <nav className="gyro-workflow-nav" aria-label="Workflow views">
        <div className="gyro-workflow-tabs">
          {(
            [
              ["workflows", Workflow],
              ["schedules", CalendarClock],
              ["runs", History],
            ] as const
          ).map(([tab, Icon]) => (
            <button
              key={tab}
              aria-pressed={view === tab}
              onClick={() => changeView(tab)}
            >
              <Icon size={14} aria-hidden="true" />
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </nav>
      {view === "schedules" ? (
        <div className="gyro-workflows-schedules">
          <header className="gyro-workflow-page-heading">
            <h1>Schedules</h1>
            <p>
              Run saved workflows and project automations on a regular rhythm.
            </p>
          </header>
          <section
            className="gyro-workflow-scheduled"
            aria-label="Workflow schedules"
          >
            <div className="gyro-workflow-section-head is-row">
              <h2>
                Workflow schedules
                {scheduledJobs.length ? (
                  <span className="gyro-workflow-count">
                    {scheduledJobs.length}
                  </span>
                ) : null}
              </h2>
              {scheduledJobs.length ? null : (
                <button onClick={() => changeView("workflows")}>
                  Browse workflows
                </button>
              )}
            </div>
            {scheduledJobs.length ? (
              <ul className="gyro-workflow-rows">
                {scheduledJobs.map((job) => (
                  <li key={job.id}>
                    <span className="gyro-workflow-icon-tile">
                      <CalendarClock size={16} aria-hidden="true" />
                    </span>
                    <div className="gyro-workflow-row-body">
                      <strong>
                        {job.title}
                        <em
                          className={`gyro-workflow-pill is-${job.status === "current" ? "success" : job.status === "paused" ? "warning" : "neutral"}`}
                        >
                          {job.status === "current"
                            ? "Active"
                            : job.status === "paused"
                              ? "Paused"
                              : "Completed"}
                        </em>
                      </strong>
                      <small>
                        {job.schedule} ·{" "}
                        {job.execution.calendar?.timezone ?? "local time"}
                        {job.execution.workspacePath
                          ? ` · ${job.execution.workspacePath}`
                          : ""}
                      </small>
                      <small>
                        Pinned version{" "}
                        <code>
                          {job.execution.workflowBinding.binding.definitionHash.slice(
                            0,
                            12,
                          )}
                        </code>
                      </small>
                      {job.lastResult ? <p>{job.lastResult}</p> : null}
                    </div>
                    <div className="gyro-workflow-row-actions">
                      <button onClick={() => void updateJob(job)}>
                        Review or update setup
                      </button>
                      <button
                        onClick={() => void toggle(job)}
                        title={
                          job.status === "paused"
                            ? undefined
                            : "Pausing also stops a run that is in progress."
                        }
                      >
                        {job.status === "paused"
                          ? "Resume schedule"
                          : "Pause schedule"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="gyro-workflow-schedule-empty">
                <span className="gyro-workflow-icon-tile">
                  <CalendarClock size={16} aria-hidden="true" />
                </span>
                <div>
                  <strong>No workflow schedules yet</strong>
                  <p>Choose a saved workflow, then set when it runs.</p>
                </div>
              </div>
            )}
          </section>
          <div className="gyro-workflow-legacy-schedules">{children}</div>
        </div>
      ) : (
        <div className="gyro-workflows-content">
          {!runtime ? (
            <p>Local workflow tools require the desktop app.</p>
          ) : view === "runs" ? (
            <WorkflowRuns
              runtime={runtime}
              runs={runs}
              jobs={jobs}
              onOpenSession={onOpenSession}
              onRefresh={() => void refresh()}
              onBrowseWorkflows={() => changeView("workflows")}
            />
          ) : (
            <>
              <header className="gyro-workflow-page-heading gyro-workflow-heading-actions">
                <div>
                  <h1>Workflows</h1>
                  <p>Save a task’s steps and use them again in this project.</p>
                </div>
                {showingLibrary ? (
                  <div className="gyro-workflow-header-actions">
                    <button disabled={busy} onClick={() => setExtraction({})}>
                      <MessageSquare size={14} aria-hidden="true" />
                      Create from a chat
                    </button>
                    <button
                      className="gyro-primary-button"
                      disabled={busy}
                      onClick={() =>
                        setEditor({
                          definition: emptyWorkflow(),
                          hash: null,
                          existing: false,
                          key: crypto.randomUUID(),
                        })
                      }
                    >
                      <Plus size={14} aria-hidden="true" /> New workflow
                    </button>
                  </div>
                ) : null}
              </header>
              <div className="gyro-workflow-context">
                <label className="gyro-workflow-project">
                  <FolderOpen size={14} aria-hidden="true" />
                  Project
                  <select
                    disabled={
                      Boolean(editor) ||
                      busy ||
                      Boolean(setup) ||
                      Boolean(extraction)
                    }
                    title={project?.path}
                    value={project?.sessionId ?? ""}
                    onChange={(event) => {
                      setProjectId(event.target.value);
                      setError("");
                      setNotice("");
                    }}
                  >
                    {projects.map((project) => (
                      <option key={project.sessionId} value={project.sessionId}>
                        {project.path.split(/[\\/]/).filter(Boolean).pop() ??
                          project.path}{" "}
                        · {project.title}
                      </option>
                    ))}
                  </select>
                </label>
                {showingLibrary ? (
                  <button
                    className="gyro-workflow-icon-button"
                    onClick={() => {
                      void refresh();
                      void refreshLibrary();
                    }}
                    aria-label="Refresh workflows"
                    title="Refresh workflows"
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {!project ? (
                <p>
                  No project session is available. Open a project chat first.
                </p>
              ) : editor ? (
                <WorkflowEditor
                  key={editor.key}
                  initial={editor.definition}
                  existing={editor.existing}
                  onSave={(definition) => void save(definition)}
                  onCancel={() => {
                    setEditor(undefined);
                    setError("");
                  }}
                  busy={busy}
                  error={error}
                />
              ) : setup?.listing.definition && setup.listing.hash ? (
                <WorkflowSetupPanel
                  key={`${project.sessionId}:${setup.listing.definition.id}:${setup.job?.id ?? "new"}`}
                  runtime={runtime}
                  project={project}
                  definition={setup.listing.definition}
                  hash={setup.listing.hash}
                  job={setup.job}
                  onClose={() => setSetup(undefined)}
                  onLaunched={(destination) => {
                    setSetup(undefined);
                    setView(destination === "schedule" ? "schedules" : "runs");
                    setNotice(
                      destination === "schedule"
                        ? "Workflow schedule saved."
                        : "Workflow request saved in the local queue.",
                    );
                    void refresh();
                  }}
                />
              ) : extraction ? (
                <WorkflowExtractionPanel
                  key={`${project.sessionId}:${extraction.draft?.id ?? extraction.turnId ?? "new"}`}
                  runtime={runtime}
                  project={project}
                  turnId={extraction.turnId}
                  draft={extraction.draft}
                  onClose={() => {
                    setExtraction(undefined);
                    void refresh();
                  }}
                  onEdit={(definition) => {
                    setExtraction(undefined);
                    setEditor({
                      definition,
                      hash: null,
                      existing: false,
                      key: crypto.randomUUID(),
                    });
                  }}
                />
              ) : (
                <WorkflowLibraryPanel
                  library={library}
                  drafts={drafts}
                  busy={busy}
                  onNew={(definition) =>
                    setEditor({
                      definition: definition ?? emptyWorkflow(),
                      hash: null,
                      existing: false,
                      key: crypto.randomUUID(),
                    })
                  }
                  onEdit={(item) => void edit(item)}
                  onSetup={(listing) => setSetup({ listing })}
                  onDraft={(draft) => void openDraft(draft)}
                />
              )}
            </>
          )}
        </div>
      )}
      {notice || (error && !editor) ? (
        <div className="gyro-workflow-feedback">
          {notice ? <p role="status">{notice}</p> : null}
          {error && !editor ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
