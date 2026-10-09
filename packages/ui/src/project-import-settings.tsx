import { Folder, FolderOpen } from "./workspace-folder-icons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { SettingsGroup, SettingsSwitch } from "./settings-controls";
import gyroLogoLight from "./assets/gyro-logo-transparent-dark.png";
import gyroLogoDark from "./assets/gyro-logo-transparent.png";
import type {
  ProjectImportCandidate,
  ProjectImportJob,
  ProjectImportResult,
  ProjectImportScan,
  ProjectImportSource,
  ProjectImportSourceKind,
} from "./project-import-types";
import "./project-import-settings.css";

export interface ProjectImportSettingsProps {
  sources: ProjectImportSource[];
  scan?: ProjectImportScan;
  job?: ProjectImportJob;
  scanning: boolean;
  loadingSources?: boolean;
  error?: string;
  includeArchived: boolean;
  onIncludeArchivedChange: (value: boolean) => void;
  onChooseDataFolder: (kind: ProjectImportSourceKind) => void;
  onScan: () => void;
  onImport: (candidateIds: string[]) => void;
  onCancel: () => void;
  onOpenSession: (sessionId: string, workspacePath: string) => void;
  onLocateFolder: (sessionId: string) => void;
  onRetry?: () => void;
}

const sourceLabels: Record<ProjectImportSourceKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function ProviderMark({ kind }: { kind: ProjectImportSourceKind }) {
  return (
    <span aria-hidden="true" className={`gyro-import-provider-mark is-${kind}`}>
      <svg viewBox="0 0 24 24">
        <path
          d={kind === "claude-code" ? CLAUDE_MARK : OPENAI_MARK}
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

export function ProjectImportCallout({
  onOpen,
  onDismiss,
}: {
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="gyro-project-import-callout">
      <button
        aria-label="Import projects"
        className="gyro-import-callout-open"
        onClick={onOpen}
        type="button"
      >
        <span aria-hidden="true" className="gyro-import-callout-marks">
          <span className="gyro-import-callout-providers">
            <ProviderMark kind="claude-code" />
            <ProviderMark kind="codex" />
          </span>
          <ArrowRight className="gyro-import-callout-arrow" size={15} />
          <span className="gyro-import-callout-gyro">
            <img className="is-light" alt="" src={gyroLogoLight} />
            <img className="is-dark" alt="" src={gyroLogoDark} />
          </span>
        </span>
        <span className="gyro-import-callout-copy">
          <strong>Import projects</strong>
          <span>Bring your Claude Code and Codex chats into Gyro.</span>
        </span>
        <ChevronRight
          className="gyro-import-callout-chevron"
          aria-hidden="true"
          size={15}
        />
      </button>
      <button
        aria-label="Dismiss project import suggestion"
        className="gyro-import-callout-dismiss"
        onClick={onDismiss}
        type="button"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ImportCheckbox({
  label,
  checked,
  mixed = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      aria-label={label}
      aria-checked={mixed ? "mixed" : checked}
      checked={checked}
      className="gyro-import-checkbox"
      disabled={disabled}
      onChange={onChange}
      type="checkbox"
    />
  );
}

function projectName(path: string) {
  return (
    path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ||
    path ||
    "Unknown project"
  );
}
function latestLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function Diagnostics({
  messages,
  label = "Import details",
}: {
  messages: string[];
  label?: string;
}) {
  if (!messages.length) return null;
  return (
    <details className="gyro-import-diagnostics">
      <summary>
        {label} ({messages.length})
      </summary>
      <ul>
        {messages.map((message, index) => (
          <li key={`${index}-${message}`}>{message}</li>
        ))}
      </ul>
    </details>
  );
}

function ResultRow({
  result,
  onOpenSession,
  onLocateFolder,
  workspaceAvailable,
}: {
  result: ProjectImportResult;
  onOpenSession: ProjectImportSettingsProps["onOpenSession"];
  onLocateFolder: ProjectImportSettingsProps["onLocateFolder"];
  workspaceAvailable: boolean;
}) {
  return (
    <div className="gyro-import-result">
      <span className="gyro-import-result-status">
        {result.status === "failed" ? (
          "Failed"
        ) : result.status === "existing" ? (
          "Already in Gyro"
        ) : (
          <>
            <Check aria-hidden="true" size={13} />
            Imported
          </>
        )}
      </span>
      <div className="gyro-import-result-copy">
        <strong>{result.title}</strong>
        {result.detail && <span>{result.detail}</span>}
        <Diagnostics messages={result.diagnostics} />
      </div>
      {result.sessionId && (
        <div className="gyro-import-row-actions">
          <button
            className="gyro-import-button is-quiet"
            type="button"
            onClick={() =>
              onOpenSession(result.sessionId!, result.workspacePath)
            }
          >
            Open chat
          </button>
          {!workspaceAvailable && (
            <button
              className="gyro-import-button is-quiet"
              type="button"
              onClick={() => onLocateFolder(result.sessionId!)}
            >
              Locate folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectImportSettings({
  sources,
  scan,
  job,
  scanning,
  loadingSources = false,
  error,
  includeArchived,
  onIncludeArchivedChange,
  onChooseDataFolder,
  onScan,
  onImport,
  onCancel,
  onOpenSession,
  onLocateFolder,
  onRetry,
}: ProjectImportSettingsProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [importedSessions, setImportedSessions] = useState<Map<string, string>>(
    () => new Map(),
  );
  const id = useId();
  const running = job?.status === "running";
  const busy = scanning || running;
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
    setImportedSessions(new Map());
  }, [scan?.scanId]);
  useEffect(() => {
    const results =
      job?.results.filter(
        (result) => result.status !== "failed" && result.sessionId,
      ) ?? [];
    if (!results.length) return;
    setImportedSessions((previous) => {
      const changed = results.some(
        (result) => previous.get(result.candidateId) !== result.sessionId,
      );
      if (!changed) return previous;
      const next = new Map(previous);
      for (const result of results)
        next.set(result.candidateId, result.sessionId!);
      return next;
    });
    setSelected((previous) => {
      if (!results.some((result) => previous.has(result.candidateId)))
        return previous;
      const next = new Set(previous);
      for (const result of results) next.delete(result.candidateId);
      return next;
    });
  }, [job?.results]);
  const completedSessions = useMemo(
    () =>
      new Map([
        ...importedSessions,
        ...(job?.results
          .filter((result) => result.status !== "failed" && result.sessionId)
          .map((result) => [result.candidateId, result.sessionId!] as const) ??
          []),
      ]),
    [importedSessions, job?.results],
  );
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const projects = new Map<string, ProjectImportCandidate[]>();
    for (const candidate of scan?.candidates ?? []) {
      if (!includeArchived && candidate.archived) continue;
      if (
        needle &&
        ![
          candidate.title,
          candidate.workspacePath,
          sourceLabels[candidate.sourceKind],
        ].some((value) => value.toLocaleLowerCase().includes(needle))
      )
        continue;
      const group = projects.get(candidate.workspacePath) ?? [];
      group.push(candidate);
      projects.set(candidate.workspacePath, group);
    }
    return [...projects]
      .map(([path, chats]) => ({
        path,
        chats: chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        latest: chats.reduce(
          (latest, chat) => (chat.updatedAt > latest ? chat.updatedAt : latest),
          "",
        ),
      }))
      .sort(
        (a, b) =>
          b.latest.localeCompare(a.latest) || a.path.localeCompare(b.path),
      );
  }, [scan?.candidates, query, includeArchived]);
  const eligible = (candidate: ProjectImportCandidate) =>
    !candidate.existingSessionId && !completedSessions.has(candidate.id);
  const selectedIds = (scan?.candidates ?? [])
    .filter(
      (candidate) =>
        selected.has(candidate.id) &&
        eligible(candidate) &&
        (includeArchived || !candidate.archived),
    )
    .map((candidate) => candidate.id);
  const toggle = (ids: string[]) =>
    setSelected((previous) => {
      const next = new Set(previous);
      const remove = ids.every((value) => next.has(value));
      for (const value of ids) {
        if (remove) next.delete(value);
        else next.add(value);
      }
      return next;
    });
  const imported =
    job?.results.filter((result) => result.status === "imported").length ?? 0;
  const failures =
    job?.results.filter((result) => result.status === "failed").length ?? 0;
  const existing =
    job?.results.filter((result) => result.status === "existing").length ?? 0;
  const jobStatus = running
    ? `Importing ${job!.completed} of ${job!.total} chats`
    : job?.status === "cancelled"
      ? "Import cancelled"
      : job?.status === "interrupted"
        ? "Import interrupted"
        : job?.status === "failed"
          ? "Import could not finish"
          : "Import complete";

  return (
    <div className="gyro-project-import-settings">
      <SettingsGroup label="Import from">
        {loadingSources && (
          <div className="gyro-import-loading" role="status">
            <LoaderCircle aria-hidden="true" size={15} />
            Finding local data folders…
          </div>
        )}
        {sources.map((source) => (
          <div
            key={source.kind}
            className="gyro-import-source"
            data-setting-key={`import-${source.kind}`}
          >
            <ProviderMark kind={source.kind} />
            <div className="gyro-import-source-copy">
              <strong>{source.label}</strong>
              <span className="gyro-import-path" title={source.dataHome}>
                {source.dataHome}
              </span>
              {source.detail && <span>{source.detail}</span>}
            </div>
            <span
              className={`gyro-import-source-status${source.available ? " is-available" : ""}`}
            >
              {source.available ? "Available" : "Not found"}
            </span>
            <button
              className="gyro-import-button"
              disabled={busy || loadingSources}
              onClick={() => onChooseDataFolder(source.kind)}
              type="button"
            >
              Choose data folder
            </button>
          </div>
        ))}
      </SettingsGroup>
      <div className="gyro-import-scan-controls">
        <div className="gyro-import-archived">
          <div>
            <strong>Include archived chats</strong>
            <span>Include archived Codex chats when you scan.</span>
          </div>
          <SettingsSwitch
            checked={includeArchived}
            disabled={busy}
            label="Include archived chats"
            onChange={onIncludeArchivedChange}
          />
        </div>
        <button
          className="gyro-import-button"
          disabled={
            busy ||
            loadingSources ||
            !sources.some((source) => source.available)
          }
          onClick={onScan}
          type="button"
        >
          {scanning ? (
            <>
              <LoaderCircle
                aria-hidden="true"
                className="gyro-import-spinner"
                size={14}
              />
              Scanning…
            </>
          ) : scan ? (
            "Rescan projects"
          ) : (
            "Scan projects"
          )}
        </button>
      </div>
      <p className="gyro-import-helper">
        Your projects stay in their current folders. Choose the chats you want
        to bring into Gyro.
      </p>
      {error && (
        <div className="gyro-import-error" role="alert">
          <span>{error}</span>
          {onRetry && (
            <button
              className="gyro-import-button"
              disabled={busy || loadingSources}
              onClick={onRetry}
              type="button"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {scan && <Diagnostics messages={scan.diagnostics} label="Scan details" />}
      {job && (
        <section className="gyro-import-job" aria-label="Import progress">
          <div className="gyro-import-job-header">
            <div>
              <strong role="status" aria-live="polite">
                {jobStatus}
              </strong>
              <span>
                {running
                  ? "You can leave this page while your chats import."
                  : `${imported} imported${existing ? ` · ${existing} already in Gyro` : ""}${failures ? ` · ${failures} failed` : ""}${job.status === "cancelled" || job.status === "interrupted" ? ". Completed chats are saved; select the remaining chats to retry." : ""}`}
              </span>
            </div>
            {running && (
              <button
                className="gyro-import-button"
                onClick={onCancel}
                type="button"
              >
                Cancel import
              </button>
            )}
          </div>
          <progress
            aria-label="Chats processed"
            max={Math.max(job.total, 1)}
            value={job.completed}
          />
          {job.error && (
            <p className="gyro-import-error" role="alert">
              {job.error}
            </p>
          )}
          {job.results.length > 0 && (
            <details className="gyro-import-job-results" open={!running}>
              <summary>
                {running
                  ? "Completed chats"
                  : "View imported chats and details"}{" "}
                ({job.results.length})
              </summary>
              {job.results.map((result) => (
                <ResultRow
                  key={result.candidateId}
                  result={result}
                  workspaceAvailable={
                    scan?.candidates.find(
                      (candidate) => candidate.id === result.candidateId,
                    )?.workspaceAvailable ?? true
                  }
                  onOpenSession={onOpenSession}
                  onLocateFolder={onLocateFolder}
                />
              ))}
            </details>
          )}
        </section>
      )}
      {scan && (
        <SettingsGroup label="Projects">
          <div className="gyro-import-projects-toolbar">
            <label className="gyro-import-search">
              <Search aria-hidden="true" size={15} />
              <input
                aria-label="Search projects and chats"
                disabled={scanning}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects and chats"
                type="search"
                value={query}
              />
            </label>
            <span>
              {groups.length} {groups.length === 1 ? "project" : "projects"}
            </span>
          </div>
          {groups.length === 0 && (
            <div className="gyro-import-empty">
              <FolderOpen aria-hidden="true" size={22} />
              <strong>
                {query ? "No matching projects" : "No chats found"}
              </strong>
              <span>
                {query
                  ? "Try another project name, path, or chat title."
                  : "Choose a different data folder or include archived chats, then scan again."}
              </span>
            </div>
          )}
          {groups.map((group, groupIndex) => {
            const availableIds = group.chats
              .filter(eligible)
              .map((candidate) => candidate.id);
            const selectedCount = availableIds.filter((candidateId) =>
              selected.has(candidateId),
            ).length;
            const isExpanded = expanded.has(group.path) || !!query.trim();
            const groupId = `${id}-project-${groupIndex}`;
            const sourceKinds = [
              ...new Set(group.chats.map((candidate) => candidate.sourceKind)),
            ];
            const existingChat = group.chats.find(
              (candidate) =>
                candidate.existingSessionId ||
                completedSessions.has(candidate.id),
            );
            const existingId =
              existingChat &&
              (existingChat.existingSessionId ??
                completedSessions.get(existingChat.id));
            return (
              <section className="gyro-import-project" key={group.path}>
                <div
                  className={`gyro-import-project-header${selectedCount > 0 ? " is-selected" : ""}`}
                >
                  <ImportCheckbox
                    checked={
                      availableIds.length > 0 &&
                      selectedCount === availableIds.length
                    }
                    mixed={
                      selectedCount > 0 && selectedCount < availableIds.length
                    }
                    disabled={busy || availableIds.length === 0}
                    label={`Select chats in ${projectName(group.path)}`}
                    onChange={() => toggle(availableIds)}
                  />
                  <button
                    aria-controls={groupId}
                    aria-expanded={isExpanded}
                    className="gyro-import-project-expand"
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.path)) next.delete(group.path);
                        else next.add(group.path);
                        return next;
                      })
                    }
                    type="button"
                  >
                    {isExpanded ? (
                      <ChevronDown aria-hidden="true" size={14} />
                    ) : (
                      <ChevronRight aria-hidden="true" size={14} />
                    )}
                    <Folder aria-hidden="true" size={16} />
                    <span>
                      <strong>{projectName(group.path)}</strong>
                      <span className="gyro-import-path" title={group.path}>
                        {group.path}
                      </span>
                    </span>
                  </button>
                  <div className="gyro-import-project-meta">
                    <span
                      className="gyro-import-provider-list"
                      aria-label={sourceKinds
                        .map((kind) => sourceLabels[kind])
                        .join(" and ")}
                    >
                      {sourceKinds.map((kind) => (
                        <ProviderMark kind={kind} key={kind} />
                      ))}
                    </span>
                    <span>
                      {group.chats.length}{" "}
                      {group.chats.length === 1 ? "chat" : "chats"}
                    </span>
                    <time dateTime={group.latest}>
                      {latestLabel(group.latest)}
                    </time>
                  </div>
                  {existingId && (
                    <button
                      className="gyro-import-button is-quiet"
                      type="button"
                      onClick={() => onOpenSession(existingId, group.path)}
                    >
                      Open project
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="gyro-import-chats" id={groupId}>
                    {group.chats.map((candidate) => {
                      const sessionId =
                        candidate.existingSessionId ??
                        completedSessions.get(candidate.id);
                      return (
                        <div
                          className={`gyro-import-chat${selected.has(candidate.id) && !sessionId ? " is-selected" : ""}`}
                          key={candidate.id}
                        >
                          <ImportCheckbox
                            checked={selected.has(candidate.id) && !sessionId}
                            disabled={busy || !!sessionId}
                            label={`Import ${candidate.title}`}
                            onChange={() => toggle([candidate.id])}
                          />
                          <ProviderMark kind={candidate.sourceKind} />
                          <div className="gyro-import-chat-copy">
                            <strong>{candidate.title}</strong>
                            <span>
                              {sourceLabels[candidate.sourceKind]} ·{" "}
                              <time dateTime={candidate.updatedAt}>
                                {latestLabel(candidate.updatedAt)}
                              </time>
                              {candidate.archived ? " · Archived" : ""}
                            </span>
                            {!candidate.workspaceAvailable && (
                              <span className="gyro-import-folder-missing">
                                Folder unavailable · Locate it after import to
                                continue
                              </span>
                            )}
                            <Diagnostics messages={candidate.diagnostics} />
                          </div>
                          <div className="gyro-import-row-actions">
                            {sessionId && (
                              <>
                                <span className="gyro-import-existing">
                                  Already in Gyro
                                </span>
                                <button
                                  className="gyro-import-button is-quiet"
                                  type="button"
                                  onClick={() =>
                                    onOpenSession(
                                      sessionId,
                                      candidate.workspacePath,
                                    )
                                  }
                                >
                                  Open
                                </button>
                                {!candidate.workspaceAvailable && (
                                  <button
                                    className="gyro-import-button is-quiet"
                                    type="button"
                                    onClick={() => onLocateFolder(sessionId)}
                                  >
                                    Locate folder
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          <div className="gyro-import-selection-footer">
            <span>
              {selectedIds.length
                ? `${selectedIds.length} ${selectedIds.length === 1 ? "chat" : "chats"} selected`
                : "Select projects or individual chats to import."}
            </span>
            <button
              className="gyro-import-button is-primary"
              disabled={busy || !selectedIds.length}
              onClick={() => onImport(selectedIds)}
              type="button"
            >
              Import {selectedIds.length}{" "}
              {selectedIds.length === 1 ? "chat" : "chats"}
            </button>
          </div>
        </SettingsGroup>
      )}
    </div>
  );
}

export function ImportedChatRecoveryNotice({
  kind,
  detail,
  onLocateFolder,
  onRetry,
  onContinueNewSession,
}: {
  kind: "missing-workspace" | "resume-unavailable";
  detail?: string;
  onLocateFolder?: () => void;
  onRetry?: () => void;
  onContinueNewSession?: () => void;
}) {
  return (
    <div className="gyro-import-recovery" role="status">
      <div>
        <strong>
          {kind === "missing-workspace"
            ? "Locate this project to continue"
            : "The original session could not resume"}
        </strong>
        <span>
          {detail ||
            (kind === "missing-workspace"
              ? "Your imported history is saved. Choose the project folder before sending a message."
              : "Your imported history is saved. Retry the original session or continue in a new one.")}
        </span>
      </div>
      <div className="gyro-import-row-actions">
        {kind === "missing-workspace" && onLocateFolder && (
          <button
            className="gyro-import-button"
            onClick={onLocateFolder}
            type="button"
          >
            Locate folder
          </button>
        )}
        {kind === "resume-unavailable" && (
          <>
            {onRetry && (
              <button
                className="gyro-import-button"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
            )}
            {onContinueNewSession && (
              <button
                className="gyro-import-button"
                onClick={onContinueNewSession}
                type="button"
              >
                Continue in a new session
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// The same provider marks used by Gyro's provider picker.
const CLAUDE_MARK =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_MARK =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
