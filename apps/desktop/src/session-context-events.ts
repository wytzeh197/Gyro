import type {
  ChatMode,
  SessionEvent,
  SessionGoal,
  SessionPlan,
  SessionPlanItem,
  SessionPlanItemStatus,
} from "@gyro-dev/ui";

export function turnIdFromSessionEvent(
  event: SessionEvent,
): string | undefined {
  if (event.turnId) {
    return event.turnId;
  }
  if (
    typeof event.payload === "object" &&
    event.payload &&
    "turnId" in event.payload &&
    typeof event.payload.turnId === "string"
  ) {
    return event.payload.turnId;
  }
  return undefined;
}

export function deriveSessionPlan(
  events: SessionEvent[],
  sessionId?: string,
): SessionPlan {
  const assistantContentByTurnId = new Map<string, string>();
  const normalTurnIds = new Set<string>();
  for (const event of events) {
    const payload = recordFromUnknown(event.payload);
    const turnId = turnIdFromSessionEvent(event);
    if (turnId && stringFromRecord(payload, "chatMode") === "normal") {
      normalTurnIds.add(turnId);
    }
  }
  for (const event of events) {
    if (event.kind !== "assistant-message" || !event.message.trim()) {
      continue;
    }
    const turnId = turnIdFromSessionEvent(event);
    if (turnId) {
      assistantContentByTurnId.set(turnId, event.message.trim());
    }
  }
  let plan: SessionPlan = {
    sessionId,
    title: "Plan",
    items: [],
  };

  for (const event of events) {
    if (event.kind !== "plan-updated") {
      continue;
    }
    const payload = recordFromUnknown(event.payload);
    const action = stringFromRecord(payload, "action") ?? "replace";
    const sourceTurnId =
      turnIdFromSessionEvent(event) ?? stringFromRecord(payload, "turnId");
    // Older ACP runs persisted execution checklists as plan replacements.
    // Do not turn their entire normal-mode response into a Plan document.
    if (
      action === "replace" &&
      sourceTurnId &&
      normalTurnIds.has(sourceTurnId) &&
      !stringFromRecord(payload, "content") &&
      !stringFromRecord(payload, "markdown")
    ) {
      continue;
    }
    if (!plan.createdAt) {
      plan = { ...plan, createdAt: event.createdAt };
    }
    const providerId = stringFromRecord(payload, "providerId");
    const title = stringFromRecord(payload, "title");
    const content =
      stringFromRecord(payload, "content") ??
      stringFromRecord(payload, "markdown") ??
      (action === "replace" && sourceTurnId
        ? assistantContentByTurnId.get(sourceTurnId)
        : undefined);
    if (title) {
      plan = { ...plan, title };
    }
    if (content) {
      plan = { ...plan, content };
    }
    if (sourceTurnId && (action === "replace" || !plan.sourceTurnId)) {
      plan = { ...plan, sourceTurnId };
    }
    if (providerId) {
      plan = { ...plan, providerId };
    }

    if (action === "clear") {
      plan = {
        ...plan,
        content: undefined,
        items: [],
        updatedAt: event.createdAt,
      };
      continue;
    }

    const payloadItems = Array.isArray(payload?.items)
      ? payload.items
      : undefined;
    if (payloadItems && (action === "add-item" || action === "append")) {
      plan = {
        ...plan,
        items: [
          ...plan.items,
          ...payloadItems.map((item, index) =>
            normalizePlanItem(item, event, plan.items.length + index),
          ),
        ],
        updatedAt: event.createdAt,
      };
      continue;
    }

    // Progress reports name only the ids that moved, so a turn that finishes
    // three steps stays one marker line and never restates the plan.
    if (payloadItems && action === "update-items") {
      const updates = new Map(
        payloadItems
          .map((item) => recordFromUnknown(item))
          .filter((record): record is Record<string, unknown> =>
            Boolean(record),
          )
          .map((record) => [stringFromRecord(record, "id"), record] as const)
          .filter(([id]) => Boolean(id)),
      );
      plan = {
        ...plan,
        items: plan.items.map((item) => {
          const update = updates.get(item.id);
          if (!update) {
            return item;
          }
          return {
            ...item,
            detail: stringFromRecord(update, "detail") ?? item.detail,
            status: normalizePlanStatus(update.status ?? item.status),
            title:
              stringFromRecord(update, "title") ??
              stringFromRecord(update, "label") ??
              item.title,
            updatedAt: event.createdAt,
          };
        }),
        updatedAt: event.createdAt,
      };
      continue;
    }

    if (action === "replace" || payloadItems) {
      plan = {
        ...plan,
        items: (payloadItems ?? []).map((item, index) =>
          normalizePlanItem(item, event, index),
        ),
        updatedAt: event.createdAt,
      };
      continue;
    }

    const payloadItem = payload?.item;
    if (!payloadItem) {
      plan = { ...plan, updatedAt: event.createdAt };
      continue;
    }

    const nextItemRecord = recordFromUnknown(payloadItem);
    const explicitTitle =
      stringFromRecord(nextItemRecord, "title") ??
      stringFromRecord(nextItemRecord, "label");
    const explicitDetail = stringFromRecord(nextItemRecord, "detail");
    const nextItem = normalizePlanItem(payloadItem, event, plan.items.length);
    if (action === "remove-item") {
      plan = {
        ...plan,
        items: plan.items.filter((item) => item.id !== nextItem.id),
        updatedAt: event.createdAt,
      };
      continue;
    }

    const existingItem = plan.items.find((item) => item.id === nextItem.id);
    const items = existingItem
      ? plan.items.map((item) =>
          item.id === nextItem.id
            ? {
                ...item,
                ...nextItem,
                createdAt: item.createdAt,
                detail: explicitDetail ?? item.detail,
                title: explicitTitle ?? item.title,
              }
            : item,
        )
      : [...plan.items, nextItem];
    plan = { ...plan, items, updatedAt: event.createdAt };
  }

  return plan;
}

