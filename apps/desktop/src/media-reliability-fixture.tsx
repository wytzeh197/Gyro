// Standalone actual-component fixture. Media storage and provider sends are simulated.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  ChatSurface,
  providersForConfig,
  sendableChatImage,
  type GyroConfig,
  type ChatAttachment,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const empty: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: true,
  requireFileEditApproval: true,
  telemetryEnabled: false,
};
const config: GyroConfig = {
  ...empty,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(empty).map((p) =>
    p.id === "openai" ? { ...p, enabled: true, authStatus: "connected" } : p,
  ),
};
const source =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#2076d3"/><circle cx="32" cy="32" r="17" fill="white"/><path d="M24 32h16m-8-8v16" stroke="#2076d3" stroke-width="3"/></svg>',
  );
function Fixture() {
  const [theme, setTheme] = useState("light");
  const [scale, setScale] = useState("1");
  const [drafts, setDrafts] = useState<Record<string, string>>({
    a: "Check the send arrow",
    b: "Drop an image here",
  });
  const [attachments, setAttachments] = useState<
    Record<string, ChatAttachment[]>
  >({});
  const [status, setStatus] = useState(
    "Ready. Drag the sample image into either chat.",
  );
  const [centers, setCenters] = useState("Measuring arrows");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--gyro-ui-scale", scale);
    {
      const errors = [
        ...document.querySelectorAll<HTMLButtonElement>(".gyro-send-button"),
      ].map((button) => {
        const svg = button.querySelector("svg")!;
        const a = button.getBoundingClientRect(),
          b = svg.getBoundingClientRect();
        return Math.max(
          Math.abs(a.x + a.width / 2 - b.x - b.width / 2),
          Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
        );
      });
      setCenters(
        "Arrow centers: " +
          (errors.every((error) => error <= 0.5) ? "PASS" : "FAIL") +
          " · max offset " +
          Math.max(...errors).toFixed(2) +
          " px",
      );
    }
  }, [theme, scale, attachments]);
  const dropFixtureImage = (pane: string) => {
    flushSync(() =>
      setStatus("Running simulated drop into Pane " + pane.toUpperCase()),
    );
    const target = document.querySelector<HTMLElement>(
      "[data-fixture-pane='" + pane + "']",
    )!;
    const rect = target.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.setData("text/uri-list", source);
    const options = {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
    target.dispatchEvent(new DragEvent("dragover", options));
    target.dispatchEvent(new DragEvent("drop", options));
  };
  const attach = async (pane: string, files: File[]) => {
    try {
      const converted = await Promise.all(
        files.map((file) => sendableChatImage(file, 10 * 1024 * 1024)),
      );
      setAttachments((current) => ({
        ...current,
        [pane]: [
          ...(current[pane] ?? []),
          ...converted.map((file) => ({
            id: crypto.randomUUID(),
            kind: "image" as const,
            name: file.name,
            path: "/fixture/" + file.name,
            size: file.size,
            mimeType: file.type,
            previewUrl: URL.createObjectURL(file),
          })),
        ],
      }));
      setStatus(
        "Attached " +
          converted.map((file) => file.name).join(", ") +
          " to Pane " +
          pane.toUpperCase(),
      );
    } catch (error) {
      setStatus(String(error));
    }
  };
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--gyro-bg)",
        color: "var(--gyro-text)",
      }}
    >
      <header
        style={{
          padding: 16,
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--gyro-border)",
        }}
      >
        <strong>Reliability fixtures</strong>
        <span>
          Actual chat components · sample media · simulated storage and sends
        </span>
        <label>
          Theme{" "}
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            <option>light</option>
            <option>dark</option>
          </select>
        </label>
        <label>
          Size{" "}
          <select
            aria-label="Size"
            value={scale}
            onChange={(e) => setScale(e.target.value)}
          >
            <option value="0.9">Small</option>
            <option value="1">Default</option>
            <option value="1.15">Large</option>
          </select>
        </label>
        <img
          src={source}
          alt="Drag sample image"
          draggable
          width={44}
          height={44}
        />
        <button type="button" onClick={() => dropFixtureImage("a")}>
          Fixture drop A
        </button>
        <button type="button" onClick={() => dropFixtureImage("b")}>
          Fixture drop B
        </button>
        <output aria-live="polite">{centers}</output>
      </header>
      <p role="status" style={{ margin: 0, padding: "8px 16px" }}>
        {status}
      </p>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          minHeight: 0,
          flex: 1,
        }}
      >
        {["a", "b"].map((pane) => {
          const events: SessionEvent[] = [
            {
              id: pane + "-user",
              sessionId: pane,
              kind: "user-message",
              message: "This is Pane " + pane.toUpperCase(),
              createdAt: "2026-10-13T10:00:00Z",
              payload: {},
            },
            {
              id: pane + "-reply",
              sessionId: pane,
              kind: "assistant-message",
              message:
                "Drop images anywhere inside this chat. The send control uses the production styles.",
              createdAt: "2026-10-13T10:00:01Z",
              payload: {},
            },
          ];
          return (
            <div
              key={pane}
              data-fixture-pane={pane}
              style={{
                minWidth: 0,
                minHeight: 0,
                borderRight: "1px solid var(--gyro-border)",
              }}
            >
              <ChatSurface
                config={config}
                events={events}
                paneKey={pane}
                sessionTitle={"Pane " + pane.toUpperCase()}
                workspacePath="/fixture/Gyro"
                shellReady
                isTiled
                sessionModel={{
                  providerId: "openai",
                  modelId: "gpt-6.1-sol",
                  modelLabel: "GPT-6.1 Sol",
                  reasoningEffort: "medium",
                }}
                draft={drafts[pane] ?? ""}
                onDraftChange={(value) =>
                  setDrafts((current) => ({ ...current, [pane]: value }))
                }
                attachments={attachments[pane] ?? []}
                onAttachMediaFiles={(files) => {
                  void attach(pane, files);
                }}
                onMediaDropError={setStatus}
                onRemoveAttachment={(id) =>
                  setAttachments((current) => ({
                    ...current,
                    [pane]: (current[pane] ?? []).filter(
                      (item) => item.id !== id,
                    ),
                  }))
                }
                onSend={() =>
                  setStatus(
                    "Fixture send received from Pane " + pane.toUpperCase(),
                  )
                }
                isEnvironmentRailOpen={false}
                onComposerAction={() => undefined}
              />
            </div>
          );
        })}
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
