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
