/** True inside the packaged desktop app, false in a browser or preview build. */
export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
