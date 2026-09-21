import { useMemo, useState } from "react";
import { canvasPreviewDocument } from "./canvas-preview";

export function CanvasPreview({
  content,
  title,
}: {
  content: string;
  title: string;
}) {
  const [size, setSize] = useState("responsive");
  const [restart, setRestart] = useState(0);
  const document = useMemo(() => canvasPreviewDocument(content), [content]);
  // Development and Browser previews use Vite's isolated document. Packaged
  // macOS uses a dedicated protocol so the app's own CSP stays unchanged.
  const packaged = window.location.protocol === "tauri:";
  const src = packaged ? "gyro-canvas://localhost/" : "/canvas-runtime.html";
  return (
    <div className="gyro-canvas-preview">
      <div className="gyro-canvas-preview-tools">
        <span>Interactive preview</span>
        <select
          aria-label="Preview width"
          value={size}
          onChange={(event) => setSize(event.target.value)}
        >
          <option value="responsive">Fit panel</option>
          <option value="375">Mobile · 375px</option>
          <option value="768">Tablet · 768px</option>
          <option value="1280">Desktop · 1280px</option>
        </select>
        <button type="button" onClick={() => setRestart((value) => value + 1)}>
          Restart
        </button>
      </div>
      <div className="gyro-canvas-preview-stage">
        <iframe
          key={content + restart}
          title={title + " preview"}
          src={src}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          style={{ width: size === "responsive" ? "100%" : Number(size) }}
          onLoad={(event) =>
            event.currentTarget.contentWindow?.postMessage(
              { type: "gyro.canvas.render", document },
              "*",
            )
          }
        />
      </div>
    </div>
  );
}
