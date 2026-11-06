import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  BrowserFeedback,
  BrowserPreviewCapture,
  BrowserPreviewDevice,
} from "@gyro-dev/ui";
import { normalizedPreviewUrl } from "./browser-preview-text";
import { isTauriRuntime } from "./tauri-runtime";

export async function captureChatBrowserPage({
  sessionId,
  nativeHost,
  device,
  url,
}: {
  sessionId: string;
  nativeHost: boolean;
  device: BrowserPreviewDevice;
  url: string;
}): Promise<BrowserPreviewCapture> {
  if (!isTauriRuntime()) {
    throw new Error("Preview screenshots require the Gyro desktop app");
  }
  const snapshot = await invoke<{ url: string } | null>(
    "session_browser_snapshot",
    { sessionId },
  );
  let capture: BrowserPreviewCapture;
  if (snapshot) {
    capture = await invoke<BrowserPreviewCapture>(
      "capture_session_browser_preview",
      { sessionId },
    );
  } else {
    if (nativeHost) {
      throw new Error("The live browser page is no longer available");
    }
    capture = await invoke<BrowserPreviewCapture>("capture_browser_preview", {
      request: { device, url: normalizedPreviewUrl(url) },
    });
  }
  return { ...capture, src: convertFileSrc(capture.path) };
}

export async function revealBrowserCapture(
  path?: string,
): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    await revealItemInDir(path);
    return undefined;
  } catch (error) {
    return String(error);
  }
}

export function appendFeedback(draft: string | undefined, note: string) {
  return [draft?.trim(), note].filter(Boolean).join("\n\n");
}

export function browserFeedbackDraft({
  capture,
  feedback,
  attachments,
  fallbackUrl,
}: {
  capture?: BrowserPreviewCapture;
  feedback?: BrowserFeedback;
  attachments: Array<{ kind: string; previewUrl?: string }>;
  fallbackUrl: string;
}): { ok: true; note: string } | { ok: false; error: string } {
  if (!capture || !feedback || feedback.captureId !== capture.filename) {
    return { ok: false, error: "Take a new capture and select the area again" };
  }
  if (
    !attachments.some(
      (item) => item.kind === "image" && item.previewUrl === capture.src,
    )
  ) {
    return {
      ok: false,
      error: "The capture could not be attached to this chat",
    };
  }
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const { x, y, width, height } = feedback.region;
  const location = `x ${percent(x)}, y ${percent(y)}, width ${percent(width)}, height ${percent(height)}`;
  const source = capture.sourceUrl ?? fallbackUrl;
  return {
    ok: true,
    note: `Browser feedback for ${source} (captured ${capture.createdAt}; ${capture.width} × ${capture.height} image; region ${location}): ${feedback.comment.trim()}`,
  };
}
