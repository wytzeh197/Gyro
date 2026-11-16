import type { Dispatch } from "react";
import type {
  TaskDefinition,
  TestTreeItem,
  WorkbenchAction,
} from "@gyro-dev/ui";

/** Keep task status and the existing test tree together without hiding other tests. */
export function createIdeTaskStatusUpdater({
  task,
  root,
  startedAt,
  commandLine,
  testTree,
  dispatch,
}: {
  task: TaskDefinition;
  root: string;
  startedAt: number;
  commandLine: string;
  testTree: TestTreeItem[];
  dispatch: Dispatch<WorkbenchAction>;
}) {
  return (
    status: TaskDefinition["status"],
    testStatus?: "running" | "passed" | "failed",
  ) => {
    const finished =
      status === "done" || status === "failed" || status === "cancelled";
    dispatch({
      type: "ide-set-task-status",
      taskId: task.id,
      status,
      lastRunAt: new Date().toISOString(),
      workspacePath: root,
      commandLine,
      durationMs:
        finished && task.group !== "dev" && status !== "cancelled"
          ? Date.now() - startedAt
          : undefined,
    });
    if (task.group === "test" && testStatus) {
      // Update the run test in place. Replacing the tree with only the
      // tests that ran hid every other discovered test after one run.
      const suite = testTree[0];
      const children = suite?.children ?? [];
      const result = {
        id: task.id,
        label: task.label,
        status: testStatus,
      } as const;
      const nextChildren = children.some((item) => item.id === task.id)
        ? children.map((item) => (item.id === task.id ? result : item))
        : [...children, result];
      dispatch({
        type: "ide-set-test-tree",
        tests: [
          {
            id: suite?.id ?? "workspace-tests",
            label: suite?.label ?? "Workspace tests",
            status: nextChildren.some((item) => item.status === "failed")
              ? "failed"
              : nextChildren.some((item) => item.status === "running")
                ? "running"
                : testStatus,
            children: nextChildren,
          },
          ...testTree.slice(1),
        ],
      });
    }
  };
}
