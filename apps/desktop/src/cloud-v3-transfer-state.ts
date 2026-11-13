export type PendingSave = {
  requestId: string;
  kind: string;
  label: string;
  prepared?: { size?: number };
  uploadId?: string | null;
  localRunning: boolean;
  cancelRequested: boolean;
  cloudStatus?: string | null;
};
export function saveKind(kind: string) {
  return kind === "project"
    ? "Project"
    : kind === "chat"
      ? "Chat backup"
      : kind === "report"
        ? "Check report"
        : "Agent handoff";
}
export function saveSize(value?: number) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    return "Size unavailable";
  const n = Number(value),
    unit = n < 1e6 ? "KB" : n < 1e9 ? "MB" : "GB",
    scale = n < 1e6 ? 1e3 : n < 1e9 ? 1e6 : 1e9;
  return `${(n / scale).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}
export function completedSave(p: PendingSave, outcome?: string) {
  return !p.localRunning && !p.cancelRequested &&
    (["committed", "conflict"].includes(outcome || "") ||
     ["committed", "conflict"].includes(p.cloudStatus || ""));
}
/** A prepared local copy is not proof of Cloud admission or completion. */
export function savePresentation(
  p: PendingSave,
  running: boolean,
  outcome?: string,
) {
  const noun =
    p.kind === "project"
      ? "project"
      : p.kind === "chat"
        ? "chat"
        : p.kind === "report"
          ? "report"
          : "handoff";
  if (p.cancelRequested)
    return {
      status: "Removal pending",
      action: "Removal pending",
      disabled: true,
      restart: false,
      description: "Removal has not finished. Use More actions to try again.",
    };
  if (p.localRunning || running)
    return {
      status: "Saving…",
      action: "Saving…",
      disabled: true,
      restart: false,
      description:
        "Gyro is checking or transferring this save. Closing this window does not stop it.",
    };
  const cachedCompletion = completedSave(p) && !["committed", "conflict"].includes(outcome || "");
  outcome = completedSave(p) ? p.cloudStatus || outcome : outcome || p.cloudStatus || undefined;
  if (cachedCompletion)
    return { status: "Upload completed", action: "Check status", disabled: false, restart: false,
      description: "This upload finished. Its prepared copy is retained on this Mac. Open saved versions to check current Cloud availability." };
  if (outcome === "verifying")
    return {
      status: "Checking save",
      action: "Check status",
      disabled: false,
      restart: false,
      description:
        "Cloud is verifying this save before it appears in saved versions.",
    };
  if (outcome === "committed" || outcome === "conflict")
    return {
      status:
        outcome === "conflict"
          ? "Saved as a conflict version"
          : "Saved to Cloud",
      action: "Check status",
      disabled: false,
      restart: false,
      description:
        "This version is saved. You can remove the prepared copy without deleting the Cloud version.",
    };
  if (outcome === "paused")
    return {
      status: "Paused",
      action: "Try again",
      disabled: false,
      restart: true,
      description:
        "The save did not finish. Try again, or restart an expired upload from More actions.",
    };
  if (p.uploadId || outcome)
    return {
      status: "Needs checking",
      action: "Resume save",
      disabled: false,
      restart: true,
      description:
        "Your reviewed copy is still on this Mac. Gyro checks its Cloud status before continuing.",
    };
  return {
    status: "Ready to upload",
    action: `Upload ${noun}`,
    disabled: false,
    restart: true,
    description: "Your reviewed copy is prepared on this Mac.",
  };
}
