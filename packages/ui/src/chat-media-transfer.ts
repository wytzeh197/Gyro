/** The part of a transfer this module reads, so tests need no real drag. */
type MediaTransfer = Pick<DataTransfer, "types"> &
  Partial<Pick<DataTransfer, "files" | "items">>;

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
  if (
    Array.from(transfer.items ?? []).some((item) => item.kind === "file")
  ) {
    return true;
  }
  if (types.some((type) => /^image\//i.test(type))) return true;
  return types.includes("text/uri-list");
}

/** Read file objects while the drop/paste event still owns its data store. */
export function chatMediaFiles(
  transfer: Pick<DataTransfer, "files" | "items">,
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
  return files.filter(
    (file) =>
      /^(?:image|video)\//.test(file.type) ||
      /\.(?:png|jpe?g|webp|gif|heic|heif|tiff?|bmp|avif|mp4|m4v|mov|webm)$/i.test(
        file.name,
      ),
  );
}
