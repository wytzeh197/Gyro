import React, { useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";

type WindowAction = "close" | "minimize" | "zoom";

const WINDOW_ACTIONS: ReadonlyArray<{
  action: WindowAction;
  className: string;
  label: string;
}> = [
  { action: "close", className: "is-close", label: "Close window" },
  { action: "minimize", className: "is-minimize", label: "Minimize window" },
  { action: "zoom", className: "is-zoom", label: "Zoom window" },
];

function runWindowAction(action: WindowAction) {
  void invoke("main_window_action", { action }).catch((error: unknown) => {
    console.error(`could not ${action} the window`, error);
  });
}

/** The glyph AppKit paints inside a dot while the pointer is over the group. */
function WindowActionGlyph({ action }: { action: WindowAction }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12">
      {action === "close" ? (
        <path d="M3.7 3.7 8.3 8.3M8.3 3.7 3.7 8.3" />
      ) : action === "minimize" ? (
        <path d="M3 6h6" />
      ) : (
        <path
          className="gyro-window-control-fill"
          d="M7.2 4.5V2.1l2.4 2.4zM4.8 7.5v2.4L2.4 7.5z"
        />
      )}
    </svg>
  );
}

/**
 * The window's own traffic lights.
 *
 * macOS paints a fixed 12px dot that ignores its button frame, so the native
 * controls can never reach the 15px of the header icons or sit on their
 * centreline. These dots are laid out by the same engine as the buttons beside
 * them, centred in the same 48px row; `window_controls.rs` hides the native
 * ones and receives the clicks.
 */
export function WindowControls() {
  const [isInactive, setIsInactive] = useState(() => !document.hasFocus());
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const syncFocus = () => setIsInactive(!document.hasFocus());
    window.addEventListener("blur", syncFocus);
    window.addEventListener("focus", syncFocus);
    return () => {
      window.removeEventListener("blur", syncFocus);
      window.removeEventListener("focus", syncFocus);
    };
  }, []);

  useEffect(() => {
    // Fullscreen hides the titlebar, so the dots have to leave with it.
    let pending = 0;
    const syncFullscreen = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        void invoke<boolean>("main_window_is_fullscreen")
          .then(setIsFullscreen)
          .catch(() => undefined);
      }, 120);
    };
    syncFullscreen();
    window.addEventListener("resize", syncFullscreen);
    return () => {
      window.clearTimeout(pending);
      window.removeEventListener("resize", syncFullscreen);
    };
  }, []);

  if (!isTauri() || !navigator.platform.includes("Mac") || isFullscreen) {
    return null;
  }

  return createPortal(
    <div
      aria-label="Window controls"
      className={
        isInactive ? "gyro-window-controls is-inactive" : "gyro-window-controls"
      }
      role="group"
    >
      {WINDOW_ACTIONS.map(({ action, className, label }) => (
        <button
          aria-label={label}
          className={className}
          key={action}
          onClick={() => runWindowAction(action)}
          // The native dots never take keyboard focus; keep the caret put.
          onPointerDown={(event) => event.preventDefault()}
          title={label}
          type="button"
        >
          <WindowActionGlyph action={action} />
        </button>
      ))}
    </div>,
    document.body,
  );
}
