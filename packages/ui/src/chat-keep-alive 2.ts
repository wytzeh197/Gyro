import type {
  TerminalKeepAlive,
  TerminalPane,
  TerminalPaneStatus,
} from "./types.ts";
import { persistentProcessKind } from "./chat-process-command.ts";

/** Auto-relaunch budget for one supervised process. */
export const KEEP_ALIVE_MAX_RESTARTS = 3;

/** SIGINT / SIGHUP — the person stopped it from the terminal. */
const USER_INTERRUPT_EXIT_CODES = new Set([130, 129]);

export type KeepAliveKind = "dev-server" | "watcher" | "service";
export type KeepAlivePhase = TerminalKeepAlive["phase"];

export type KeepAliveWatch = {
  paneId: string;
  sessionId: string;
  turnId: string;
  command: string;
  title: string;
  kind: KeepAliveKind;
  phase: KeepAlivePhase;
  stopOrigin?: TerminalKeepAlive["stopOrigin"];
  restartCount: number;
  lastRelaunchedAt?: string;
  exitCode?: number | null;
};

export type KeepAliveDecision =
  | { type: "noop" }
  | { type: "set"; keepAlive: TerminalKeepAlive }
  | { type: "relaunch"; keepAlive: TerminalKeepAlive; delayMs: number };

/**
 * Supervise explicit servers/watchers only; unknown commands are finite by default.
 */
export function isKeepAliveCommand(command: string): boolean {
  return persistentProcessKind(command) !== undefined;
}

export function keepAliveKind(command: string): KeepAliveKind {
  return persistentProcessKind(command) ?? "service";
}

export function keepAliveTitle(input: {
  command: string;
  title?: string;
  taskTitle?: string;
}): string {
  const task = input.taskTitle?.trim();
  if (task) return task;
  switch (keepAliveKind(input.command)) {
    case "dev-server":
      return "Dev server";
    case "watcher":
      return "Watcher";
    case "service":
      return input.title?.trim() || "Process";
  }
}

export function keepAliveStatusLabel(
  watch: Pick<KeepAliveWatch, "phase" | "restartCount">,
): string {
  switch (watch.phase) {
    case "relaunching":
      return "Relaunching";
    case "stopped":
      return "Stopped";
    case "exited":
      return "Stopped unexpectedly";
    case "watching":
      return watch.restartCount > 0 ? "Relaunched · watching" : "Watching";
  }
}

export function keepAliveBackoffMs(restartCount: number): number {
  if (restartCount <= 1) return 0;
  if (restartCount === 2) return 1500;
  return 4000;
}

function sameKeepAlive(
  left: TerminalKeepAlive | undefined,
  right: TerminalKeepAlive,
): boolean {
  return (
    left?.turnId === right.turnId &&
    left.restartCount === right.restartCount &&
    left.phase === right.phase &&
    left.stopOrigin === right.stopOrigin &&
    left.lastRelaunchedAt === right.lastRelaunchedAt
  );
}

function isLiveStatus(status: TerminalPaneStatus): boolean {
  return status === "running" || status === "waiting";
}

function isFinishedStatus(status: TerminalPaneStatus): boolean {
  return status === "done" || status === "failed";
}

function wasUserInterrupt(exitCode: number | null | undefined): boolean {
  return (
    typeof exitCode === "number" && USER_INTERRUPT_EXIT_CODES.has(exitCode)
  );
}

/**
 * Decide whether to arm, relaunch, or settle a chat-owned keep-alive.
 *
 * Relaunch only when the process died on its own. An explicit stop (Stop in
 * chat or Terminal, or `gyro_terminal_stop`) and a Ctrl+C (exit 130) are
 * treated as the person ending it.
 */
