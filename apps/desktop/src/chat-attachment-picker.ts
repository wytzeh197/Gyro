export type ChatAttachmentPickerKind =
  | "image"
  | "video"
  | "media"
  | "workspace-file"
  | "any";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"];

export function isSupportedChatVideoPath(path: string) {
  return /\.(?:mp4|m4v|mov|webm)$/i.test(path.trim());
}

export function isSupportedChatImagePath(path: string) {
  return /\.(?:png|jpe?g|webp)$/i.test(path.trim());
}

export function chatAttachmentPickerTitle(kind: ChatAttachmentPickerKind) {
  return {
    image: "Attach images",
    video: "Attach videos",
    media: "Attach media",
    any: "Attach files",
    "workspace-file": "Attach workspace file",
  }[kind];
}

export function chatAttachmentPickerFilters(kind: ChatAttachmentPickerKind) {
  switch (kind) {
    case "image":
      return [{ name: "Images", extensions: IMAGE_EXTENSIONS }];
    case "video":
      return [{ name: "Videos", extensions: VIDEO_EXTENSIONS }];
    case "media":
      return [
        { name: "Media", extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] },
      ];
    default:
      return undefined;
  }
}

/**
 * "any" is the composer's single Attach picker: media keeps its limits, and
 * anything else is a project file.
 */
export function chatAttachmentKindForPath(
  kind: ChatAttachmentPickerKind,
  path: string,
): "image" | "video" | "workspace-file" {
  if (kind !== "media" && kind !== "any") {
    return kind;
  }
  if (isSupportedChatVideoPath(path)) {
    return "video";
  }
  return kind === "media" || isSupportedChatImagePath(path)
    ? "image"
    : "workspace-file";
}
