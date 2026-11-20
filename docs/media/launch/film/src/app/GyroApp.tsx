// Renders the real Gyro UI components from the app checkout (packages/ui),
// as static markup so every frame is deterministic.
import React, { useLayoutEffect } from "react";
import "@gyro-ui/styles-entry.css";
import "./film-app.css";
import { AppChrome, ChatSurface } from "@gyro-ui/surfaces.tsx";
import { config } from "../fixtures/config.js";

const noop = () => {};

// Deterministic film clock: the UI reads Date.now() for "Working for…" timers.
export const FILM_T0 = Date.parse("2026-11-17T09:00:00Z");
const filmClock = { ms: FILM_T0 };
if (typeof window !== "undefined" && !(window as any).__gyroFilmPatched) {
  (window as any).__gyroFilmPatched = true;
  Date.now = () => filmClock.ms;
  // Autofocus must not scroll the (overflow:hidden) frame.
  const focus = HTMLElement.prototype.focus;
  // Rows that scroll themselves into view would also scroll the film canvas.
  Element.prototype.scrollIntoView = function () {};
  HTMLElement.prototype.focus = function (opts?: FocusOptions) {
    focus.call(this, { ...(opts ?? {}), preventScroll: true });
  };
}

export type SessionStub = { title: string; providerId?: string; providerLabel?: string; modelLabel?: string };

export const makeSessions = (list: SessionStub[]) =>
  list.map((s, i) => ({
    id: "s-" + i,
    title: s.title,
    workspacePath: "/Users/demo/aurora",
    providerId: s.providerId ?? "anthropic",
    providerLabel: s.providerLabel ?? "Claude Code",
    modelId: "claude-opus-5",
    modelLabel: s.modelLabel ?? "Claude Opus 5",
    reasoningEffort: "high",
    kind: "chat",
    origin: "gyro",
    createdAt: "2026-11-17T09:00:00Z",
    updatedAt: "2026-11-17T09:00:00Z",
  }));

let n = 0;
export const ev = (kind: string, message: string, payload: Record<string, unknown> = {}) => ({
  id: "e-" + n++,
  sessionId: "s-0",
  turnId: "turn-1",
  createdAt: "2026-11-17T09:00:00Z",
  kind,
  message,
  payload,
});

export const useAppTheme = (theme: "light" | "dark" = "light") => {
  useLayoutEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = theme;
    r.dataset.density = "comfortable";
    r.dataset.nativeMaterial = "sidebar";
    r.dataset.surface = "main";
  }, [theme]);
};

export const GyroApp: React.FC<{
  sessions: ReturnType<typeof makeSessions>;
  events: ReturnType<typeof ev>[];
  draft?: string;
  width?: number;
  height?: number;
  companion?: boolean;
  theme?: "light" | "dark";
  chatProps?: Record<string, unknown>;
  chromeProps?: Record<string, unknown>;
  /** Milliseconds since the first user message, for live timers. */
  elapsedMs?: number;
  /** Replaces the chat surface inside the window chrome (CLI, review, grid…). */
  content?: React.ReactNode;
  className?: string;
}> = ({ elapsedMs = 0, content, className = "", sessions, events, draft = "", width = 1280, height = 800, companion = false, theme = "light", chatProps = {}, chromeProps = {} }) => {
  filmClock.ms = FILM_T0 + elapsedMs;
  useAppTheme(theme);
  const chat = (
      <ChatSurface
        events={events}
        config={config}
        sessionTitle={sessions[0].title}
        workspacePath="/Users/demo/aurora"
        sessionModel={sessions[0]}
        branchName="main"
        draft={draft}
        companionTabs={companion ? ["review"] : []}
        activeChatPanel={companion ? "review" : undefined}
        isToolPanelOpen={false}
        onDraftChange={noop}
        onSend={noop}
        onComposerAction={noop}
        onSelectChatPanel={noop}
        onOpenCompanionTab={noop}
        onCloseCompanionTab={noop}
        onCloseCompanionDock={noop}
        onShowCompanionLauncher={noop}
        onProviderApprovalAction={noop}
        onTogglePlanPanel={noop}
        {...(chatProps as object)}
      />
    );
  const app = (
      <AppChrome
        sessions={sessions}
        commandProfiles={config.commandProfiles}
        savedProjects={[{ path: "/Users/demo/aurora", label: "aurora" }]}
        activeSessionId={sessions[0].id}
        activeDestination="workspace"
        activeWorkspaceLayout="thread"
        workspacePath="/Users/demo/aurora"
        onSelectSession={noop}
        onSelectSessions={noop}
        onSelectWorkspaceLayout={noop}
        onSelectDestination={noop}
        onCreateSession={noop}
        onCreateCliSession={noop}
        onOpenCommandPalette={noop}
        onOpenSettings={noop}
        {...(chromeProps as object)}
      >
        {content ?? chat}
      </AppChrome>
  );
  return (
    <div
      className={"film-app " + className}
      style={{ width, height, minWidth: width, minHeight: height, flexShrink: 0, position: "relative", overflow: "hidden", borderRadius: 14, background: "var(--gyro-surface, #fff)" }}
    >
      {app}
    </div>
  );
};
