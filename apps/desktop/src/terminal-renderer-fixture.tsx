// Actual terminal renderer and chrome, with deterministic local output and no IPC.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppearanceContext,
  TerminalPanel,
  type TerminalPane,
} from "@gyro-dev/ui";
import { clearFocusedTerminal } from "./terminal-shortcuts";
import { LiveTerminalPaneBody } from "./live-terminal-pane";
import "@xterm/xterm/css/xterm.css";
import "@gyro-dev/ui/styles.css";
import "../../../packages/ui/src/appearance.css";

const initial: TerminalPane = {
  id: "fixture",
  title: "Terminal regression fixture",
  profileId: "shell",
  command: "zsh",
  output: "",
  status: "running",
  lastEvent: "fixture",
  workspaceMode: "local",
  branch: "main",
  createdAt: "2026-11-17T00:00:00Z",
};
let rejectResizes = 2;
const events = {
  sizes: [] as number[][],
  input: [] as string[],
  reconnects: 0,
  rejectedResizes: 0,
};
type FixtureState = {
  pane: TerminalPane;
  hidden: boolean;
  active: boolean;
  scale: number;
  theme: "dark" | "light";
};
declare global {
  interface Window {
    terminalFixture: {
      events: typeof events;
      clear: typeof clearFocusedTerminal;
      rejectResizes: (count: number) => void;
      update: (patch: Partial<FixtureState>) => void;
      pane: (patch: Partial<TerminalPane>) => void;
    };
  }
}
function Fixture() {
  const [state, setState] = useState<FixtureState>({
    pane: initial,
    hidden: false,
    active: true,
    scale: 1,
    theme: "dark",
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    window.terminalFixture = {
      events,
      clear: clearFocusedTerminal,
      rejectResizes: (count) => {
        rejectResizes = count;
      },
      update: (patch) => setState((current) => ({ ...current, ...patch })),
      pane: (patch) =>
        setState((current) => ({
          ...current,
          pane: { ...current.pane, ...patch },
        })),
    };
  }, [state.theme]);
  return (
    <AppearanceContext.Provider
      value={{ scale: state.scale, reduceMotion: true }}
    >
      <main
        style={{
          height: "100vh",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        <label style={{ padding: 8, color: "var(--gyro-text)" }}>
          Local renderer fixture · no commands executed{" "}
          <input aria-label="Other input" />
        </label>
        <div
          className="gyro-workspace-tool-panel is-primary"
          style={{ display: state.hidden ? "none" : "block", minHeight: 0 }}
        >
          <TerminalPanel
            sessionNavigation
            profiles={[]}
            activeProfileId="shell"
            output=""
            terminalPanes={[state.pane]}
            selectedTerminalPaneId={state.pane.id}
            onProfileChange={() => {}}
            onRunProfile={() => {}}
            renderTerminalPaneBody={(pane) => (
              <LiveTerminalPaneBody
                pane={pane}
                isActive={state.active}
                theme={state.theme}
                onBell={() => {}}
                onReconnect={() => {
                  events.reconnects++;
                }}
                onSelect={() => {}}
                onResize={(_, cols, rows) => {
                  if (rejectResizes > 0) {
                    rejectResizes--;
                    events.rejectedResizes++;
                    return false;
                  }
                  events.sizes.push([cols, rows]);
                  return true;
                }}
                onWrite={(_, input) => {
                  events.input.push(input);
                }}
              />
            )}
          />
        </div>
      </main>
    </AppearanceContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
