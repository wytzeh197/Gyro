// Actual Gyro composer. The transcriber is a labeled fixture: no microphone.
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  providersForConfig,
  type DictationController,
  type DictationListener,
  type GyroConfig,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const baseConfig: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: false,
  requireFileEditApproval: false,
  telemetryEnabled: false,
};
const config: GyroConfig = {
  ...baseConfig,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(baseConfig).map((provider) =>
    provider.id === "openai"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
};

const spoken = ["Add", "Add a microphone", "Add a microphone next to send"];

function createFixtureDictation(): DictationController {
  let timers: number[] = [];
  let active: DictationListener | null = null;
  const clear = () => {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
    active = null;
  };
  return {
    start(listener) {
      clear();
      active = listener;
      spoken.forEach((text, index) => {
        const id = window.setTimeout(() => {
          if (listener.signal.aborted || active !== listener) return;
          if (index === spoken.length - 1) {
            active = null;
            listener.onFinal(text);
            return;
          }
          listener.onPartial(text);
        }, 1600 * (index + 1));
        timers.push(id);
      });
    },
    stop: clear,
  };
}

function Fixture() {
  const dictation = useMemo(createFixtureDictation, []);
  const [draft, setDraft] = useState("Please");
  const [action, setAction] = useState("No action selected");
  return (
    <div className="dictation-preview">
      <style>{`
        .dictation-preview { height: 100dvh; display: flex; flex-direction: column; background: var(--gyro-app); color: var(--gyro-text); }
        .dictation-preview-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px 20px; border-bottom: 1px solid var(--gyro-border-soft); }
        .dictation-preview-controls strong { font-size: 13px; margin-right: auto; }
        .dictation-preview-controls button { background: var(--gyro-surface); color: var(--gyro-muted); border: 1px solid var(--gyro-border); border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
        .dictation-preview-caption { margin: 0; padding: 10px 20px; color: var(--gyro-faint); font-size: 12px; }
        .dictation-preview-stage { flex: 1; min-height: 0; display: grid; }
        .dictation-preview-result { margin: 0; padding: 10px 20px; border-top: 1px solid var(--gyro-border-soft); font-size: 12px; color: var(--gyro-muted); }
      `}</style>
      <nav className="dictation-preview-controls" aria-label="Preview fixture controls">
        <strong>Dictation · component fixture</strong>
        <button type="button" onClick={() => setDraft("Please")}>Draft: Please</button>
        <button type="button" onClick={() => setDraft("")}>Clear draft</button>
      </nav>
      <p className="dictation-preview-caption">Actual Gyro composer. Fixture transcriber, no microphone. The mic sits left of Send. Click it to stream a canned sentence into the draft. Click again to drop the unconfirmed words. Send stays a separate press.</p>
      <main className="dictation-preview-stage">
        <ChatSurface
          config={config}
          events={[]}
          draft={draft}
          onDraftChange={setDraft}
          dictation={dictation}
          sessionModel={{ modelLabel: "GPT-6.1 Sol" }}
          onSend={() => setAction("Fixture send")}
          shellReady
        />
      </main>
      <p className="dictation-preview-result" role="status">Draft: {draft || "(empty)"} · {action}</p>
    </div>
  );
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
