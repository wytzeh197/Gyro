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

export function formatUpdateSize(bytes?: number) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return undefined;
  }
  const megabytes = bytes / 1_048_576;
  if (megabytes >= 1_024) {
    return `${(megabytes / 1_024).toFixed(1)} GB`;
  }
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

export function updateVersionTag(state: UpdateState) {
  const version = state.nextVersion ?? state.currentVersion;
  if (!version || version === "unknown" || version === "development") {
    return undefined;
  }
  return version.startsWith("v") ? version : `v${version}`;
}

/** Second tooltip line: how big the download is, or where it got to. */
export function updateSizeLabel(state: UpdateState) {
  const total = formatUpdateSize(state.totalBytes);
  if (state.status === "downloading") {
    const downloaded = formatUpdateSize(state.downloadedBytes) ?? "0 MB";
    return total ? `${downloaded} of ${total}` : `${downloaded} downloaded`;
  }
  if (state.status === "installing") {
    return "Installing now";
  }
  if (state.status === "ready") {
    return total ? `${total} downloaded` : "Downloaded";
  }
  if (state.status === "failed") {
    return "Update failed";
  }
  return total ? `${total} download` : "Size available at download";
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
