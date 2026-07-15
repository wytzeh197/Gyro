const REPOSITORY = "https://github.com/wytzeh197/Gyro";
export const RELEASE_API =
  "https://api.github.com/repos/wytzeh197/Gyro/releases/latest";

const FALLBACK_RELEASE = `${REPOSITORY}/releases/latest`;
const RELEASE_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_ARCHITECTURE = "apple-silicon";
const ARCHITECTURES = ["apple-silicon", "intel"];

let selectedArchitecture = DEFAULT_ARCHITECTURE;
let recommendedArchitecture = null;
let releaseAssets = {
  appleSilicon: null,
  intel: null,
  checksums: null,
};
let selectorIsBound = false;
let copyFeedbackTimer = null;

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

export function isOutdatedReleaseLine(value) {
  const text = cleanMarkdownText(value);
  return /\blaunch\s+film\b/i.test(text) || /\bprivate\s+preview\b/i.test(text);
}

export function parseReleaseNoteBlocks(markdown) {
  const blocks = [];
  let paragraphLines = [];
  let listItems = [];
  let codeLines = null;

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  const flushCode = () => {
    if (codeLines === null) return;
    blocks.push({ type: "code", text: codeLines.join("\n") });
    codeLines = null;
  };

  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (/^```/.test(line)) {
      if (codeLines === null) {
        flushParagraph();
        flushList();
        codeLines = [];
      } else {
        flushCode();
      }
      continue;
    }

    if (codeLines !== null) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: heading[1] });
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem[1]);
      continue;
    }

    if (listItems.length) {
      listItems[listItems.length - 1] += ` ${line}`;
      continue;
    }

    paragraphLines.push(line.replace(/^>\s?/, ""));
  }

  flushParagraph();
  flushList();
  flushCode();
  return blocks;
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

  for (const block of parseReleaseNoteBlocks(markdown)) {
    if (block.type === "list") {
      const visibleItems = block.items.filter(
        (item) => !isOutdatedReleaseLine(item),
      );
      if (!visibleItems.length) continue;
      const list = document.createElement("ul");
      for (const value of visibleItems) {
        const item = document.createElement("li");
        item.textContent = cleanMarkdownText(value);
        list.append(item);
      }
      target.append(list);
      continue;
    }

    if (isOutdatedReleaseLine(block.text)) continue;

    if (block.type === "heading") {
      if (!target.childElementCount) continue;
      const heading = document.createElement("h3");
      heading.textContent = cleanMarkdownText(block.text);
      target.append(heading);
      continue;
    }

    if (block.type === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      target.append(pre);
      continue;
    }

    const paragraph = document.createElement("p");
    paragraph.textContent = cleanMarkdownText(block.text);
    target.append(paragraph);
  }

  if (!target.childElementCount) {
    const empty = document.createElement("p");
    empty.textContent = "Read the full release notes on GitHub.";
    target.append(empty);
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

function architectureLabel(kind) {
  return kind === "intel" ? "Intel" : "Apple Silicon";
}

function assetForArchitecture(kind) {
  return kind === "intel" ? releaseAssets.intel : releaseAssets.appleSilicon;
}

function resetCopyFeedback() {
  if (copyFeedbackTimer) {
    window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }

  const button = element("copy-checksum");
  if (!button) return;
  if (button.dataset.defaultLabel) {
    button.textContent = button.dataset.defaultLabel;
  }
  delete button.dataset.copyState;
  const checksum = button.dataset.checksum;
  const label = architectureLabel(selectedArchitecture);
  button.setAttribute(
    "aria-label",
    checksum
      ? `Copy the SHA-256 checksum for Gyro on ${label}`
      : `SHA-256 checksum unavailable for Gyro on ${label}`,
  );
}

function configureSelectedDownload() {
  const asset = assetForArchitecture(selectedArchitecture);
  const label = architectureLabel(selectedArchitecture);
  const link = element("download-selected");
  const meta = element("selected-asset-meta");
  const digest = element("selected-digest");
  const command = element("checksum-command");
  const copyButton = element("copy-checksum");
  const checksum = sha256FromDigest(asset?.digest);

  resetCopyFeedback();
  setText(
    "download-selected-label",
    asset?.browser_download_url ? "Download DMG" : "Open GitHub Releases",
  );

  if (link) {
    link.href = asset?.browser_download_url ?? FALLBACK_RELEASE;
    link.setAttribute(
      "aria-label",
      asset?.browser_download_url
        ? `Download Gyro for ${label}, ${formatBytes(asset.size)}`
        : `Find the Gyro ${label} DMG on GitHub Releases`,
    );
  }

  if (meta) {
    meta.textContent = asset?.name
      ? `${asset.name} · ${formatBytes(asset.size)}`
      : `${label} DMG unavailable · Open GitHub Releases`;
  }

  if (digest) {
    digest.textContent = checksum ?? "See SHA256SUMS on GitHub Releases";
    digest.title = checksum
      ? `SHA-256: ${checksum}`
      : "Digest unavailable from the GitHub API";
  }

  if (command) {
    command.textContent = asset?.name
      ? `shasum -a 256 "${asset.name}"`
      : 'shasum -a 256 "<downloaded-dmg>"';
  }

  if (copyButton) {
    if (!copyButton.dataset.defaultLabel) {
      copyButton.dataset.defaultLabel = copyButton.textContent.trim() || "Copy";
    }
    copyButton.disabled = !checksum;
    copyButton.dataset.checksum = checksum ?? "";
    copyButton.setAttribute(
      "aria-label",
      checksum
        ? `Copy the SHA-256 checksum for Gyro on ${label}`
        : `SHA-256 checksum unavailable for Gyro on ${label}`,
    );
    copyButton.title = checksum ? "Copy SHA-256" : "Checksum unavailable";
  }
}

function markRecommendedArchitecture(kind) {
  recommendedArchitecture = kind;
  for (const architecture of ARCHITECTURES) {
    const input = element(`architecture-${architecture}`);
    if (!input) continue;
    const isRecommended = architecture === recommendedArchitecture;
    input.toggleAttribute("data-recommended", isRecommended);
    input.closest("label")?.classList.toggle("is-recommended", isRecommended);
  }
}

function chooseArchitecture(kind) {
  if (!ARCHITECTURES.includes(kind)) return;
  selectedArchitecture = kind;
  for (const architecture of ARCHITECTURES) {
    const input = element(`architecture-${architecture}`);
    if (input) input.checked = architecture === selectedArchitecture;
  }
  configureSelectedDownload();
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.append(temporary);
  temporary.select();
  const copied = document.execCommand?.("copy");
  temporary.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

async function copySelectedChecksum() {
  const button = element("copy-checksum");
  const checksum = button?.dataset.checksum;
  if (!button || !checksum) return;

  try {
    await writeClipboard(checksum);
    button.textContent = "Copied";
    button.dataset.copyState = "copied";
    button.setAttribute("aria-label", "SHA-256 checksum copied");
  } catch {
    button.textContent = "Copy failed";
    button.dataset.copyState = "failed";
    button.setAttribute(
      "aria-label",
      "Checksum copy failed. Select and copy the checksum manually.",
    );
  }

  copyFeedbackTimer = window.setTimeout(resetCopyFeedback, 1800);
}

function bindArchitectureSelector() {
  if (selectorIsBound) return;
  selectorIsBound = true;

  for (const architecture of ARCHITECTURES) {
    const input = element(`architecture-${architecture}`);
    input?.addEventListener("change", () => {
      if (input.checked) chooseArchitecture(architecture);
    });
  }

  element("copy-checksum")?.addEventListener("click", () => {
    void copySelectedChecksum();
  });

  chooseArchitecture(DEFAULT_ARCHITECTURE);
}

function configureRelease(release) {
  const assets = selectReleaseAssets(release);
  releaseAssets = assets;
  const releasePage = release.html_url || FALLBACK_RELEASE;
  const version = release.tag_name.replace(/^v/, "");
  setText("release-version", `Gyro ${version} · Public alpha`);
  setText("release-date", formatPublishedDate(release.published_at));
  const dateDivider = element("release-date-divider");
  if (dateDivider) dateDivider.hidden = false;
  configureSelectedDownload();
  renderReleaseNotes(release.body);

  const checksumLink = element("checksums-link");
  if (checksumLink) {
    checksumLink.href = assets.checksums?.browser_download_url ?? releasePage;
  }

  if (!assets.appleSilicon || !assets.intel) {
    const fallback = element("release-fallback");
    if (fallback) {
      fallback.hidden = false;
    }
  }
}

function showReleaseFallback() {
  setText("release-version", "Latest public alpha on GitHub");
  setText("release-date", "");
  const dateDivider = element("release-date-divider");
  if (dateDivider) dateDivider.hidden = true;
  releaseAssets = {
    appleSilicon: null,
    intel: null,
    checksums: null,
  };
  configureSelectedDownload();
  const checksumLink = element("checksums-link");
  if (checksumLink) checksumLink.href = FALLBACK_RELEASE;
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
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    RELEASE_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    if (!isUsableRelease(release))
      throw new Error("Malformed release response");
    configureRelease(release);
  } catch (error) {
    console.warn("Unable to load the latest Gyro release", error);
    showReleaseFallback();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function suggestArchitecture() {
  const status = element("architecture-status");
  const userAgentData = navigator.userAgentData;
  if (!userAgentData?.getHighEntropyValues) {
    if (status) {
      status.textContent =
        "Automatic processor detection is not reliably available in this browser. Choose your Mac processor.";
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
          "We could not reliably detect this Mac’s processor. Choose your Mac processor.";
      }
      return;
    }
    markRecommendedArchitecture(architecture);
    chooseArchitecture(architecture);
    if (status) {
      status.textContent = `Recommended for this Mac: ${
        architecture === "apple-silicon" ? "Apple Silicon" : "Intel"
      }. Confirm before downloading.`;
    }
  } catch {
    if (status) {
      status.textContent =
        "We could not reliably detect this Mac’s processor. Choose your Mac processor.";
    }
  }
}

export function startPage() {
  document.documentElement.classList.add("js");
  bindArchitectureSelector();
  void Promise.all([loadRelease(), suggestArchitecture()]);
}

if (typeof document !== "undefined") {
  startPage();
}
