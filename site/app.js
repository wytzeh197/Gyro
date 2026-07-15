const REPOSITORY = "https://github.com/wytzeh197/Gyro";
export const RELEASE_API =
  "https://api.github.com/repos/wytzeh197/Gyro/releases/latest";

const FALLBACK_RELEASE = `${REPOSITORY}/releases/latest`;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[index]}`;
}

export function sha256FromDigest(digest) {
  if (typeof digest !== "string") return null;
  const match = digest.match(/^sha256:([a-f\d]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function selectReleaseAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const isDmg = (asset) => asset?.name?.toLowerCase().endsWith(".dmg");
  const appleSilicon = assets.find(
    (asset) =>
      isDmg(asset) &&
      /(?:^|[_-])(?:aarch64|arm64)(?:[_.-]|$)/i.test(asset.name),
  );
  const intel = assets.find(
    (asset) =>
      isDmg(asset) && /(?:^|[_-])(?:x64|x86_64)(?:[_.-]|$)/i.test(asset.name),
  );
  const checksums = assets.find(
    (asset) => asset?.name?.toUpperCase() === "SHA256SUMS",
  );
  return { appleSilicon, intel, checksums };
}

export function architectureFromHints(hints) {
  if (!hints || !/^mac(?:os)?$/i.test(String(hints.platform ?? ""))) {
    return null;
  }
  const architecture = String(hints.architecture ?? "").toLowerCase();
  if (/^(arm|arm64|aarch64)$/.test(architecture)) return "apple-silicon";
  if (/^(x86|x86_64|x64|amd64)$/.test(architecture)) return "intel";
  return null;
}

export function isUsableRelease(release) {
  return Boolean(
    release &&
    typeof release.tag_name === "string" &&
    typeof release.html_url === "string" &&
    Array.isArray(release.assets),
  );
}

function element(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const target = element(id);
  if (target) target.textContent = value;
}

function cleanMarkdownText(value) {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function renderReleaseNotes(markdown) {
  const target = element("release-notes");
  if (!target) return;
  target.replaceChildren();
  target.classList.add("release-notes-content");

  if (!markdown?.trim()) {
    const empty = document.createElement("p");
    empty.textContent = "No release notes were published for this alpha.";
    target.append(empty);
    return;
  }

  let list = null;
  const appendParagraph = (text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = cleanMarkdownText(text);
    target.append(paragraph);
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      list = null;
      continue;
    }
    if (/^#\s/.test(line)) continue;
    if (/^#{2,4}\s/.test(line)) {
      list = null;
      const heading = document.createElement("h3");
      heading.textContent = cleanMarkdownText(line.replace(/^#{2,4}\s+/, ""));
      target.append(heading);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!list) {
        list = document.createElement("ul");
        target.append(list);
      }
      const item = document.createElement("li");
      item.textContent = cleanMarkdownText(line.replace(/^[-*]\s+/, ""));
      list.append(item);
      continue;
    }
    list = null;
    appendParagraph(line.replace(/^>\s?/, ""));
  }
}

function formatPublishedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function configureDownload(kind, asset) {
  const isAppleSilicon = kind === "apple-silicon";
  const link = element(`${kind}-download`);
  const meta = element(`${kind}-meta`);
  const digest = element(`${kind}-digest`);
  if (!link || !meta || !digest) return;

  if (!asset?.browser_download_url) {
    link.href = FALLBACK_RELEASE;
    link.textContent = "Find on GitHub ↗";
    meta.textContent = "Direct DMG unavailable · Open release";
    digest.textContent = "See SHA256SUMS on GitHub Releases";
    return;
  }

  link.href = asset.browser_download_url;
  link.setAttribute(
    "aria-label",
    `Download Gyro for ${isAppleSilicon ? "Apple Silicon" : "Intel"}, ${formatBytes(asset.size)}`,
  );
  meta.textContent = `macOS 14+ · DMG · ${formatBytes(asset.size)}`;
  const checksum = sha256FromDigest(asset.digest);
  digest.textContent = checksum ?? "See SHA256SUMS for this asset";
  digest.title = checksum
    ? `SHA-256: ${checksum}`
    : "Digest unavailable from API";
}

function configureRelease(release) {
  const assets = selectReleaseAssets(release);
  const releasePage = release.html_url || FALLBACK_RELEASE;
  const version = release.tag_name.replace(/^v/, "");
  setText("release-version", `Gyro ${version} · Public alpha`);
  setText("release-date", formatPublishedDate(release.published_at));
  configureDownload("apple-silicon", assets.appleSilicon);
  configureDownload("intel", assets.intel);
  renderReleaseNotes(release.body);

  const checksumLink = element("checksums-link");
  if (checksumLink) {
    checksumLink.href = assets.checksums?.browser_download_url ?? releasePage;
  }

  const command = element("checksum-command");
  if (command && assets.appleSilicon?.name) {
    command.textContent = `shasum -a 256 "${assets.appleSilicon.name}"`;
  }

  if (!assets.appleSilicon || !assets.intel) {
    const fallback = element("release-fallback");
    if (fallback) {
      fallback.hidden = false;
      fallback.firstChild.textContent =
        "One of the expected direct DMGs is missing from this release. ";
    }
  }
}

function showReleaseFallback() {
  setText("release-version", "Latest public alpha on GitHub");
  setText("release-date", "");
  setText("apple-silicon-digest", "Open GitHub Releases for SHA256SUMS");
  setText("intel-digest", "Open GitHub Releases for SHA256SUMS");
  const fallback = element("release-fallback");
  if (fallback) fallback.hidden = false;
  const notes = element("release-notes");
  if (notes) {
    notes.replaceChildren();
    const copy = document.createElement("p");
    copy.append("Live notes could not be loaded. ");
    const link = document.createElement("a");
    link.href = FALLBACK_RELEASE;
    link.textContent = "Read the latest release on GitHub";
    copy.append(link, ".");
    notes.append(copy);
  }
}

async function loadRelease() {
  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    if (!isUsableRelease(release))
      throw new Error("Malformed release response");
    configureRelease(release);
  } catch (error) {
    console.warn("Unable to load the latest Gyro release", error);
    showReleaseFallback();
  }
}

async function suggestArchitecture() {
  const status = element("architecture-status");
  const userAgentData = navigator.userAgentData;
  if (!userAgentData?.getHighEntropyValues) {
    if (status) {
      status.textContent =
        "Automatic processor detection is not reliably available in this browser. Choose your Mac below.";
    }
    return;
  }

  try {
    const hints = await userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
    ]);
    const architecture = architectureFromHints({
      platform: userAgentData.platform,
      architecture: hints.architecture,
      bitness: hints.bitness,
    });
    if (!architecture) {
      if (status) {
        status.textContent =
          "We could not reliably detect this Mac’s processor. Choose your Mac below.";
      }
      return;
    }
    const card = element(`${architecture}-card`);
    if (card) card.classList.add("is-suggested");
    if (status) {
      status.textContent = `Suggested: ${
        architecture === "apple-silicon" ? "Apple Silicon" : "Intel"
      }. Confirm before downloading.`;
    }
  } catch {
    if (status) {
      status.textContent =
        "We could not reliably detect this Mac’s processor. Choose your Mac below.";
    }
  }
}

export function startPage() {
  document.documentElement.classList.add("js");
  void Promise.all([loadRelease(), suggestArchitecture()]);
}

if (typeof document !== "undefined") {
  startPage();
}