export function decideKeepAlive(input: {
  command: string;
  paneStatus: TerminalPaneStatus;
  ownerTurnId?: string;
  stopKind?: "explicit" | "exited" | null;
  exitCode?: number | null;
  keepAlive?: TerminalKeepAlive;
  now?: string;
}): KeepAliveDecision {
  if (!isKeepAliveCommand(input.command)) return { type: "noop" };
  const turnId = input.ownerTurnId ?? input.keepAlive?.turnId;
  if (!turnId) return { type: "noop" };

  if (isLiveStatus(input.paneStatus)) {
    if (input.keepAlive?.phase === "relaunching") {
      const next: TerminalKeepAlive = {
        turnId: input.keepAlive.turnId,
        restartCount: input.keepAlive.restartCount,
        phase: "watching",
        lastRelaunchedAt: input.now ?? input.keepAlive.lastRelaunchedAt,
      };
      return sameKeepAlive(input.keepAlive, next)
        ? { type: "noop" }
        : { type: "set", keepAlive: next };
    }
    const next: TerminalKeepAlive = {
      turnId,
      restartCount:
        input.keepAlive?.turnId === turnId
          ? (input.keepAlive.restartCount ?? 0)
          : 0,
      phase: "watching",
      lastRelaunchedAt:
        input.keepAlive?.turnId === turnId
          ? input.keepAlive.lastRelaunchedAt
          : undefined,
    };
    return sameKeepAlive(input.keepAlive, next)
      ? { type: "noop" }
      : { type: "set", keepAlive: next };
  }

  if (!isFinishedStatus(input.paneStatus) || !input.keepAlive) {
    return { type: "noop" };
  }
  if (
    input.keepAlive.phase === "stopped" ||
    input.keepAlive.phase === "exited"
  ) {
    return { type: "noop" };
  }
  if (input.keepAlive.phase === "relaunching") {
    return { type: "noop" };
  }

  const explicitStop =
    input.keepAlive.stopOrigin !== undefined ||
    input.stopKind === "explicit" ||
    wasUserInterrupt(input.exitCode);
  if (explicitStop) {
    const next: TerminalKeepAlive = {
      ...input.keepAlive,
      phase: "stopped",
      stopOrigin: input.keepAlive.stopOrigin ?? "user",
    };
    return sameKeepAlive(input.keepAlive, next)
      ? { type: "noop" }
      : { type: "set", keepAlive: next };
  }

  if (input.keepAlive.restartCount >= KEEP_ALIVE_MAX_RESTARTS) {
    const next: TerminalKeepAlive = { ...input.keepAlive, phase: "exited" };
    return sameKeepAlive(input.keepAlive, next)
      ? { type: "noop" }
      : { type: "set", keepAlive: next };
  }

  const restartCount = input.keepAlive.restartCount + 1;
  return {
    type: "relaunch",
    keepAlive: {
      turnId: input.keepAlive.turnId,
      restartCount,
      phase: "relaunching",
    },
    delayMs: keepAliveBackoffMs(restartCount),
  };
}

export function keepAliveWatchesFromPanes(
  panes: readonly Pick<
    TerminalPane,
    | "id"
    | "title"
    | "command"
    | "owner"
    | "keepAlive"
    | "exitCode"
    | "taskTitle"
  >[],
): KeepAliveWatch[] {
  const watches: KeepAliveWatch[] = [];
  for (const pane of panes) {
    if (!pane.owner || !pane.keepAlive || !isKeepAliveCommand(pane.command))
      continue;
    watches.push({
      paneId: pane.id,
      sessionId: pane.owner.sessionId,
      turnId: pane.keepAlive.turnId,
      command: pane.command,
      title: keepAliveTitle({
        command: pane.command,
        title: pane.title,
        taskTitle: pane.taskTitle,
      }),
      kind: keepAliveKind(pane.command),
      phase: pane.keepAlive.phase,
      stopOrigin: pane.keepAlive.stopOrigin,
      restartCount: pane.keepAlive.restartCount,
      lastRelaunchedAt: pane.keepAlive.lastRelaunchedAt,
      exitCode: pane.exitCode,
    });
  }
  return watches;
}
