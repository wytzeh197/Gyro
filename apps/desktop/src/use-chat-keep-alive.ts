import { useEffect, useRef } from "react";

import { decideKeepAlive, isKeepAliveCommand } from "@gyro-dev/ui";
import type { TerminalPane, WorkbenchAction } from "@gyro-dev/ui";

/**
 * Watch chat-owned long-running processes after the turn that started them
 * and relaunch the same command if they die without a person or model stop.
 */
export function useChatKeepAliveSupervisor({
  dispatch,
  panes,
  restart,
}: {
  dispatch: (action: WorkbenchAction) => void;
  panes: TerminalPane[];
  restart: (paneId: string) => void | Promise<void>;
}) {
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const restartRef = useRef(restart);
  restartRef.current = restart;
  const timersRef = useRef(new Map<string, number>());

  useEffect(() => {
    const now = new Date().toISOString();
    const liveIds = new Set<string>();
    for (const pane of panes) {
      if (!pane.owner || !isKeepAliveCommand(pane.command)) continue;
      liveIds.add(pane.id);
      const decision = decideKeepAlive({
        command: pane.command,
        paneStatus: pane.status,
        ownerTurnId: pane.owner.turnId,
        exitCode: pane.exitCode,
        keepAlive: pane.keepAlive,
        now,
      });
      if (decision.type === "noop") {
        continue;
      }
      dispatch({
        type: "set-terminal-pane-keep-alive",
        paneId: pane.id,
        keepAlive: decision.keepAlive,
      });
      if (decision.type !== "relaunch") {
        const pending = timersRef.current.get(pane.id);
        if (pending !== undefined) {
          window.clearTimeout(pending);
          timersRef.current.delete(pane.id);
        }
        continue;
      }
      if (timersRef.current.has(pane.id)) continue;
      const timer = window.setTimeout(() => {
        timersRef.current.delete(pane.id);
        const current = panesRef.current.find((item) => item.id === pane.id);
        if (
          !current?.owner ||
          current.owner.turnId !== pane.owner?.turnId ||
          current.command !== pane.command ||
          !isKeepAliveCommand(current.command) ||
          current.keepAlive?.phase !== "relaunching" ||
          current.keepAlive.stopOrigin ||
          (current.status !== "done" && current.status !== "failed")
        )
          return;
        void restartRef.current(pane.id);
      }, decision.delayMs);
      timersRef.current.set(pane.id, timer);
    }
    for (const [paneId, timer] of timersRef.current) {
      if (liveIds.has(paneId)) continue;
      window.clearTimeout(timer);
      timersRef.current.delete(paneId);
    }
  }, [dispatch, panes]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
    },
    [],
  );
}
