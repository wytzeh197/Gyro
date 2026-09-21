/** No application commands or message handlers are exposed to generated UI. */
export const CANVAS_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function canvasPreviewDocument(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CANVAS_PREVIEW_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light}body{margin:0;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body>${content}</body></html>`;
}
