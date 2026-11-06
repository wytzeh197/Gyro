/**
 * The one rulebook for a workspace entry name.
 *
 * The explorer's inline row, the create prompt and anything else that names a
 * file or folder inside the workspace asks here, so a name is refused for the
 * same reasons everywhere and before anything touches the disk. The Rust side
 * still validates: a name can always be derived some other way, and the
 * backend must not trust a caller.
 */
export function validateWorkspaceEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Enter a name.";
  }
  if (trimmed === "." || trimmed === "..") {
    return "That name is reserved.";
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "A name cannot contain a slash.";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return "A name cannot contain control characters.";
  }
  if (trimmed.length > 255) {
    return "That name is too long.";
  }
  return null;
}

/** The name a path ends with, for seeding an inline rename field. */
export function workspaceEntryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
