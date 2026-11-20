import { useCallback, type Dispatch, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  askTextValue,
  createTerminalPane,
  defaultCommandProfiles,
  isWorkspaceTrusted,
  providersForConfig,
  terminalLaunchProfiles,
  type CommandProfile,
  type GyroConfig,
  type TerminalTemplate,
  type WorkbenchAction,
  type WorkbenchState,
  type createNotification,
} from "@gyro-dev/ui";
import {
  getCommandProfile,
  profileSupportsGovernance,
  terminalProcessForProfile,
  terminalSizeForTemplate,
  terminalStatusFromSnapshot,
  type TerminalPaneSnapshot,
} from "./app-state";
import { workspaceRunMetadata } from "./session-creation";
import { isTauriRuntime } from "./tauri-runtime";

type TerminalLaunchOptions = {
  commandProfiles: CommandProfile[];
  config: GyroConfig;
  dispatchWorkbench: Dispatch<WorkbenchAction>;
  notify: (
    kind: Parameters<typeof createNotification>[1],
    title: string,
    detail: string,
  ) => void;
  setTerminalOutput: (output: string) => void;
  terminalOutputRevisionRef: MutableRefObject<Record<string, number>>;
  workbench: WorkbenchState;
  workspaceActionRoot?: string;
};

export function useTerminalLaunch({
  commandProfiles,
  config,
  dispatchWorkbench,
  notify,
  setTerminalOutput,
  terminalOutputRevisionRef,
  workbench,
  workspaceActionRoot,
}: TerminalLaunchOptions) {
  const launchTerminalPane = useCallback(
    async ({
      commandOverride,
      paneId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      profile,
      startingOutput = "",
      template,
      workspacePathOverride,
      startInHome = false,
      reveal = true,
      select = false,
      taskTitle,
      workspaceTaskId,
    }: {
      commandOverride?: string;
      paneId?: string;
      profile: CommandProfile;
      startingOutput?: string;
      template?: TerminalTemplate;
      workspacePathOverride?: string;
      startInHome?: boolean;
      /** Background tasks stay visible in the task rail until explicitly opened. */
      reveal?: boolean;
      /** User launches can select their pane without opening the workspace drawer. */
      select?: boolean;
      taskTitle?: string;
      workspaceTaskId?: string;
    }) => {
      // Resolve again at the launch boundary: saved profiles and alternate actions
      // must obey the same connection gate as the start screen.
      const resolved = terminalLaunchProfiles(
        [profile],
        providersForConfig(config),
        workbench.providerStatuses,
      )[0];
      if (!resolved) return false;
      if (resolved.launchUnavailableReason) {
        notify(
          "command-failed",
          `${profile.displayName}: ${resolved.launchUnavailableReason}`,
          "Check this provider in Settings before launching its CLI.",
        );
        return false;
      }
      profile = resolved;
      const process = terminalProcessForProfile(profile, commandOverride);
      const existingPane = workbench.terminalPanes.find(
        (pane) => pane.id === paneId,
      );
      const selectedPane = workbench.terminalPanes.find(
        (pane) => pane.id === workbench.selectedTerminalPaneId,
      );
      const launchWorkspacePath = startInHome
        ? undefined
        : (workspacePathOverride ??
          existingPane?.projectPath ??
          (template ? selectedPane?.projectPath : undefined) ??
          workspaceActionRoot);
      if (
        launchWorkspacePath &&
        !isWorkspaceTrusted(
          workbench.preferences.workspaceTrust,
          launchWorkspacePath,
        )
      ) {
        notify(
          "command-failed",
          "Terminal blocked in Restricted Mode",
          "Trust this workspace before running local commands",
        );
        return false;
      }
      const paneExists = Boolean(existingPane);
      if (!paneExists) {
        const pane = createTerminalPane(paneId, profile, "running", {
          ...workspaceRunMetadata(
            "local",
            profile.displayName,
            launchWorkspacePath,
          ),
          projectPath: launchWorkspacePath,
          taskTitle,
          workspaceTaskId,
        });
        if (template) {
          dispatchWorkbench({ type: "split-terminal-pane", pane, template });
        } else if (reveal) {
          dispatchWorkbench({ type: "add-terminal-pane", pane });
        } else {
          dispatchWorkbench({ type: "upsert-background-terminal-pane", pane });
        }
      }
      if (select) {
        dispatchWorkbench({ type: "select-terminal-pane", paneId });
      }
      dispatchWorkbench({
        type: "run-terminal-pane",
        paneId,
        profileId: profile.id,
        command: process.displayCommand,
        output: startingOutput,
        reveal,
      });
      setTerminalOutput(startingOutput);

      if (profile.readiness === "blocked") {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "failed",
          event: "profile blocked",
        });
        return false;
      }

      if (!isTauriRuntime()) {
        notify("approval", "Command waiting", profile.displayName);
        return true;
      }

      try {
        const size = template ? terminalSizeForTemplate(template) : undefined;
        const paneRequest = {
          args: process.args,
          cols: size?.cols,
          command: process.command,
          paneId,
          profileId: profile.id,
          rows: size?.rows,
          title: profile.displayName,
          workspacePath: launchWorkspacePath,
          workspaceMode: "local",
          workingDirectory: workspacePathOverride
            ? "Exact workspace"
            : launchWorkspacePath
              ? "Workspace"
              : "Home",
        };
        // Ask for governance when the profile supports it. If the backend
        // cannot honour it the pane still opens, but ungoverned and labelled
        // as such — a pane must never look protected when it is not.
        // A command override runs through `zsh -ilc`, not the agent binary, so
        // it never carries the profile's governance.
        const wantsGovernance =
          !commandOverride &&
          Boolean(launchWorkspacePath) &&
          profileSupportsGovernance(profile);
        let snapshot: TerminalPaneSnapshot;
        try {
          snapshot = await invoke<TerminalPaneSnapshot>(
            "create_terminal_pane",
            {
              request: { ...paneRequest, governed: wantsGovernance },
            },
          );
        } catch (governanceError) {
          if (!wantsGovernance || String(governanceError).includes("terminal launch cancelled")) {
            throw governanceError;
          }
          notify(
            "approval",
            "Terminal running without Gyro approvals",
            String(governanceError),
          );
          snapshot = await invoke<TerminalPaneSnapshot>(
            "create_terminal_pane",
            {
              request: { ...paneRequest, governed: false },
            },
          );
        }
        const status = terminalStatusFromSnapshot(snapshot.status);
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          paneId: snapshot.paneId,
          command: snapshot.command,
          projectPath: snapshot.workspacePath ?? launchWorkspacePath,
          workingDirectory: snapshot.workingDirectory,
          event:
            snapshot.exitCode === null || snapshot.exitCode === undefined
              ? snapshot.status
              : `${snapshot.status} (${snapshot.exitCode})`,
          output: snapshot.output ?? "",
          outputCursor: snapshot.outputCursor,
          outputComplete: snapshot.outputComplete,
          status,
          hasForegroundJob: snapshot.hasForegroundJob ?? undefined,
          governedSessionId: snapshot.governedSessionId ?? undefined,
          governedProviderId: snapshot.governedProviderId ?? undefined,
        });
        terminalOutputRevisionRef.current[snapshot.paneId] =
          snapshot.outputRevision;
        setTerminalOutput(snapshot.output ?? "");
        return true;
      } catch (error) {
        const output = `Failed to start ${profile.displayName}\n${String(error)}`;
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          command: process.displayCommand,
          paneId,
          output,
          status: "failed",
          event: "process failed to start",
        });
        setTerminalOutput(output);
        return false;
      }
    },
    [
      config,
      workbench.providerStatuses,
      notify,
      workbench.selectedTerminalPaneId,
      workbench.terminalPanes,
      workbench.preferences.workspaceTrust,
      workbench.workspaceMode,
      workspaceActionRoot,
    ],
  );

  const addTerminalPane = useCallback(
    async (options?: {
      reveal?: boolean;
      directory?: "home" | "choose";
      folderPath?: string;
    }) => {
      let folderPath = options?.folderPath;
      try {
        if (options?.directory === "choose") {
          const selected = isTauriRuntime()
            ? await open({
                directory: true,
                multiple: false,
                title: "Open terminal in folder",
              })
            : await askTextValue({
                title: "Open terminal in folder",
                label: "Folder path",
                initialValue: workspaceActionRoot ?? "",
                confirmLabel: "Open",
              });
          if (typeof selected !== "string" || !selected.trim()) return;
          folderPath = selected;
        }
        const profile = getCommandProfile(
          [...commandProfiles, ...defaultCommandProfiles()],
          "shell",
        );
        const started = await launchTerminalPane({
          profile,
          reveal: options?.reveal,
          select: true,
          startInHome: !folderPath,
          workspacePathOverride: folderPath,
        });
        notify(
          started ? "terminal" : "command-failed",
          started ? "Terminal added" : "Terminal start failed",
          profile.displayName,
        );
      } catch (error) {
        notify("command-failed", "Could not open terminal", String(error));
      }
    },
    [commandProfiles, launchTerminalPane, notify, workspaceActionRoot],
  );

  return { launchTerminalPane, addTerminalPane };
}
