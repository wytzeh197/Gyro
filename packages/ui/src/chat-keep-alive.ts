import type { TerminalKeepAlive, TerminalPane, TerminalPaneStatus } from "./types.ts";

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

const KEEP_ALIVE_PATTERN =
  /\b(dev|serve|server|start|watch|storybook|nodemon|vite|next|nuxt|remix|astro|uvicorn|runserver|watchexec|foreman|honcho|overmind|webpack-dev-server|parcel|turbo)\b/i;
const WATCHER_PATTERN =
  /\b(watch|nodemon|watchexec|cargo\s+watch)\b|--watch\b|watch:/i;
const DEV_SERVER_PATTERN =
  /\b(dev|serve|server|start|storybook|vite|next|nuxt|remix|astro|uvicorn|runserver|webpack-dev-server|parcel)\b/i;
const FINITE_WAITER_PATTERN = /\bgh\s+run\s+watch\b/i;
const FINITE_COMMAND_PATTERN =
  /\b(test|lint|typecheck|tsc|build|compile|install|ci|publish|deploy|fmt|format|check)\b/i;

/**
 * A command the model started so it would stay up: a dev server, a watcher,
 * or any other chat-owned process that is not a one-shot build/test/wait.
 */
export function isKeepAliveCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  if (FINITE_WAITER_PATTERN.test(text)) return false;
  if (KEEP_ALIVE_PATTERN.test(text) || /--watch\b/.test(text)) return true;
  if (FINITE_COMMAND_PATTERN.test(text)) return false;
  return true;
}

export function keepAliveKind(command: string): KeepAliveKind {
  if (WATCHER_PATTERN.test(command) && !DEV_SERVER_PATTERN.test(command)) {
    return "watcher";
  }
  if (DEV_SERVER_PATTERN.test(command)) return "dev-server";
  return "service";
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

export function keepAliveStatusLabel(watch: Pick<KeepAliveWatch, "phase" | "restartCount">): string {
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
  return typeof exitCode === "number" && USER_INTERRUPT_EXIT_CODES.has(exitCode);
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
      return sameKeepAlive(input.keepAlive, next) ? { type: "noop" } : { type: "set", keepAlive: next };
    }
    const next: TerminalKeepAlive = {
      turnId,
      restartCount:
        input.keepAlive?.turnId === turnId ? (input.keepAlive.restartCount ?? 0) : 0,
      phase: "watching",
      lastRelaunchedAt:
        input.keepAlive?.turnId === turnId
          ? input.keepAlive.lastRelaunchedAt
          : undefined,
    };
    return sameKeepAlive(input.keepAlive, next) ? { type: "noop" } : { type: "set", keepAlive: next };
  }

  if (!isFinishedStatus(input.paneStatus) || !input.keepAlive) {
    return { type: "noop" };
  }
  if (input.keepAlive.phase === "stopped" || input.keepAlive.phase === "exited") {
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
    return sameKeepAlive(input.keepAlive, next) ? { type: "noop" } : { type: "set", keepAlive: next };
  }

  if (input.keepAlive.restartCount >= KEEP_ALIVE_MAX_RESTARTS) {
    const next: TerminalKeepAlive = { ...input.keepAlive, phase: "exited" };
    return sameKeepAlive(input.keepAlive, next) ? { type: "noop" } : { type: "set", keepAlive: next };
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
    if (!pane.owner || !pane.keepAlive) continue;
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
