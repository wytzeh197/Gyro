/**
 * Browser-preview address and status copy.
 *
 * The preview rail accepts a bare host, a full URL, or a search term, and its
 * status line has to render whatever the native host reports back. Both are
 * pure string rules with no React state behind them, so they live outside the
 * workbench shell that renders them.
 */

export function normalizedPreviewUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a URL or search term");
  const isHostWithPort = /^[^/\s:]+:\d+(?:[/?#]|$)/.test(trimmed);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed) && !isHostWithPort;
  const isAddress =
    isHostWithPort ||
    /^(?:localhost|\[[\da-f:]+\]|[^\s/]+\.[^\s/]+)(?:[/?#]|$)/i.test(trimmed);
  const candidate = hasScheme
    ? trimmed
    : isAddress
      ? `http://${trimmed}`
      : `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Preview URLs must use http or https");
  }
  return url.toString();
}

function browserPreviewHostLabel(url: string) {
  try {
    const parsed = new URL(normalizedPreviewUrl(url));
    return parsed.host || parsed.hostname || "local preview";
  } catch {
    return "local preview";
  }
}

export function browserLiveStatusMessage(url: string, issueCount: number) {
  const host = browserPreviewHostLabel(url);
  if (issueCount > 0) {
    return `Live · ${issueCount} issue${issueCount === 1 ? "" : "s"} · ${host}`;
  }
  return `Live · ${host}`;
}

export function browserUnreachableMessage(detail: string) {
  const trimmed = detail.trim();
  if (!trimmed) {
    return "Unreachable";
  }
  if (/^unreachable/i.test(trimmed) || /^preview unavailable/i.test(trimmed)) {
    return trimmed.replace(/^preview unavailable:\s*/i, "Unreachable · ");
  }
  return `Unreachable · ${trimmed}`;
}
