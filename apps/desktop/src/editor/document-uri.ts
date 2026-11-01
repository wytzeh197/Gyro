/** A single model identity for the local POSIX files used by Workspace. */
export function canonicalFileUri(path: string): string {
  const normalized = normalizeFilePath(path);
  return `file://${normalized
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")}`;
}

/** Unsupported resources stay unsupported; they must never become file paths. */
export function filePathFromUri(uri: string): string | undefined {
  const match = /^file:(?:\/\/([^/]*))?(\/[^?#]*)$/i.exec(uri);
  if (!match || (match[1] && match[1].toLowerCase() !== "localhost"))
    return undefined;
  const encodedPath = match[2]!;
  // Encoded separators cannot name a POSIX filename and create ambiguous roots.
  if (/%2f/i.test(encodedPath)) return undefined;
  try {
    return normalizeFilePath(decodeURIComponent(encodedPath));
  } catch {
    return undefined;
  }
}

function normalizeFilePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0"))
    throw new Error(
      "Workspace documents must use an absolute local file path.",
    );
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
