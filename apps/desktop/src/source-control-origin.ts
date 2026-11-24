import {
  changeSummaryLine,
  diffHunks,
  latestFileReviewTurn,
  type Session,
  type SessionEvent,
} from "@gyro-dev/ui";
import {
  recordFromUnknown,
  stringFromRecord,
  turnIdFromSessionEvent,
} from "./session-context-events.ts";
import { normalizeProjectPath } from "./session-listing.ts";

export type OriginHunk = {
  index: number;
  header: string;
  lines: string[];
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  additions: number;
  deletions: number;
};

export type OriginSource = {
  sessionId: string;
  turnId: string;
  title: string;
  model?: string;
  date: string;
  request?: string;
  fileNote?: string;
  checks: { label: string; status: string }[];
  hunk: OriginHunk;
};

export type OriginHistory = {
  chats: { session: Session; events: SessionEvent[] }[];
  limited: boolean;
  failed: boolean;
  testResults?: Readonly<Record<string, { sessionId: string; data: unknown }>>;
};

export function originHunks(diff: string): OriginHunk[] {
  // The review can return a two-path rename or a clipped patch. Neither is
  // sufficient for a same-file match. Preserve line endings when matching.
  if (diff.includes("\r") || (diff.match(/^diff --git /gm)?.length ?? 0) > 1)
    return [];
  return diffHunks(diff).flatMap(({ header, lines }, index) => {
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(
      header,
    );
    if (!range) return [];
    const body = lines.map(({ text }) => text);
    const context = body.filter((line) => line.startsWith(" ")).length;
    const additions = body.filter((line) => line.startsWith("+")).length;
    const deletions = body.filter((line) => line.startsWith("-")).length;
    const oldCount = Number(range[2] ?? 1);
    const newCount = Number(range[4] ?? 1);
    if (
      (!additions && !deletions) ||
      oldCount !== context + deletions ||
      newCount !== context + additions ||
      body.some((line) => !/^[ +\-]|^\\ No newline at end of file$/.test(line))
    )
      return [];
    return [
      {
        index,
        header,
        lines: body,
        oldCount,
        newCount,
        additions,
        deletions,
        oldStart: Number(range[1]),
        newStart: Number(range[3]),
      },
    ];
  });
}

export function originHunkLabel(hunk: OriginHunk) {
  if (!hunk.newCount) {
    const end = hunk.oldStart + hunk.oldCount - 1;
    return hunk.oldStart === end
      ? `Original line ${end}`
      : `Original lines ${hunk.oldStart}–${end}`;
  }
  const end = hunk.newStart + hunk.newCount - 1;
  return hunk.newStart === end
    ? `Line ${end}`
    : `Lines ${hunk.newStart}–${end}`;
}

export function hunksInDisplayedContent(
  hunks: OriginHunk[],
  original: string,
  modified: string,
) {
  if (!hunks.length || (!original && !modified)) return hunks; // For a plain fallback the patch is the displayed content.
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  return hunks.filter((hunk) => {
    let before = hunk.oldStart - 1;
    let after = hunk.newStart - 1;
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === "\\") continue;
      const text = line.slice(1);
      if (marker !== "+" && oldLines[before++] !== text) return false;
      if (marker !== "-" && newLines[after++] !== text) return false;
    }
    return true;
  });
}

export function sessionHasOriginRoot(session: Session, root: string) {
  return [
    session.workspacePath,
    ...(session.workspaceIdentity?.roots ?? []).map(({ path }) => path),
  ].some((path) => normalizeProjectPath(path) === normalizeProjectPath(root));
}

function receiptIsInRoot(
  session: Session,
  payload: Record<string, unknown>,
  root: string,
) {
  const receiptRoot =
    stringFromRecord(payload, "workspacePath") ??
    stringFromRecord(payload, "cwd");
  if (receiptRoot)
    return normalizeProjectPath(receiptRoot) === normalizeProjectPath(root);
  // Some provider receipts omit the root. Only a single-root chat can supply it.
  return (
    (session.workspaceIdentity?.roots.length ?? 1) === 1 &&
    normalizeProjectPath(session.workspacePath) === normalizeProjectPath(root)
  );
}

function beforeLines(hunk: OriginHunk) {
  return hunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .join("\n");
}

