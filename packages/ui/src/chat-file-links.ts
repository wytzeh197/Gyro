export type ChatFileKind = "image" | "video" | "audio" | "pdf" | "file";
export type ChatFileLink = {
  target: string;
  name: string;
  kind: ChatFileKind;
  local: boolean;
};

export const chatInlineTokenPattern =
  /(`[^`]+`|\*\*[^*]+\*\*|!?\[[^\]]*\]\((?:<[^>]+>|(?:[^()\n]|\([^()\n]*\))+)\))/g;

export function parseChatMarkdownLink(value: string) {
  const match = value.match(/^(!?)\[([^\]]*)\]\(([\s\S]+)\)$/);
  if (!match) return undefined;
  const raw = match[3]!.trim();
  const target = raw.startsWith("<")
    ? raw.slice(1, raw.indexOf(">"))
    : raw.replace(/\s+["'][^"']*["']$/, "");
  return { image: match[1] === "!", label: match[2]!, target };
}

export function chatFileKind(name: string, mimeType = ""): ChatFileKind {
  if (
    mimeType.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|avif|svg|heic)$/i.test(name)
  )
    return "image";
  if (mimeType.startsWith("video/") || /\.(mp4|mov|m4v|webm|ogv)$/i.test(name))
    return "video";
  if (
    mimeType.startsWith("audio/") ||
    /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(name)
  )
    return "audio";
  if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  return "file";
}

const citedImageExtension = /\.(png|jpe?g|webp)$/i;

/**
 * A path a model cited that can be resolved into a chat image.
 * Web URLs and GIF stay on their existing paths. `..` cannot be a segment.
 */
export function isCitedImageTarget(value: string): boolean {
  const target = value.trim();
  if (!target || target.length > 4096 || /[\u0000-\u001f]/.test(target)) {
    return false;
  }
  const lower = target.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("javascript:")
  ) {
    return false;
  }
  let path = target;
  if (lower.startsWith("file:")) {
    try {
      const url = new URL(target);
      if (
        url.protocol !== "file:" ||
        (url.hostname && url.hostname !== "localhost")
      ) {
        return false;
      }
      path = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return false;
  }
  if (path.split(/[/\\]/).some((part) => part === "..")) return false;
  const name = path.split(/[/\\]/).pop() ?? "";
  return citedImageExtension.test(name);
}

/** Image targets already shown as markdown, so a repeated backtick is dropped. */
export function markdownImageTargets(message: string): Set<string> {
  const targets = new Set<string>();
  for (const part of message.split(chatInlineTokenPattern)) {
    const link = parseChatMarkdownLink(part);
    if (link?.image && isCitedImageTarget(link.target)) {
      targets.add(link.target.trim());
    }
  }
  return targets;
}

/** Only explicit local paths and web URLs can become file cards. */
export function linkedChatFile(
  label: string,
  rawTarget: string,
  image = false,
): ChatFileLink | undefined {
  let target = rawTarget.trim();
  let path = target;
  let local = target.startsWith("/") && !target.startsWith("//");
  if (/[\u0000-\u001f]/.test(target)) return undefined;
  if (!local) {
    try {
      const url = new URL(target);
      if (
        url.protocol === "file:" &&
        (!url.hostname || url.hostname === "localhost")
      ) {
        path = decodeURIComponent(url.pathname);
        target = path;
        local = true;
      } else if (url.protocol === "https:" || url.protocol === "http:") {
        path = decodeURIComponent(url.pathname);
        target = url.href;
      } else return undefined;
    } catch {
      return undefined;
    }
  }
  if (local) target = target.replace(/:\d+(?::\d+)?$/, "");
  const filename = (local ? target : path).split("/").pop() || "File";
  const name = label.trim() || filename;
  const detectedKind = chatFileKind(filename === "File" ? name : filename);
  const kind = image && detectedKind === "file" ? "image" : detectedKind;
  // Ordinary web-page links keep their familiar inline treatment.
  if (
    !local &&
    !image &&
    kind === "file" &&
    !/\.(pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|json|zip|tar|gz|7z|rar|rtf|epub|html?|ya?ml|py|tsx?|jsx?|rs|css)$/i.test(
      filename,
    ) &&
    !/\.(pdf|docx?|xlsx?|pptx?|csv|zip)$/i.test(name)
  )
    return undefined;
  return {
    target,
    name,
    kind: kind === "file" ? chatFileKind(name) : kind,
    local,
  };
}
