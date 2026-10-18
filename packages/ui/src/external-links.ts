/**
 * Reply links have two destinations: Gyro's own Browser panel, and whatever
 * browser the device uses. A plain click stays inside Gyro; a modifier click
 * hands the URL to the platform opener the desktop shell registers here.
 */

export type ExternalLinkOpener = (url: string) => void;

let opener: ExternalLinkOpener | undefined;

/**
 * The desktop shell registers the Tauri opener once, so a reply link can reach
 * the device browser without every surface carrying another callback. Clearing
 * the registration on unmount keeps a hot reload from pinning a stale bridge.
 */
export function registerExternalLinkOpener(next?: ExternalLinkOpener) {
  opener = next;
}

/** Open a URL outside Gyro, falling back to the platform window when unset. */
export function openExternalLink(url: string) {
  if (opener) {
    opener(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export type LinkClickIntent = {
  altKey?: boolean;
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

/**
 * A modifier click (or middle click) means "my own browser, not the panel".
 * ⌘ on macOS and Ctrl elsewhere both count, so the gesture is the same on
 * every platform without sniffing the OS.
 */
export function externalLinkIntent(event: LinkClickIntent) {
  if (event.button === 1) return true;
  return Boolean(
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
  );
}

/**
 * One route for every link Gyro renders in a reply: the panel when the surface
 * can show it, the device browser on a modifier click or when no panel handler
 * exists. Callers prevent the default anchor navigation first, so a link never
 * escapes into a blank webview window that cannot load.
 */
export function openReplyLink(
  event: LinkClickIntent,
  url: string,
  openInPanel?: (url: string) => void,
) {
  if (!externalLinkIntent(event) && openInPanel) {
    openInPanel(url);
    return;
  }
  openExternalLink(url);
}

/** Hover text that tells the user both destinations exist. */
export const replyLinkHint =
  "Opens in Gyro Browser — ⌘/Ctrl-click opens your default browser";

/**
 * Marks a reply link the reader recognises at a glance. Only hosts Gyro can
 * name with confidence earn one — a `github.com` URL is unambiguous, a random
 * blog is not — so an unknown host stays a plain blue link instead of guessing
 * at a logo.
 */
export type ReplyLinkMark = "github";

export function replyLinkMark(url: string): ReplyLinkMark | undefined {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  return undefined;
}
