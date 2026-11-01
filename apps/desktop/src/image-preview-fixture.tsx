// Production cards with simulated native reads; no provider or filesystem writes.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatFileCard,
  ChatFileActionsContext,
  ChatFileScopeContext,
} from "../../../packages/ui/src/chat-file-card";
import { createChatFileActions } from "./chat-file-actions";
import "@gyro-dev/ui/styles.css";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
let ready = false;
const calls: string[] = [];
const actions = createChatFileActions({
  invoke: async <T,>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const request = args.request as {
      sessionId: string;
      workspacePath: string;
      target: string;
    };
    if (command !== "read_cited_chat_image")
      throw new Error("Unexpected preview write");
    calls.push(
      `${request.sessionId}:${request.workspacePath}:${request.target}`,
    );
    document.documentElement.dataset.previewCalls = JSON.stringify(calls);
    if (!ready) throw new Error("Temporary read failure");
    return png as T;
  },
  convertFileSrc: (path) => path,
  open: () => {
    throw new Error("Retry should load the preview");
  },
});

function Fixture() {
  const [available, setAvailable] = useState(false);
  return (
    <ChatFileActionsContext.Provider value={actions}>
      <button
        onClick={() => {
          ready = true;
          setAvailable(true);
        }}
      >
        Make images available
      </button>
      <p role="status">{available ? "Available" : "Unavailable"}</p>
      <div style={{ display: "flex", gap: 24, padding: 24 }}>
        {["a", "b"].map((pane) => (
          <ChatFileScopeContext.Provider
            key={pane}
            value={{ sessionId: pane, workspacePath: `/project-${pane}` }}
          >
            <section data-preview-pane={pane}>
              <ChatFileCard
                file={{
                  local: true,
                  kind: "image",
                  target: "shots/image.png",
                  name: `Image ${pane}`,
                }}
              />
            </section>
          </ChatFileScopeContext.Provider>
        ))}
        {available && (
          <ChatFileScopeContext.Provider
            value={{ sessionId: "a", workspacePath: "/project-a" }}
          >
            <section data-preview-pane="stale">
              <ChatFileCard
                file={{
                  local: true,
                  kind: "image",
                  target: "shots/stale.png",
                  name: "Stale URL",
                }}
                previewUrl="blob:http://127.0.0.1:1420/no-longer-valid"
              />
            </section>
          </ChatFileScopeContext.Provider>
        )}
      </div>
    </ChatFileActionsContext.Provider>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Fixture />);
