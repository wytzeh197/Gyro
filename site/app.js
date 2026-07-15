import {
  LATEST_RELEASE_API,
  LATEST_RELEASE_PAGE,
  RELEASES_PAGE,
  architectureFromHints,
  fetchGitHubJson,
  formatBytes,
  formatPublishedDate,
  isUsableRelease,
  selectReleaseAssets,
  sha256FromDigest,
} from "./release-utils.js";

const DEFAULT_ARCHITECTURE = "apple-silicon";
const ARCHITECTURE_LABELS = {
  "apple-silicon": "Apple Silicon",
  intel: "Intel",
};

function find(surface, role) {
  return surface.querySelector(`[data-role="${role}"]`);
}

function selectedInput(surface) {
  return surface.querySelector('input[name="architecture"]:checked');
}

function selectedArchitecture(surface) {
  return selectedInput(surface)?.value ?? DEFAULT_ARCHITECTURE;
}

function assetForArchitecture(assets, architecture) {
  return architecture === "intel" ? assets.intel : assets.appleSilicon;
}

function setStatus(surface, text) {
  const status = find(surface, "architecture-status");
  if (status) status.textContent = text;
}

function applyArchitectureHint(surface, architecture) {
  const input = surface.querySelector(`input[value="${architecture}"]`);
  if (input) input.checked = true;
  setStatus(surface, `${ARCHITECTURE_LABELS[architecture]} selected.`);
}

function configureSelectedDownload(surface, release, assets) {
  const architecture = selectedArchitecture(surface);
  const asset = assetForArchitecture(assets, architecture);
  const label = ARCHITECTURE_LABELS[architecture];
  const link = find(surface, "download-link");
  const linkLabel = find(surface, "download-label");
  const metadata = find(surface, "asset-meta");
  const digest = find(surface, "digest");
  const copy = find(surface, "copy-checksum");

  if (!asset) {
    if (link) link.href = release?.html_url ?? LATEST_RELEASE_PAGE;
    if (linkLabel) linkLabel.textContent = `Find ${label} DMG on GitHub`;
    if (metadata)
      metadata.textContent = `${label} build unavailable in this release`;
    if (digest) digest.textContent = "Checksum unavailable";
    if (copy) copy.disabled = true;
    return;
  }

  if (link) link.href = asset.browser_download_url;
  if (linkLabel) linkLabel.textContent = "Download DMG";
  if (metadata) {
    metadata.textContent = `${label} · ${formatBytes(asset.size)}`;
  }
  const hash = sha256FromDigest(asset.digest);
  if (digest) digest.textContent = hash ?? "See SHA256SUMS on GitHub";
  if (copy) {
    copy.disabled = !hash;
    copy.dataset.hash = hash ?? "";
  }
}

function configureRelease(surface, release) {
  const assets = selectReleaseAssets(release);
  const version = find(surface, "release-version");
  const date = find(surface, "release-date");
  const releaseNotes = find(surface, "release-notes-link");
  const checksums = find(surface, "checksums-link");
  const fallback = find(surface, "release-fallback");

  if (version) version.textContent = release.tag_name.replace(/^v/, "Gyro ");
  if (date)
    date.textContent = formatPublishedDate(release.published_at, {
      short: true,
    });
  if (releaseNotes) releaseNotes.href = release.html_url;
  if (checksums) {
    checksums.href = assets.checksums?.browser_download_url ?? release.html_url;
  }
  if (fallback) fallback.hidden = true;

  surface.releaseData = { release, assets };
  configureSelectedDownload(surface, release, assets);
}

function showFallback(surface) {
  const fallback = find(surface, "release-fallback");
  if (fallback) fallback.hidden = false;
  const link = find(surface, "download-link");
  const label = find(surface, "download-label");
  const metadata = find(surface, "asset-meta");
  if (link) link.href = LATEST_RELEASE_PAGE;
  if (label) label.textContent = "Open GitHub Releases";
  if (metadata) metadata.textContent = "Choose aarch64 or x64 on GitHub";
}

async function copyChecksum(surface, button) {
  const hash = button.dataset.hash;
  if (!hash) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(hash);
    button.textContent = "Copied";
  } catch {
    const digest = find(surface, "digest");
    digest?.focus();
    button.textContent = "Select the hash";
  }
  window.setTimeout(() => {
    button.textContent = original;
  }, 1800);
}

function bindSurface(surface) {
  for (const input of surface.querySelectorAll('input[name="architecture"]')) {
    input.addEventListener("change", () => {
      const data = surface.releaseData;
      if (data) configureSelectedDownload(surface, data.release, data.assets);
      setStatus(
        surface,
        `Selected: ${ARCHITECTURE_LABELS[selectedArchitecture(surface)]}.`,
      );
    });
  }
  const copy = find(surface, "copy-checksum");
  copy?.addEventListener("click", () => copyChecksum(surface, copy));
}

async function reliableArchitectureHint() {
  const userAgentData = navigator.userAgentData;
  if (!userAgentData?.getHighEntropyValues) return null;
  try {
    const hints = await userAgentData.getHighEntropyValues([
      "architecture",
      "platform",
    ]);
    return architectureFromHints(hints);
  } catch {
    return null;
  }
}

async function startDownloadSurfaces() {
  const surfaces = [...document.querySelectorAll("[data-download-surface]")];
  if (!surfaces.length) return;

  for (const surface of surfaces) bindSurface(surface);
  const recommendation = await reliableArchitectureHint();
  if (recommendation) {
    for (const surface of surfaces)
      applyArchitectureHint(surface, recommendation);
  }

  try {
    const release = await fetchGitHubJson(LATEST_RELEASE_API);
    if (!isUsableRelease(release)) throw new Error("Invalid release response");
    for (const surface of surfaces) configureRelease(surface, release);
  } catch {
    for (const surface of surfaces) showFallback(surface);
  }
}

for (const link of document.querySelectorAll("[data-latest-release-link]")) {
  link.href = LATEST_RELEASE_PAGE;
}
for (const link of document.querySelectorAll("[data-releases-link]")) {
  link.href = RELEASES_PAGE;
}

startDownloadSurfaces();
