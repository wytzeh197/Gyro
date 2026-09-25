/** The part of a transfer this module reads, so tests need no real drag. */
type MediaTransfer = Pick<DataTransfer, "types"> &
  Partial<Pick<DataTransfer, "files" | "items" | "getData">>;

/** Whether a drag is carrying files rather than text or a page element.
 *
 * Gating a drop on the `Files` type alone loses every drag whose source does
 * not advertise it: an image dragged out of Preview, Photos, or a browser page
 * can arrive as an image type or as a URI list only. A drag-over that does not
 * cancel the event never becomes a drop, so those images failed silently.
 *
 * `items` is only a hint: it is empty during drag-over for drags from outside
 * the app. */
export function isMediaDrag(transfer: MediaTransfer | null | undefined) {
  if (!transfer) return false;
  const types = Array.from(
    (transfer.types ?? []) as unknown as ArrayLike<string>,
  );
  if (types.includes("Files")) return true;
  if (Array.from(transfer.items ?? []).some((item) => item.kind === "file")) {
    return true;
  }
  if (types.some((type) => /^image\//i.test(type))) return true;
  return types.includes("text/uri-list");
}

/** Read file objects while the drop/paste event still owns its data store. */
export function chatMediaFiles(
  transfer: Partial<Pick<DataTransfer, "files" | "items">>,
): File[] {
  const files = Array.from(transfer.files ?? []);
  // Some drag sources expose file items without populating FileList. Prefer
  // FileList when present so the same image is not attached twice.
  if (!files.length) {
    for (const item of Array.from(transfer.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return oneFilePerImage(
    files.filter(
      (file) =>
        /^(?:image|video)\//.test(file.type) ||
        /\.(?:png|jpe?g|webp|gif|heic|heif|tiff?|bmp|avif|mp4|m4v|mov|webm)$/i.test(
          file.name,
        ),
    ),
  );
}

/** Browser and Photos drags can contain only an image URL, with no FileList.
 * Capture its data during the drop event; the data store closes afterward. */
export async function chatMediaFilesFromDrop(
  transfer: MediaTransfer,
): Promise<File[]> {
  const files = chatMediaFiles(transfer);
  if (files.length) return files;
  const read = (type: string) => {
    try {
      return transfer.getData?.(type).trim() ?? "";
    } catch {
      return "";
    }
  };
  const uri =
    (read("text/uri-list")
      .split(/\r?\n/)
      .find((line) => line && !line.startsWith("#")) ??
      "") ||
    read("image/png") ||
    read("image/jpeg") ||
    read("image/webp");
  if (!uri)
    throw new Error("This image drag did not provide a readable file or URL");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("This image drag did not provide a valid image URL");
  }
  if (!["http:", "https:", "data:"].includes(url.protocol)) {
    throw new Error("This image source cannot be attached");
  }
  const response = await fetch(url.href);
  if (!response.ok)
    throw new Error(`Image download failed (${response.status})`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("The dropped URL did not return an image");
  }
  const extension =
    blob.type === "image/jpeg"
      ? "jpg"
      : blob.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  const candidate =
    url.protocol === "data:"
      ? "image"
      : decodeURIComponent(url.pathname.split("/").at(-1) || "image");
  const base =
    candidate.replace(/\.[^.]*$/, "").replace(/[^\w. -]/g, "_") || "image";
  return [new File([blob], `${base}.${extension}`, { type: blob.type })];
}

const SENDABLE_IMAGE = /\.(?:png|jpe?g|webp)$/i;

/** A copied screenshot or page image reaches the clipboard in several formats
 * at once (`image.png` and `image.tiff`), and some sources list a file twice.
 * Each is the same picture, so keep one per name, preferring a format the
 * model accepts without conversion. */
function oneFilePerImage(files: File[]): File[] {
  const kept = new Map<string, File>();
  for (const file of files) {
    const isImage =
      !/^video\//.test(file.type) &&
      !/\.(?:mp4|m4v|mov|webm)$/i.test(file.name);
    const key = isImage
      ? "image:" + (file.name.replace(/\.[^.]*$/, "").toLowerCase() || "image")
      : "video:" + file.name + ":" + file.size;
    const current = kept.get(key);
    if (!current) kept.set(key, file);
    else if (
      !SENDABLE_IMAGE.test(current.name) &&
      SENDABLE_IMAGE.test(file.name)
    ) {
      kept.set(key, file);
    }
  }
  return [...kept.values()];
}

/** Image bytes the attachment store accepts as-is: PNG, JPEG or WebP. */
function isSendableImageHeader(head: Uint8Array) {
  const at = (index: number) => head[index];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return true;
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return true;
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...head.subarray(from, to));
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

/**
 * HEIC photos, GIFs, TIFF screenshots and images too large to send failed at
 * upload with an error most people never saw. The webview can decode them, so
 * re-encode those as PNG (or JPEG when PNG is still over the limit) first.
 * Anything it cannot decode is returned unchanged for the upload to reject.
 */
export async function sendableChatImage(
  file: File,
  maxBytes: number,
): Promise<File> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (isSendableImageHeader(head) && file.size <= maxBytes) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, quality),
      );
    let blob = await encode("image/png");
    let extension = "png";
    if (!blob || blob.size > maxBytes) {
      blob = await encode("image/jpeg", 0.9);
      extension = "jpg";
    }
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]*$/, "") || "image";
    return new File([blob], `${base}.${extension}`, { type: blob.type });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
