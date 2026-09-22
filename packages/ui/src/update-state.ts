import type { CliUpdateOffer, UpdateState } from "./types";

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

/** Short, human status phrase shared by the Settings hero and its badge. */
export function updateStatusLabel(state?: UpdateState) {
  switch (state?.status) {
    case "downloading":
      return state.progressPercent === undefined
        ? "Downloading…"
        : `Downloading ${state.progressPercent}%`;
    case "ready":
      return "Ready to install";
    case "installing":
      return "Installing…";
    case "available":
      return "Update available";
    case "checking":
      return "Checking…";
    case "current":
      return "Up to date";
    case "development":
      return "Updates disabled";
    case "failed":
      return "Update failed";
    default:
      return "Updater unavailable";
  }
}

/** Level shared by the card's mark and the Settings status dot, so one status
    has one colour everywhere. "info" means Gyro is working on the update or is
    waiting for you; it is drawn in the user's accent, not a second blue. */
export type UpdateStatusLevel = "good" | "info" | "critical" | "neutral";

export function updateStatusLevel(state?: UpdateState): UpdateStatusLevel {
  switch (state?.status) {
    case "current":
      return "good";
    case "available":
    case "downloading":
    case "ready":
    case "installing":
    case "checking":
      return "info";
    case "failed":
      return "critical";
    default:
      return "neutral";
  }
}

/** One sentence: what the updater is doing now, and what happens next. Returns
    undefined when the status pill and the primary action already say it — as in
    "available", where a sentence would only restate the button. */
export function updateStatusSummary(
  state?: UpdateState,
): string | undefined {
  switch (state?.status) {
    case "development":
      return "The updater is off in development builds. Nothing is contacted and no release is installed.";
    case "checking":
      return "Asking GitHub Releases for the newest signed Alpha build.";
    case "current":
      return "You are on the newest signed Alpha. Gyro keeps checking in the background.";
    case "available":
      // The dot reads "Update available" and the primary button already names
      // the build to fetch, so there is nothing left for a sentence to add.
      // Gyro also cannot claim a signature it has not downloaded and checked.
      return undefined;
    case "downloading":
      return "Downloading the signed archive. Gyro keeps working while it finishes.";
    case "ready":
      return "Downloaded and signature-verified. Restart Gyro to finish installing.";
    case "installing":
      return "Installing the verified build. Gyro restarts as soon as it is done.";
    case "failed":
      return (
        state.error ??
        "The last check or download did not finish. Try again, or check your connection."
      );
    default:
      return "Gyro could not reach the updater. Reopen Settings to try again.";
  }
}

/** The build the user is actually running, or undefined when Gyro cannot name
    it. "development" and "unknown" are the updater's placeholders, not
    versions, so they are never shown as one. */
export function updateInstalledVersion(
  state?: UpdateState,
): string | undefined {
  const version = state?.currentVersion?.trim();
  if (!version || version === "unknown" || version === "development") {
    return undefined;
  }
  return version;
}

/** Value for the "Latest" fact: the offered build, or "Up to date" once a
    check has confirmed there is nothing newer. Undefined means Gyro does not
    know yet, and the cell is left out rather than filled with "Unknown". */
export function updateLatestLabel(state?: UpdateState): string | undefined {
  if (state?.nextVersion) {
    return state.nextVersion;
  }
  if (state?.status === "current") {
    return "Up to date";
  }
  return undefined;
}

/** Human date for the last completed check, or undefined if there was none. */
export function formatUpdateCheckedAt(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export type UpdateFact = { label: string; value: string };

/** The facts worth showing, in the order people ask them: what am I on, what
    is offered, how big is the download, when did Gyro last look. Facts Gyro
    does not have are omitted, so the row never shows an empty or placeholder
    cell. */
export function updateFacts(state?: UpdateState): UpdateFact[] {
  if (!state) {
    return [];
  }
  const facts: UpdateFact[] = [];
  const installed = updateInstalledVersion(state);
  if (installed) {
    facts.push({ label: "Installed", value: installed });
  }
  const latest = updateLatestLabel(state);
  if (latest) {
    facts.push({ label: "Latest", value: latest });
  }
  const size = formatUpdateSize(state.totalBytes);
  if (size) {
    facts.push({
      label: state.status === "ready" ? "Downloaded" : "Download size",
      value: size,
    });
  }
  const checked = formatUpdateCheckedAt(state.lastCheckedAt);
  if (checked) {
    facts.push({ label: "Last checked", value: checked });
  }
  return facts;
}

/** One line for the status live region: the outcome a screen reader should hear
    after a check, a download, or a failure. Empty when nothing has changed. */
export function updateAnnouncement(state?: UpdateState): string {
  switch (state?.status) {
    case "available":
      return state.nextVersion
        ? `Update available: ${state.nextVersion}`
        : "An update is available";
    case "downloading":
      return state.progressPercent === undefined
        ? "Downloading the update"
        : `Downloading the update, ${state.progressPercent}%`;
    case "ready":
      return "Update downloaded. Restart Gyro to install it.";
    case "installing":
      return "Installing the update. Gyro restarts when it finishes.";
    case "failed":
      return "The update did not finish. Try it again from Settings.";
    case "current":
      return "Gyro is on the newest signed Alpha build.";
    default:
      return "";
  }
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

/** Primary button label for the CLI update notice. */
export function cliUpdateActionLabel(offers: CliUpdateOffer[]) {
  return offers.length > 1 ? "Update All" : "Update";
}

/** One-line copy for the center-top CLI update notice. */
export function cliUpdateNoticeMessage(offers: CliUpdateOffer[]) {
  const available = offers.filter((offer) => offer.updateAvailable);
  if (available.length === 0) {
    return "";
  }
  if (available.length === 1) {
    const offer = available[0]!;
    if (offer.currentVersion && offer.latestVersion) {
      return `${offer.displayName} ${offer.currentVersion} → ${offer.latestVersion} is available`;
    }
    return `${offer.displayName} update is available`;
  }
  if (available.length === 2) {
    return `Updates available for ${available[0]!.displayName} and ${available[1]!.displayName}`;
  }
  const head = available
    .slice(0, -1)
    .map((offer) => offer.displayName)
    .join(", ");
  const tail = available[available.length - 1]!.displayName;
  return `Updates available for ${head}, and ${tail}`;
}

/** Stable key so dismissing one set of versions does not hide a newer set. */
export function cliUpdateDismissKey(offers: CliUpdateOffer[]) {
  return offers
    .filter((offer) => offer.updateAvailable)
    .map(
      (offer) =>
        `${offer.providerId}:${offer.latestVersion ?? offer.currentVersion ?? "latest"}`,
    )
    .sort()
    .join("|");
}
