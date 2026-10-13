import type { ChatAttachment } from "@gyro-dev/ui";

/**
 * A dropped image shows in the composer the moment it lands. Its chip stands
 * in for the upload until the stored file replaces it, and a send made in the
 * meantime waits for that upload instead of dropping the image.
 */
const uploads = new Map<string, Promise<ChatAttachment | undefined>>();

export function pendingMediaAttachment(
  file: File,
  kind: "image" | "video",
): ChatAttachment {
  const id = `pending-media:${crypto.randomUUID()}`;
  return {
    id,
    kind,
    name: file.name || `pasted-${kind}`,
    path: id,
    mimeType: file.type || undefined,
    size: file.size,
    previewUrl: URL.createObjectURL(file),
    pending: true,
  };
}

/** `upload` resolves to undefined when the file was rejected; it never throws. */
export function trackPendingMedia(
  placeholder: ChatAttachment,
  upload: Promise<ChatAttachment | undefined>,
) {
  uploads.set(placeholder.id, upload);
  return upload.finally(() => {
    // The stored file's own preview has replaced this one by now.
    if (placeholder.previewUrl) URL.revokeObjectURL(placeholder.previewUrl);
    // Keep the result briefly: a send can read the placeholder from state
    // in the same tick the upload settles.
    window.setTimeout(() => uploads.delete(placeholder.id), 60_000);
  });
}

// One decoder/raw IPC upload at a time, shared by all chat panes.
const mediaUploadQueue: Array<() => void> = [];
let mediaUploadActive = false;
export function queueMediaUpload<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(new Error("Media upload cancelled"));
  return new Promise<T>((resolve, reject) => {
    let started = false;
    const abort = () => {
      if (!started) {
        const index = mediaUploadQueue.indexOf(start);
        if (index >= 0) mediaUploadQueue.splice(index, 1);
      }
      signal?.removeEventListener("abort", abort);
      reject(new Error("Media upload cancelled"));
    };
    const start = () => {
      started = true;
      mediaUploadActive = true;
      // A timed-out native call can still be finishing. Keep its slot until
      // the underlying work settles, so retries cannot accumulate workers.
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          const next = mediaUploadQueue.shift();
          if (next) next();
          else mediaUploadActive = false;
        });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (mediaUploadActive) mediaUploadQueue.push(start);
    else start();
  });
}

/** Bound a stalled decoder or native upload so sending cannot wait forever. */
export function withMediaUploadTimeout<T>(
  upload: Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      onTimeout?.();
      reject(
        new Error("Media upload timed out. Drop the file again to retry."),
      );
    }, 60_000);
    upload.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Wait for every selected upload; a failed image must never be silently sent away. */
export async function settlePendingMedia(attachments: ChatAttachment[]) {
  const settled = await Promise.all(
    attachments.map((attachment) =>
      attachment.pending ? uploads.get(attachment.id) : attachment,
    ),
  );
  if (settled.some((attachment) => !attachment)) {
    throw new Error(
      "An attachment could not be uploaded. Your message is preserved; attach the file again before sending.",
    );
  }
  const seen = new Set<string>();
  return settled.filter((attachment): attachment is ChatAttachment => {
    if (!attachment || seen.has(attachment.path)) return false;
    seen.add(attachment.path);
    return true;
  });
}

/** Placeholders point at this window's memory; they never outlive it. */
export function withoutPendingMedia(
  attachments: Record<string, ChatAttachment[]>,
) {
  return Object.fromEntries(
    Object.entries(attachments).map(([key, items]) => [
      key,
      items.filter((item) => !item.pending),
    ]),
  );
}
