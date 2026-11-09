import type { TaskDefinition, TaskRunRecord, TaskRunRecords } from "./types";
import { normalizedWorkspaceFolderPath } from "./workspace-project.ts";

export const MAX_TASK_RUN_WORKSPACES = 20;
export const MAX_TASK_RUN_RECORDS = 50;

export function taskRunCommandLine(task: Pick<TaskDefinition, "command" | "args">) {
  return [task.command, ...task.args].join(" ");
}

function newestRecordAt(records: Record<string, TaskRunRecord>) {
  return Object.values(records).reduce(
    (newest, record) => (record.lastRunAt > newest ? record.lastRunAt : newest),
    "",
  );
}

/** Drops the oldest workspaces and, within each, the oldest commands. */
export function capTaskRunRecords(records: TaskRunRecords): TaskRunRecords {
  const workspaces = Object.entries(records)
    .map(([path, commands]) => {
      const kept = Object.entries(commands)
        .sort(([, first], [, second]) =>
          second.lastRunAt.localeCompare(first.lastRunAt),
        )
        .slice(0, MAX_TASK_RUN_RECORDS);
      return [path, Object.fromEntries(kept)] as const;
    })
    .filter(([, commands]) => Object.keys(commands).length > 0)
    .sort(([, first], [, second]) =>
      newestRecordAt(second).localeCompare(newestRecordAt(first)),
    )
    .slice(0, MAX_TASK_RUN_WORKSPACES);
  return Object.fromEntries(workspaces);
}

export function rememberTaskRun(
  records: TaskRunRecords,
  workspacePath: string,
  taskId: string,
  record: TaskRunRecord,
): TaskRunRecords {
  const path = workspacePath.trim();
  if (!path || !taskId || !record.commandLine || !record.lastRunAt) {
    return records;
  }
  const key = normalizedWorkspaceFolderPath(path);
  return capTaskRunRecords({
    ...records,
    [key]: {
      ...records[key],
      [taskId]: record,
    },
  });
}

/**
 * Copies remembered results onto a freshly discovered catalog.
 * A command line that no longer matches is forgotten, same as the tamper check.
 * A command that is running in this session keeps that live status.
 */
export function mergeDiscoveredTaskRuns(
  previous: TaskDefinition[],
  discovered: TaskDefinition[],
  records: Record<string, TaskRunRecord> | undefined,
): { tasks: TaskDefinition[]; records: Record<string, TaskRunRecord> } {
  const nextRecords = { ...(records ?? {}) };
  const running = new Map(
    previous
      .filter((task) => task.status === "running")
      .map((task) => [task.id, task]),
  );
  const tasks = discovered.map((task) => {
    const live = running.get(task.id);
    if (live && taskRunCommandLine(live) === taskRunCommandLine(task)) {
      return {
        ...task,
        status: "running" as const,
        lastRunAt: live.lastRunAt,
        durationMs: live.durationMs,
      };
    }
    const record = nextRecords[task.id];
    if (!record) {
      return task;
    }
    if (record.commandLine !== taskRunCommandLine(task)) {
      delete nextRecords[task.id];
      return task;
    }
    return {
      ...task,
      status: record.status,
      lastRunAt: record.lastRunAt,
      durationMs: record.durationMs,
    };
  });
  return { tasks, records: nextRecords };
}

function parsedTaskRunRecord(value: unknown): TaskRunRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "done" && status !== "failed" && status !== "cancelled") {
    return undefined;
  }
  if (typeof record.lastRunAt !== "string" || !record.lastRunAt) {
    return undefined;
  }
  if (
    typeof record.commandLine !== "string" ||
    !record.commandLine ||
    record.commandLine.length > 2_000
  ) {
    return undefined;
  }
  const durationMs =
    typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
      ? Math.max(0, Math.round(record.durationMs))
      : undefined;
  return {
    status,
    lastRunAt: record.lastRunAt,
    commandLine: record.commandLine,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export function sanitizeTaskRunRecords(value: unknown): TaskRunRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  let records: TaskRunRecords = {};
  for (const [path, rawWorkspace] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !path ||
      path.length > 4_096 ||
      !rawWorkspace ||
      typeof rawWorkspace !== "object" ||
      Array.isArray(rawWorkspace)
    ) {
      continue;
    }
    for (const [taskId, rawRecord] of Object.entries(
      rawWorkspace as Record<string, unknown>,
    )) {
      if (!taskId || taskId.length > 300) continue;
      const record = parsedTaskRunRecord(rawRecord);
      if (!record) continue;
      records = rememberTaskRun(records, path, taskId, record);
    }
  }
  return records;
}
