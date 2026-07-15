export const REPOSITORY = "https://github.com/wytzeh197/Gyro";
export const LATEST_RELEASE_API =
  "https://api.github.com/repos/wytzeh197/Gyro/releases/latest";
export const RELEASES_API =
  "https://api.github.com/repos/wytzeh197/Gyro/releases?per_page=30";
export const RELEASES_PAGE = `${REPOSITORY}/releases`;
export const LATEST_RELEASE_PAGE = `${RELEASES_PAGE}/latest`;

const REQUEST_TIMEOUT_MS = 8000;

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

export function cleanMarkdownText(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function isOutdatedReleaseText(value) {
  const text = cleanMarkdownText(value);
  return (
    /\blaunch\s+film\b/i.test(text) ||
    /\bprivate\s+(?:developer\s+)?preview\b/i.test(text)
  );
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
    const listItem = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem[1]);
      continue;
    }
    if (listItems.length) {
      listItems[listItems.length - 1] += ` ${line.replace(/^>\s?/, "")}`;
      continue;
    }
    paragraphLines.push(line.replace(/^>\s?/, ""));
  }

  flushParagraph();
  flushList();
  flushCode();
  return blocks;
}

export function renderReleaseNotes(target, markdown, options = {}) {
  if (!target) return;
  target.replaceChildren();
  const blocks = parseReleaseNoteBlocks(markdown);
  let headingSeen = false;

  for (const block of blocks) {
    if (block.type === "list") {
      const visibleItems = block.items.filter(
        (item) => !isOutdatedReleaseText(item),
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

    if (isOutdatedReleaseText(block.text)) continue;
    if (block.type === "heading") {
      if (options.skipFirstHeading !== false && !headingSeen) {
        headingSeen = true;
        continue;
      }
      headingSeen = true;
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
    empty.textContent = "Read the complete release notes on GitHub.";
    target.append(empty);
  }
}

export function formatPublishedDate(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: options.short ? "short" : "long",
    year: "numeric",
  }).format(date);
}

export function releaseAnchor(tag) {
  return String(tag ?? "release")
    .replace(/^v/i, "v")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isPublicAlphaRelease(release) {
  if (!isUsableRelease(release) || release.draft) return false;
  if (
    /\bprivate\s+(?:developer\s+)?preview\b/i.test(
      cleanMarkdownText(release.body),
    )
  ) {
    return false;
  }
  const match = release.tag_name.match(/^v0\.1\.0-alpha\.(\d+)(?:\.\d+)?$/i);
  return match ? Number(match[1]) >= 21 : false;
}

export async function fetchGitHubJson(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}