export function deriveSessionGoal(
  events: SessionEvent[],
  sessionId?: string,
): SessionGoal | undefined {
  let goal: SessionGoal | undefined;
  for (const event of events) {
    if (event.kind !== "goal-updated") {
      continue;
    }
    const payload = recordFromUnknown(event.payload);
    const action = stringFromRecord(payload, "action") ?? "set";
    if (action === "clear") {
      goal = undefined;
      continue;
    }
    const text = stringFromRecord(payload, "text") ?? goal?.text;
    if (!text) {
      continue;
    }
    goal = {
      sessionId,
      text,
      status:
        stringFromRecord(payload, "status") === "complete"
          ? "complete"
          : "active",
      sourceTurnId:
        stringFromRecord(payload, "sourceTurnId") ?? goal?.sourceTurnId,
      createdAt: goal?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
    };
  }
  return goal;
}

export function deriveChatMode(events: SessionEvent[]): ChatMode {
  let mode: ChatMode = "normal";
  for (const event of events) {
    if (event.kind !== "chat-mode-changed") {
      continue;
    }
    const value = stringFromRecord(recordFromUnknown(event.payload), "mode");
    mode =
      value === "plan" ? "plan" : value === "council" ? "council" : "normal";
  }
  return mode;
}

export function chatModeEventMessage(mode: ChatMode) {
  return mode === "plan"
    ? "Plan mode enabled"
    : mode === "council"
      ? "Council mode enabled"
      : "Normal mode enabled";
}

export function createChatModeSessionEvent(
  sessionId: string,
  mode: ChatMode,
  turnId: string,
): SessionEvent {
  return {
    id: `chat-mode-${turnId}`,
    sessionId,
    turnId,
    createdAt: new Date().toISOString(),
    kind: "chat-mode-changed",
    message: chatModeEventMessage(mode),
    payload: { mode, turnId },
  };
}

export function normalizePlanItem(
  value: unknown,
  event: SessionEvent,
  index: number,
): SessionPlanItem {
  const record = recordFromUnknown(value);
  const title =
    stringFromRecord(record, "title") ??
    stringFromRecord(record, "label") ??
    `Checklist item ${index + 1}`;
  const sourceTurnId =
    stringFromRecord(record, "sourceTurnId") ??
    turnIdFromSessionEvent(event) ??
    stringFromRecord(record, "turnId");
  const id =
    stringFromRecord(record, "id") ??
    `${event.id}-${slugify(title) || `item-${index + 1}`}`;
  return {
    id,
    title,
    detail: stringFromRecord(record, "detail"),
    status: normalizePlanStatus(record?.status),
    sourceTurnId,
    providerId:
      stringFromRecord(record, "providerId") ??
      stringFromRecord(recordFromUnknown(event.payload), "providerId"),
    createdAt: stringFromRecord(record, "createdAt") ?? event.createdAt,
    updatedAt: stringFromRecord(record, "updatedAt") ?? event.createdAt,
  };
}

export function normalizePlanStatus(value: unknown): SessionPlanItemStatus {
  if (
    value === "todo" ||
    value === "in-progress" ||
    value === "complete" ||
    value === "blocked"
  ) {
    return value;
  }
  if (value === "done") {
    return "complete";
  }
  if (value === "doing" || value === "running") {
    return "in-progress";
  }
  return "todo";
}

export function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function stringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function planStatusVerb(status: SessionPlanItemStatus) {
  switch (status) {
    case "in-progress":
      return "started";
    case "complete":
      return "completed";
    case "blocked":
      return "blocked";
    case "todo":
    default:
      return "reopened";
  }
}

export function createPlanSessionEvent(
  sessionId: string,
  message: string,
  payload: Record<string, unknown>,
): SessionEvent {
  const now = new Date().toISOString();
  const turnId =
    typeof payload.turnId === "string" ? payload.turnId : undefined;
  return {
    id: `plan-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sessionId,
    turnId,
    createdAt: now,
    kind: "plan-updated",
    message,
    payload,
  };
}

export function createGoalSessionEvent(
  sessionId: string,
  message: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: `goal-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sessionId,
    createdAt: new Date().toISOString(),
    kind: "goal-updated",
    message,
    payload,
  };
}

export function createEditorSessionEvent(
  sessionId: string,
  eventKind: string,
  message: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: `editor-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sessionId,
    createdAt: new Date().toISOString(),
    kind:
      eventKind === "ai-edit-proposed" ? "file-edit-proposed" : "system-event",
    message,
    payload: {
      kind: eventKind,
      surface: "desktop-ide",
      data: payload,
    },
  };
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
