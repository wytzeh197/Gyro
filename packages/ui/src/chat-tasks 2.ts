import { latestFileReviewTurn } from "./file-review.ts";
import { workItemFromEvent } from "./chat-run.ts";
import type { Session, SessionEvent, Task } from "./types.ts";

export function chatTaskFromSession(
  task: Task,
  session: Session | undefined,
  events: SessionEvent[] | undefined,
  running: boolean,
): Task {
  if (!task.sessionId) return task;
  if (!session)
    return {
      ...task,
      attentionNeeded: true,
      lastEvent: "Linked chat is unavailable",
    };
  const latestUser = events
    ?.filter((event) => event.kind === "user-message")
    .at(-1);
  const completed =
    task.status === "complete" &&
    (!latestUser ||
      !task.completedAt ||
      latestUser.createdAt <= task.completedAt);
  const status = running
    ? "in-progress"
    : completed
      ? "complete"
      : latestUser
        ? "in-review"
        : task.status === "in-progress"
          ? "in-review"
          : task.status;
  const turnEvents = latestUser?.turnId
    ? (events?.filter((event) => event.turnId === latestUser.turnId) ?? [])
    : (events ?? []);
  const approvals = new Map<string, string>();
  for (const event of turnEvents) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (
      !payload ||
      !["gyro.mutation.v1", "gyro.provider-approval.v1"].includes(
        String(payload.schema),
      )
    )
      continue;
    const id = payload.proposalId ?? payload.approvalId ?? payload.requestId;
    if (typeof id === "string" && typeof payload.status === "string")
      approvals.set(id, payload.status);
  }
  const awaitingApproval = [...approvals.values()].some(
    (value) => value === "pending",
  );
  const changes = latestFileReviewTurn(turnEvents);
  const commands = new Map(
    turnEvents
      .map(workItemFromEvent)
      .filter((item) => item?.kind === "command" && item.category === "test")
      .map((item) => [item!.id, item!]),
  );
  const tests = [...commands.values()];
  const failed = tests.some((item) => item?.status === "failed");
  return {
    ...task,
    title: session.title,
    workspacePath: session.workspacePath,
    repo:
      session.workspacePath.split("/").filter(Boolean).at(-1) ?? "No project",
    agent:
      session.providerLabel ?? session.providerId ?? "Provider not selected",
    branch: session.branch ?? "",
    status,
    attentionNeeded: awaitingApproval || failed || status === "in-review",
    lastEvent: awaitingApproval
      ? "Waiting for edit approval in chat"
      : running
        ? "Running in chat"
        : status === "complete"
          ? "Marked complete"
          : latestUser
            ? "Ready to review in chat"
            : "Prompt saved · not started",
    diffStatus: changes
      ? `${changes.files.length} files reported changed`
      : "No changes reported",
    testStatus: !tests.length
      ? "No tests reported"
      : failed
        ? "Test command failed"
        : tests.some((item) => item?.status === "running")
          ? "Test command running"
          : "Test commands completed",
  };
}
