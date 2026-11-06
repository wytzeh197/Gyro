/** The workbench may run as a window or a standalone web preview, never as
 * content inside its own Browser panel. This is a presentation boundary,
 * not a substitute for native command permissions. */
export function resolveBootSurface({
  browserAgent,
  framed,
  surface,
}: {
  browserAgent: boolean;
  framed: boolean;
  surface: string | null;
}): "main" | "menu-bar" | "embedded" {
  if (browserAgent || framed) return "embedded";
  return surface === "menu-bar" ? "menu-bar" : "main";
}
