import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SourceControlState, WorkbenchAction } from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

type GitSyncResult = {
  output: {
    status: string;
    stdout: string;
    stderr: string;
  };
  status: SourceControlState;
};

type RemoteCheck = {
  root: string;
  branch: string;
  status: "checking" | "checked" | "failed";
  error?: string;
};

export function useRemoteCheck({
  root,
  sourceControl,
  visible,
  trusted,
  currentRoot,
  dispatch,
  notify,
}: {
  root?: string;
  sourceControl: SourceControlState;
  visible: boolean;
  trusted: boolean;
  currentRoot: React.RefObject<string | undefined>;
  dispatch: React.Dispatch<WorkbenchAction>;
  notify: (kind: "command-failed", title: string, detail: string) => void;
}) {
  const [remoteCheck, setRemoteCheck] = useState<RemoteCheck>();
  const inFlight = useRef(new Set<string>());
  const branch = sourceControl.branch;
  const upstream = sourceControl.upstream;

  const checkRemoteChanges = useCallback(
    async (quiet = false) => {
      if (!root || !branch || !upstream || !isTauriRuntime()) return;
      if (!trusted) {
        if (!quiet) {
          notify(
            "command-failed",
            "Remote check blocked in Restricted Mode",
            root.split("/").filter(Boolean).at(-1) ?? "Untitled",
          );
        }
        return;
      }
      const key = `${root}\0${branch}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setRemoteCheck({ root, branch, status: "checking" });
      try {
        const remote = upstream.split("/")[0];
        const result = await invoke<GitSyncResult>("git_fetch", {
          request: { workspacePath: root, remote },
        });
        if (result.output.status !== "done") {
          const detail = [result.output.stderr, result.output.stdout]
            .map((text) => text?.trim())
            .find(Boolean)
            ?.split("\n")[0];
          throw new Error(detail ?? "git could not reach the remote");
        }
        if (currentRoot.current === root && result.status.branch === branch) {
          dispatch({
            type: "ide-set-source-control",
            sourceControl: result.status,
          });
        }
        setRemoteCheck({ root, branch, status: "checked" });
      } catch (error) {
        const detail = String(error);
        setRemoteCheck({ root, branch, status: "failed", error: detail });
        if (!quiet) notify("command-failed", "Remote check failed", detail);
      } finally {
        inFlight.current.delete(key);
      }
    },
    [branch, currentRoot, dispatch, notify, root, trusted, upstream],
  );

  useEffect(() => {
    if (!visible || !upstream || !branch) return;
    void checkRemoteChanges(true);
    const timer = window.setInterval(() => {
      void checkRemoteChanges(true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [branch, checkRemoteChanges, upstream, visible]);

  const current =
    remoteCheck?.root === root && remoteCheck?.branch === branch
      ? remoteCheck
      : undefined;
  const message =
    current?.status === "checking"
      ? "Checking GitHub for changes…"
      : current?.status === "failed"
        ? `GitHub check failed: ${current.error}`
        : current?.status === "checked"
          ? sourceControl.upstreamGone
            ? "Tracked branch was deleted on the remote"
            : sourceControl.behind > 0
              ? `${sourceControl.behind} incoming commit${sourceControl.behind === 1 ? "" : "s"} on GitHub`
              : "No new commits on GitHub"
          : undefined;

  return {
    checkRemoteChanges,
    isRemoteChecking: current?.status === "checking",
    remoteCheckFailed: current?.status === "failed",
    remoteCheckMessage: message,
  };
}
