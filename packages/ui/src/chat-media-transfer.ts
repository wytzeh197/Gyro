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
  // Gyro's own drags (a chat from the sidebar, a pane title, an editor tab)
  // are never media, even if the webview adds a URI or image type to them.
  // Treating one as media let the window drop listener swallow it before the
  // chat grid saw it, then report a failed image attachment.
  if (types.some((type) => type.startsWith("application/x-gyro-"))) {
    return false;
  }
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

/** Browser and Photos drags can contain an image URL without a FileList.
 * Capture strings synchronously: the drag data store closes after this event. */
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
  const html = read("text/html");
  const imageUrl =
    html && typeof DOMParser !== "undefined"
      ? new DOMParser()
          .parseFromString(html, "text/html")
          .querySelector("img")
          ?.getAttribute("src")
      : undefined;
  const uri =
    imageUrl ||
    read("text/uri-list")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ||
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
    throw new Error(
      "This image source cannot be attached. Save the image and drop its file instead.",
    );
  }
  const limit = 32 * 1024 * 1024;
  if (
    url.protocol === "data:" &&
    uri.length > Math.ceil((limit * 4) / 3) + 1024
  ) {
    throw new Error("The dropped image is too large to download");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error("Image download failed (" + response.status + ")");
    const type =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (!type.startsWith("image/"))
      throw new Error("The dropped URL did not return an image");
    if (Number(response.headers.get("content-length")) > limit) {
      throw new Error("The dropped image is too large to download");
    }
    const reader = response.body?.getReader();
    let blob: Blob;
    if (reader) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit)
            throw new Error("The dropped image is too large to download");
          chunks.push(new Uint8Array(value));
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      blob = new Blob(chunks, { type });
    } else {
      blob = await response.blob();
      if (blob.size > limit)
        throw new Error("The dropped image is too large to download");
    }
    if (!blob.size) throw new Error("The dropped image is empty");
    const extension =
      type === "image/jpeg"
        ? "jpg"
        : type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
    let candidate =
      url.protocol === "data:"
        ? "image"
        : url.pathname.split("/").at(-1) || "image";
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      /* Keep malformed URL names usable. */
    }
    const base =
      candidate.replace(/\.[^.]*$/, "").replace(/[^\w. -]/g, "_") || "image";
    return [new File([blob], base + "." + extension, { type })];
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        "Image download timed out. Save the image and drop its file instead.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const SENDABLE_IMAGE = /\.(?:png|jpe?g|webp)$/i;

/** A copied screenshot or page image reaches the clipboard in several formats
 * at once (`image.png` and `image.tiff`), and some sources list a file twice.
 * Each is the same picture, so keep one per name, preferring a format the
 * model accepts without conversion. */
function oneFilePerImage(files: File[]): File[] {
  const kept = new Set<File>();
  const aliases = new Map<string, File>();
  for (const file of files) {
    if (kept.has(file)) continue;
    const stem = file.name.replace(/\.[^.]*$/, "").toLowerCase();
    const clipboardAlias =
      !/^video\//.test(file.type) &&
      /^(?:image|pasted(?:-image)?|clipboard)$/.test(stem);
    const previous = clipboardAlias ? aliases.get(stem) : undefined;
    // Prefer the sendable representation of a clipboard PNG/TIFF pair.
    // Same-format files remain distinct even with equal names and metadata.
    if (
      previous &&
      !SENDABLE_IMAGE.test(previous.name) &&
      SENDABLE_IMAGE.test(file.name)
    ) {
      kept.delete(previous);
    } else if (
      previous &&
      SENDABLE_IMAGE.test(previous.name) &&
      !SENDABLE_IMAGE.test(file.name)
    ) {
      continue;
    }
    kept.add(file);
    if (clipboardAlias) aliases.set(stem, file);
  }
  return [...kept];
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

/** Keep conversion buffers bounded. Already-sendable images stay unchanged. */
export function chatImageCanvasSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("The image has invalid dimensions");
  }
  const scale = Math.min(
    1,
    4096 / width,
    4096 / height,
    Math.sqrt(12_000_000 / width / height),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** Re-encode formats the attachment store cannot send, with bounded canvas memory. */
export async function sendableChatImage(
  file: File,
  maxBytes: number,
): Promise<File> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (isSendableImageHeader(head) && file.size <= maxBytes) return file;
  const url = URL.createObjectURL(file);
  let canvas: HTMLCanvasElement | undefined;
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    const size = chatImageCanvasSize(image.naturalWidth, image.naturalHeight);
    canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(image, 0, 0, size.width, size.height);
    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) =>
        canvas!.toBlob(resolve, type, quality),
      );
    let blob = await encode("image/png");
    let extension = "png";
    if (!blob || blob.size > maxBytes) {
      blob = await encode("image/jpeg", 0.9);
      extension = "jpg";
    }
    if (!blob || blob.size > maxBytes) {
      blob = await encode("image/jpeg", 0.8);
      extension = "jpg";
    }
    if (!blob || blob.size > maxBytes) return file;
    const base = file.name.replace(/\.[^.]*$/, "") || "image";
    return new File([blob], base + "." + extension, { type: blob.type });
  } catch {
    return file;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    image.src = "";
    URL.revokeObjectURL(url);
  }
}
