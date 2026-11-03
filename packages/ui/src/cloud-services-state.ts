export type CloudPlan = "lite" | "plus" | "premium";
export type CloudCapability = { allowed: boolean; reason: string };
export const CLOUD_TASKS = [
  { id: "memory-update", label: "Memory draft", premium: false },
  { id: "check-plan", label: "Check planning", premium: false },
  { id: "failure-explanation", label: "Failure explanation", premium: false },
  { id: "test-suggestions", label: "Suggested tests", premium: true },
  { id: "change-review", label: "Review selected changes", premium: true },
  { id: "check-comparison", label: "Compare Check results", premium: true },
] as const;

export function managedTaskAvailability(
  plan: CloudPlan | undefined,
  task: string,
  capability?: CloudCapability,
  accessState?: string,
) {
  const definition = CLOUD_TASKS.find((value) => value.id === task);
  if (!definition)
    return { allowed: false, reason: "Choose a supported task." };
  if (plan !== "plus" && plan !== "premium")
    return {
      allowed: false,
      reason: "An active Plus or Premium plan is required.",
    };
  if (definition.premium && plan !== "premium")
    return { allowed: false, reason: "This task is included with Premium." };
  if (accessState === "exhausted")
    return {
      allowed: false,
      reason:
        "Your included managed allowance is used. Saved results and source review remain available.",
    };
  if (accessState !== "active" && accessState !== "cancellation-scheduled")
    return {
      allowed: false,
      reason:
        accessState === "offline"
          ? "Cloud status is offline. Refresh to verify managed assistance before submitting."
          : "Refresh Cloud status to verify active access before submitting.",
    };
  if (!capability?.allowed)
    return { allowed: false, reason: managedCapabilityReason(capability) };
  return { allowed: true, reason: "Included with your current plan." };
}

export function managedCapabilityReason(capability?: CloudCapability) {
  if (!capability) return "Refresh Cloud status to verify managed assistance.";
  if (capability.allowed) return "Managed assistance is available.";
  if (capability.reason === "exhausted")
    return "Your included managed allowance is used. Saved results and source review remain available.";
  return (
    capability.reason.replace(/[_-]/g, " ").slice(0, 500) ||
    "Managed assistance is unavailable for this account."
  );
}

/** The service's 8k/32k pessimistic input bound includes serialized framing.
 * Reserve 4,096 for that framing (current worst task+repair is 3,675), then
 * count twice-serialized UTF-8 context (the context JSON is inside a request
 * text field). This is a conservative client guard; the
 * service still validates current policy and allowance. No text is truncated.
 */
export function contextReview(context: string, plan?: CloudPlan) {
  const inputBound = plan === "premium" ? 32_000 : plan === "plus" ? 8_000 : 0;
  const textBytes = new TextEncoder().encode(context).byteLength;
  const escapedBytes =
    new TextEncoder().encode(JSON.stringify(JSON.stringify(context)))
      .byteLength - 6;
  const budget = Math.max(0, inputBound - 4_096);
  return {
    textBytes,
    escapedBytes,
    budget,
    allowed: !!context.trim() && inputBound > 0 && escapedBytes <= budget,
    remaining: Math.max(0, budget - escapedBytes),
  };
}

export function reportLinkState(
  share: Record<string, unknown>,
  accessState?: string,
  now = Date.now(),
) {
  if (share.revokedAt) return { label: "Revoked", revocable: false };
  const expiresAt = Date.parse(String(share.expiresAt ?? ""));
  if (!Number.isFinite(expiresAt))
    return { label: "Status unavailable", revocable: true };
  if (expiresAt <= now) return { label: "Expired", revocable: false };
  if (share.paused === true)
    return { label: "Paused by plan limit", revocable: true };
  if (
    [
      "expired",
      "disputed",
      "payment-problem",
      "no-subscription",
      "signed-out",
    ].includes(accessState ?? "")
  )
    return {
      label: "Paused while Cloud access is unavailable",
      revocable: true,
    };
  if (
    !["active", "exhausted", "cancellation-scheduled"].includes(
      accessState ?? "",
    )
  )
    return { label: "Status unverified", revocable: true };
  return { label: "Active", revocable: true };
}

