import type { UpdateState } from "./types";

export function updateProgressPercent(downloaded: number, total?: number) {
  if (!total || total <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}

export function updateSidebarLabel(state: UpdateState) {
  if (state.status === "downloading") {
    return state.progressPercent === undefined
      ? "Downloading update"
      : `Downloading ${state.progressPercent}%`;
  }
  if (state.status === "ready") {
    return "Restart to update";
  }
  if (state.status === "installing") {
    return "Installing update";
  }
  if (state.status === "failed") {
    return "Try update again";
  }
  return "Update Gyro";
}

export function updatePrimaryActionLabel(state: UpdateState) {
  if (state.status === "available" && state.nextVersion) {
    return `Update to ${state.nextVersion}`;
  }
  return updateSidebarLabel(state);
}

export function shouldShowSidebarUpdate(state: UpdateState) {
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "ready" ||
    state.status === "installing" ||
    (state.status === "failed" && !state.silentFailure)
  );
}