function captureChecks(
  events: SessionEvent[],
  testResults: OriginHistory["testResults"],
): OriginSource["checks"] {
  const calls = new Map<string, OriginSource["checks"][number]>();
  for (const event of events) {
    const payload = recordFromUnknown(event.payload);
    if (
      payload?.schema !== "gyro.capability.v1" ||
      payload.capabilityId !== "workspace.run_test"
    )
      continue;
    const callId = stringFromRecord(payload, "callId");
    const label = stringFromRecord(
      recordFromUnknown(payload.resource),
      "label",
    );
    if (!callId) continue;
    // A completed tool call means it returned. Only the result has an exit code.
    if (payload.status === "completed" && label) {
      const result = testResults?.[callId];
      const data =
        result?.sessionId === event.sessionId
          ? recordFromUnknown(result.data)
          : undefined;
      const status =
        data?.kind === "test" && typeof data.exitCode === "number"
          ? data.exitCode === 0
            ? "Passed"
            : "Failed"
          : "Result not retained";
      calls.set(callId, { label, status });
    }
    if (payload.status === "failed")
      calls.set(callId, {
        label: label ?? "Test task",
        status: "Could not run",
      });
  }
  return [...calls.values()];
}

export function findChangeOrigin(
  history: OriginHistory,
  root: string,
  path: string,
  current: OriginHunk,
) {
  const exact = new Map<string, OriginSource>();
  const earlier = new Map<string, OriginSource>();
  for (const { session, events } of history.chats) {
    if (!sessionHasOriginRoot(session, root)) continue;
    const owned = events.filter((event) => event.sessionId === session.id);
    const undone = new Set(
      owned.flatMap((event) => {
        const payload = recordFromUnknown(event.payload);
        return payload?.kind === "recorded-edit-undone" &&
          typeof payload.undoId === "string"
          ? [payload.undoId]
          : [];
      }),
    );
    for (const event of owned) {
      const payload = recordFromUnknown(event.payload);
      const turnId = event.turnId;
      if (
        !turnId ||
        !payload ||
        payload.status !== "applied" ||
        (payload.schema !== "gyro.mutation.v1" &&
          payload.schema !== "gyro.provider-approval.v1") ||
        !Array.isArray(payload.fileChanges) ||
        !receiptIsInRoot(session, payload, root)
      )
        continue;
      const editId =
        stringFromRecord(payload, "undoId") ??
        stringFromRecord(payload, "proposalId") ??
        stringFromRecord(payload, "approvalId");
      if (editId && undone.has(editId)) continue;
      for (const change of payload.fileChanges) {
        const entry = recordFromUnknown(change);
        if (entry?.path !== path || typeof entry.patch !== "string") continue;
        for (const hunk of originHunks(entry.patch)) {
          if (
            hunk.oldStart !== current.oldStart ||
            hunk.oldCount !== current.oldCount ||
            beforeLines(hunk) !== beforeLines(current)
          )
            continue;
          const matches =
            hunk.newStart === current.newStart &&
            hunk.newCount === current.newCount &&
            hunk.lines.join("\n") === current.lines.join("\n");
          // Pure insertions have no removed content to anchor an earlier edit.
          if (!matches && (!hunk.deletions || !current.deletions)) continue;
          const target = matches ? exact : earlier;
          const key = `${session.id}:${turnId}`;
          if (target.has(key)) continue;
          const turn = owned.filter(
            (item) => (turnIdFromSessionEvent(item) ?? item.id) === turnId,
          );
          const reply = turn.findLast(
            (item) => item.kind === "assistant-message",
          );
          const replyPayload = recordFromUnknown(reply?.payload);
          const reviewedFile = latestFileReviewTurn(turn)?.files.find(
            (file) => file.path === path,
          );
          target.set(key, {
            sessionId: session.id,
            turnId,
            title: session.title,
            model:
              stringFromRecord(replyPayload, "modelLabel") ??
              stringFromRecord(replyPayload, "modelId") ??
              stringFromRecord(payload, "providerLabel"),
            date: event.createdAt,
            request: turn.find((item) => item.kind === "user-message")?.message,
            fileNote: reviewedFile && changeSummaryLine(reviewedFile)?.text,
            checks: captureChecks(turn, history.testResults),
            hunk,
          });
        }
      }
    }
  }
  const matches = exact.size ? exact : earlier;
  if (matches.size > 1) return { kind: "ambiguous" } as const;
  const source = matches.values().next().value;
  if (!source) return { kind: "missing" } as const;
  return { kind: exact.size ? "matched" : "earlier", source } as const;
}
