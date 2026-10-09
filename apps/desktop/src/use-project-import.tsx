import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ImportedChatRecoveryNotice,
  ProjectImportCallout,
  type ProjectImportJob,
  type ProjectImportScan,
  type ProjectImportSettingsProps,
  type ProjectImportSource,
  type ProjectImportSourceKind,
  type Session,
  type SessionEvent,
} from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

const STORAGE_KEY = "gyro.project-import.preferences";
type Preferences = {
  claudeDataHome?: string;
  codexDataHome?: string;
  includeArchived: boolean;
  dismissed: boolean;
};
type ImportedChatState = {
  workspaceAvailable: boolean;
  resumeUnavailable: boolean;
  error?: string;
};
function storedPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      claudeDataHome:
        typeof saved.claudeDataHome === "string"
          ? saved.claudeDataHome
          : undefined,
      codexDataHome:
        typeof saved.codexDataHome === "string"
          ? saved.codexDataHome
          : undefined,
      includeArchived: saved.includeArchived === true,
      dismissed: saved.dismissed === true,
    };
  } catch {
    return { includeArchived: false, dismissed: false };
  }
}

export function useProjectImport({
  enabled,
  visibleSessions,
  events,
  onOpenSettings,
  onOpenSession,
  onImported,
  onSessionUpdated,
  refreshEvents,
  onRetrySession,
}: {
  enabled: boolean;
  visibleSessions: Session[];
  events: SessionEvent[];
  onOpenSettings: () => void;
  onOpenSession: (id: string, path: string) => void;
  onImported: (paths: string[]) => void;
  onSessionUpdated: (session: Session) => void;
  refreshEvents: (id: string) => Promise<void>;
  onRetrySession: (id: string) => void;
}) {
  const [preferences, setPreferences] = useState(storedPreferences);
  const [sources, setSources] = useState<ProjectImportSource[]>([]);
  const [scan, setScan] = useState<ProjectImportScan>();
  const [job, setJob] = useState<ProjectImportJob>();
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [chatStates, setChatStates] = useState<
    Record<string, ImportedChatState>
  >({});
  const callbacks = useRef({ onImported, onSessionUpdated, refreshEvents });
  callbacks.current = { onImported, onSessionUpdated, refreshEvents };
  const completedJobs = useRef(new Set<string>());
  const latestJob = useRef<ProjectImportJob>();
  const sourceRequest = {
    claudeDataHome: preferences.claudeDataHome,
    codexDataHome: preferences.codexDataHome,
    includeArchived: preferences.includeArchived,
  };
  const requestKey = JSON.stringify(sourceRequest);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* Storage can be unavailable in preview/private webviews. */
    }
  }, [preferences]);

  const acceptJob = useCallback(
    (next: ProjectImportJob | null | undefined, restored = false) => {
      if (!next) return;
      const previous = latestJob.current;
      if (
        previous?.id === next.id &&
        (previous.completed > next.completed ||
          (previous.status !== "running" && next.status === "running"))
      )
        return;
      if (restored && previous && previous.id !== next.id) return;
      if (previous?.status === "running" && previous.id !== next.id) return;
      latestJob.current = next;
      setJob(next);
      const imported = next.results.filter((result) => result.sessionId);
      setScan((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates.map((candidate) => {
                const result = imported.find(
                  (item) => item.candidateId === candidate.id,
                );
                return result
                  ? { ...candidate, existingSessionId: result.sessionId }
                  : candidate;
              }),
            }
          : current,
      );
      if (next.status !== "running" && !completedJobs.current.has(next.id)) {
        completedJobs.current.add(next.id);
        if (imported.length) {
          setPreferences((current) => ({ ...current, dismissed: true }));
          if (!restored)
            callbacks.current.onImported([
              ...new Set(imported.map((result) => result.workspacePath)),
            ]);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return;
    let live = true;
    setLoadingSources(true);
    void invoke<ProjectImportSource[]>("get_project_import_sources", {
      request: JSON.parse(requestKey),
    })
      .then((next) => {
        if (live) setSources(next ?? []);
      })
      .catch((reason) => {
        if (live) setError(String(reason));
      })
      .finally(() => {
        if (live) setLoadingSources(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, requestKey]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let closed = false;
    const subscription = listen<ProjectImportJob>(
      "project-import-progress",
      ({ payload }) => {
        if (!closed) acceptJob(payload);
      },
    );
    void subscription.catch((reason) => {
      if (!closed) setError(String(reason));
    });
    return () => {
      closed = true;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [acceptJob]);

  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return;
    void invoke<ProjectImportJob | null>("get_project_import_job", {})
      .then((next) => acceptJob(next, true))
      .catch((reason) => setError(String(reason)));
  }, [enabled, acceptJob]);

  const checkChat = useCallback(async (session: Session) => {
    if (!session.importSource || !isTauriRuntime()) return;
    try {
      const state = await invoke<ImportedChatState>("get_imported_chat_state", {
        sessionId: session.id,
      });
      if (state)
        setChatStates((current) => ({ ...current, [session.id]: state }));
    } catch (reason) {
      setChatStates((current) => ({
        ...current,
        [session.id]: {
          workspaceAvailable: false,
          resumeUnavailable: false,
          error: String(reason),
        },
      }));
    }
  }, []);
  const chatCheckKey = JSON.stringify(
    visibleSessions
      .filter((session) => session.importSource)
      .map((session) => [
        session.id,
        session.workspacePath,
        session.importSource?.freshSessionRequested,
      ]),
  );
  const visibleSessionsRef = useRef(visibleSessions);
  visibleSessionsRef.current = visibleSessions;
  useEffect(() => {
    for (const session of visibleSessionsRef.current)
      if (session.importSource) void checkChat(session);
  }, [chatCheckKey, events.length, checkChat]);

  const scanProjects = useCallback(async () => {
    if (scanning || job?.status === "running") return;
    setError(undefined);
    setScanning(true);
    try {
      const next = await invoke<ProjectImportScan>("scan_project_imports", {
        request: JSON.parse(requestKey),
      });
      setScan(next);
      setSources(next.sources);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setScanning(false);
    }
  }, [requestKey, scanning, job?.status]);

  const chooseDataFolder = useCallback(
    async (kind: ProjectImportSourceKind) => {
      try {
        const path = await open({
          directory: true,
          multiple: false,
          title:
            kind === "claude-code"
              ? "Choose Claude Code data folder"
              : "Choose Codex data folder",
        });
        if (typeof path !== "string") return;
        setPreferences((current) => ({
          ...current,
          [kind === "claude-code" ? "claudeDataHome" : "codexDataHome"]: path,
        }));
        setScan(undefined);
        setError(undefined);
      } catch (reason) {
        setError(String(reason));
      }
    },
    [],
  );

  const importChats = useCallback(
    async (candidateIds: string[]) => {
      if (!scan || !candidateIds.length || job?.status === "running") return;
      setError(undefined);
      try {
        acceptJob(
          await invoke<ProjectImportJob>("start_project_import", {
            scanId: scan.scanId,
            candidateIds,
          }),
        );
      } catch (reason) {
        setError(String(reason));
      }
    },
    [scan, job?.status, acceptJob],
  );
  const cancelImport = useCallback(async () => {
    if (!job || job.status !== "running") return;
    try {
      await invoke<void>("cancel_project_import", { jobId: job.id });
      acceptJob(
        await invoke<ProjectImportJob | null>("get_project_import_job", {
          jobId: job.id,
        }),
      );
    } catch (reason) {
      setError(String(reason));
    }
  }, [job, acceptJob]);

  const locateFolder = useCallback(
    async (id: string) => {
      try {
        const path = await open({
          directory: true,
          multiple: false,
          title: "Locate this project's folder",
        });
        if (typeof path !== "string") return;
        const updated = await invoke<Session>("relocate_imported_project", {
          sessionId: id,
          workspacePath: path,
        });
        callbacks.current.onSessionUpdated(updated);
        callbacks.current.onImported([path]);
        await callbacks.current.refreshEvents(id);
        await checkChat(updated);
      } catch (reason) {
        setError(String(reason));
      }
    },
    [checkChat],
  );
  const continueNewSession = useCallback(
    async (session: Session) => {
      try {
        const updated = await invoke<Session>(
          "continue_import_in_new_session",
          { sessionId: session.id },
        );
        callbacks.current.onSessionUpdated(updated);
        await callbacks.current.refreshEvents(session.id);
        await checkChat(updated);
      } catch (reason) {
        setError(String(reason));
      }
    },
    [checkChat],
  );

  const dismiss = useCallback(
    () => setPreferences((current) => ({ ...current, dismissed: true })),
    [],
  );
  const settingsProps: ProjectImportSettingsProps = {
    sources,
    scan,
    job,
    scanning,
    loadingSources,
    error,
    includeArchived: preferences.includeArchived,
    onIncludeArchivedChange: (includeArchived) => {
      setPreferences((current) => ({ ...current, includeArchived }));
      setScan(undefined);
    },
    onChooseDataFolder: (kind) => void chooseDataFolder(kind),
    onScan: () => void scanProjects(),
    onImport: (ids) => void importChats(ids),
    onCancel: () => void cancelImport(),
    onOpenSession,
    onLocateFolder: (id) => void locateFolder(id),
    onRetry: () => void scanProjects(),
  };
  const chatProps = (session?: Session) => {
    const state = session ? chatStates[session.id] : undefined;
    const missing = Boolean(
      session?.importSource &&
      state &&
      !state.error &&
      !state.workspaceAvailable,
    );
    const checking = Boolean(session?.importSource && !state);
    const unavailable = Boolean(
      session?.importSource &&
      !session.importSource.freshSessionRequested &&
      state?.resumeUnavailable,
    );
    return {
      welcomeCallout: !preferences.dismissed ? (
        <ProjectImportCallout onOpen={onOpenSettings} onDismiss={dismiss} />
      ) : undefined,
      composerBlockedReason: missing
        ? "Locate this imported project's folder before sending"
        : checking
          ? "Checking this imported project's folder…"
          : state?.error
            ? "Could not verify this imported project's folder"
            : undefined,
      chatNotice:
        session?.importSource &&
        state &&
        (missing || unavailable || state.error) ? (
          <ImportedChatRecoveryNotice
            kind={missing ? "missing-workspace" : "resume-unavailable"}
            detail={state.error}
            onLocateFolder={() => void locateFolder(session.id)}
            onRetry={() =>
              state.error ? void checkChat(session) : onRetrySession(session.id)
            }
            onContinueNewSession={() => void continueNewSession(session)}
          />
        ) : undefined,
    };
  };
  return { settingsProps, chatProps };
}