export function memoryDraftState(proposal: Record<string, unknown>) {
  if (proposal.status === "proposal")
    return {
      label: "Memory draft ready for review",
      readable: true,
      description:
        "Review the proposed text and its exact source revisions before accepting.",
    };
  if (proposal.status === "conflict")
    return {
      label: "Memory changed while this draft was prepared",
      readable: false,
      description:
        "Your saved edits are preserved. Reject this conflict, refresh the saved memory and request a new draft.",
    };
  if (proposal.status === "prepared")
    return {
      label: "Memory draft is processing",
      readable: false,
      description:
        "A readable proposal is not available yet. Refresh drafts or check the existing request; do not submit it again.",
    };
  return {
    label: "Memory draft status unavailable",
    readable: false,
    description: "Refresh drafts before reviewing this extraction.",
  };
}

export type MessageRange = {
  startMessage: number;
  startOffset: number;
  endMessage: number;
  endOffset: number;
};
export type CloudSourceReference = {
  objectId: string;
  revisionId: string;
  sha256?: string;
  messageRange?: MessageRange;
  sourceFormat?: string;
  rescan?: boolean;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cloudDeviceId(device: Record<string, unknown>) {
  const id = device.id ?? device.deviceId;
  return typeof id === "string" && uuid.test(id) ? id : null;
}
export function cloudSourceReference(
  value: unknown,
): CloudSourceReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    !uuid.test(String(source.objectId)) ||
    !uuid.test(String(source.revisionId))
  )
    return null;
  const result: CloudSourceReference = {
    objectId: String(source.objectId),
    revisionId: String(source.revisionId),
  };
  if (source.sha256 !== undefined) {
    if (
      typeof source.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(source.sha256)
    )
      return null;
    result.sha256 = source.sha256;
  }
  if (typeof source.sourceFormat === "string")
    result.sourceFormat = source.sourceFormat.slice(0, 80);
  if (source.rescan === true) result.rescan = true;
  const range = source.messageRange as MessageRange | undefined;
  if (source.messageRange !== undefined) {
    if (
      !range ||
      ![
        range.startMessage,
        range.startOffset,
        range.endMessage,
        range.endOffset,
      ].every((x) => Number.isSafeInteger(x) && x >= 0) ||
      !(
        range.endMessage > range.startMessage ||
        (range.endMessage === range.startMessage &&
          range.endOffset > range.startOffset)
      )
    )
      return null;
    result.messageRange = {
      startMessage: range.startMessage,
      startOffset: range.startOffset,
      endMessage: range.endMessage,
      endOffset: range.endOffset,
    };
  }
  return result;
}

export function sourceRangeLabel(range?: MessageRange) {
  if (!range) return "Complete retained source revision";
  const start = range.startMessage + 1;
  const end = range.endOffset === 0 ? range.endMessage : range.endMessage + 1;
  if (start === end)
    return `Message ${start}${range.startOffset || range.endOffset ? ` · text positions ${range.startOffset + 1}–${range.endOffset || "end"}` : " · complete text"}`;
  return `Messages ${start}–${end}${range.startOffset || range.endOffset ? ` · starts at text position ${range.startOffset + 1}; ${range.endOffset ? `ends at position ${range.endOffset} of message ${end}` : "ends at a message boundary"}` : " · complete text"}`;
}

export function sourceMessageExcerpt(
  messages: { role: string; text: string }[],
  range?: MessageRange,
) {
  if (!range) return messages.map((message, index) => ({ ...message, index }));
  if (
    range.startMessage >= messages.length ||
    range.endMessage > messages.length ||
    (range.endMessage === messages.length && range.endOffset !== 0) ||
    range.startOffset > messages[range.startMessage]!.text.length ||
    (range.endOffset &&
      range.endOffset > messages[range.endMessage]!.text.length)
  )
    return null;
  return messages.flatMap((message, index) => {
    if (
      index < range.startMessage ||
      index > range.endMessage ||
      (index === range.endMessage && range.endOffset === 0)
    )
      return [];
    return [
      {
        role: message.role,
        index,
        text: message.text.slice(
          index === range.startMessage ? range.startOffset : 0,
          index === range.endMessage ? range.endOffset : undefined,
        ),
      },
    ];
  });
}
