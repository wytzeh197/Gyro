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

/** Swap every placeholder for its stored file, dropping any that failed. */
export async function settlePendingMedia(attachments: ChatAttachment[]) {
  const settled = await Promise.all(
    attachments.map((attachment) =>
      attachment.pending ? uploads.get(attachment.id) : attachment,
    ),
  );
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
