// Development-only production-component fixture. No native commands or models.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  ChatSurface,
  ProjectMemoryPanel,
  applyAppearancePreferences,
  type ProjectMemoryRuntime,
  type MemorySnapshot,
  type MemoryEntry,
  type MemoryCandidate,
  type ChatSidePanelId,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.density =
  params.get("density") === "compact" ? "compact" : "comfortable";
applyAppearancePreferences(
  document.documentElement,
  {
    interfaceSize: params.get("scale") === "large" ? "large" : "default",
    mainColor: "#ffffff",
    secondaryColor: "#ffffff",
    motionSpeed: "default",
  },
  theme,
);
const entry: MemoryEntry = {
  id: "mem_runtime",
  text: "Use the shared provider runtime for desktop and CLI execution.",
  date: "2026-11-10",
  kind: "decision",
  status: "active",
  sourceChanged: false,
  entryHash: "fixture-hash",
  paths: ["crates/gyro-core/src/provider_runtime"],
  sources: [{ kind: "user-entered" }],
};
let snapshot: MemorySnapshot = {
  rootId: "root-gyro",
  roots: [
    { id: "root-gyro", path: "/fixture/Gyro" },
    { id: "root-other", path: "/fixture/Other" },
  ],
  documentHash: "fixture-revision-1",
  entries:
    params.get("state") === "empty"
      ? []
      : [
          entry,
          {
            ...entry,
            id: "mem_tests",
            entryHash: "fixture-tests",
            text: "Run cargo test for the shared Rust engine and pnpm typecheck for the desktop UI.",
            kind: "command",
            paths: [],
          },
        ],
  total: 2,
  diagnostics: [],
  settings: { enabled: true, suggestions: true, maxBytes: 768, maxEntries: 4 },
};
if (params.get("root") === "single")
  snapshot.roots = snapshot.roots.slice(0, 1);
let revision = 1;
let candidates: MemoryCandidate[] =
  params.get("state") === "suggestions"
    ? [1, 2].map((index) => ({
        id: `candidate-${index}`,
        revision: 1,
        status: "pending",
        draft: {
          text: `Use the shared runtime for durable fixture decision ${index}.`,
          kind: "decision",
          paths: [],
          sources: [{ kind: "user-entered" }],
        },
        evidenceQuote: "From now on, use the shared runtime for this project.",
        sourceSessionId: "fixture-source",
        sourceTurnId: `fixture-turn-${index}`,
        sourceEventId: `fixture-event-${index}`,
      }))
    : [];
let listeners = new Set<() => void>();
const runtime: ProjectMemoryRuntime = {
  key: "fixture-memory",
  list: async (rootId, query) => {
    if (params.get("state") === "error")
      throw Error(
        "Fixture: project memory is unavailable. Reopen the project or retry.",
      );
    const entries = (rootId === "root-other" ? [] : snapshot.entries).filter(
      (entry) =>
        !query || entry.text.toLowerCase().includes(query.toLowerCase()),
    );
    return {
      ...snapshot,
      rootId: rootId ?? snapshot.rootId,
      entries,
      total: entries.length,
    };
  },
  save: async (rootId, expectedHash, draft, id) => {
    if (expectedHash !== snapshot.documentHash)
      throw Error(
        "Project memory changed on disk; reload before proposing an edit",
      );
    const next = {
      ...entry,
      ...draft,
      id: id ?? `mem_fixture_${revision}`,
      entryHash: `fixture-${revision}`,
    };
    snapshot = {
      ...snapshot,
      rootId,
      documentHash: `fixture-revision-${++revision}`,
      entries: id
        ? snapshot.entries.map((entry) => (entry.id === id ? next : entry))
        : [...snapshot.entries, next],
    };
    listeners.forEach((callback) => callback());
  },
  forget: async (_rootId, expectedHash, id) => {
    if (expectedHash !== snapshot.documentHash)
      throw Error(
        "Project memory changed on disk; reload before proposing an edit",
      );
    snapshot = {
      ...snapshot,
      documentHash: `fixture-revision-${++revision}`,
      entries: snapshot.entries.filter((entry) => entry.id !== id),
    };
    listeners.forEach((callback) => callback());
  },
  settings: async (_rootId, settings) => {
    snapshot = { ...snapshot, settings };
    return settings;
  },
  candidates: async () =>
    candidates.filter((candidate) =>
      ["pending", "accepting"].includes(candidate.status),
    ),
  accept: async (root, hash, candidate, draft) => {
    const current = candidates.find((item) => item.id === candidate.id);
    if (
      !current ||
      current.revision !== candidate.revision ||
      current.status !== "pending"
    )
      throw Error("Suggestion changed; reload");
    await runtime.save(root, hash, draft);
    candidates = candidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "accepted",
            revision: item.revision + 1,
            draft: null,
            evidenceQuote: null,
          }
        : item,
    );
    listeners.forEach((callback) => callback());
  },
  dismiss: async (_root, candidate) => {
    const current = candidates.find((item) => item.id === candidate.id);
    if (!current || current.revision !== candidate.revision)
      throw Error("Suggestion changed; reload");
    candidates = candidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "dismissed",
            revision: item.revision + 1,
            draft: null,
            evidenceQuote: null,
          }
        : item,
    );
    listeners.forEach((callback) => callback());
  },
  receipts: async () => [
    {
      turnId: "fixture-turn",
      providerId: "openai",
      receipt: {
        suppliedBytes: 180,
        estimatedTokens: 60,
        reusedCount: 0,
        delta: false,
        removedKeys: [],
        roots: [
          {
            rootId: "root-gyro",
            documentHash: "fixture-revision-1",
            omittedCount: 0,
            entries: [
              { id: entry.id, key: "fixture-ref", entryHash: entry.entryHash },
            ],
          },
        ],
      },
    },
  ],
  subscribe: (callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
function Fixture() {
  const [panel, setPanel] = useState<ChatSidePanelId | undefined>(
    params.has("shell") ? undefined : "memory",
  );
  const [draft, setDraft] = useState("");
  const width = Number(params.get("width")) || 420;
  const content = (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--gyro-app)",
        color: "var(--gyro-text)",
      }}
    >
      <nav
        aria-label="Fixture controls"
        style={{
          padding: "var(--gyro-space-standard)",
          display: "flex",
          gap: "var(--gyro-space-standard)",
        }}
      >
        <span>v0.1.2 · fixture data</span>
        <button
          onClick={() => {
            snapshot = {
              ...snapshot,
              documentHash: `fixture-revision-${++revision}`,
            };
            listeners.forEach((callback) => callback());
          }}
        >
          Simulate external edit
        </button>
      </nav>
      {params.has("chat") ? (
        <ChatSurface
          events={[]}
          config={{
            commandProfiles: [],
            modelProviders: [],
            requireCommandApproval: true,
            requireFileEditApproval: true,
            telemetryEnabled: false,
          }}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => {}}
          isComposerSending={false}
          sessionTitle="Project continuity"
          workspacePath="/fixture/Gyro"
          activeChatPanel={panel}
          companionTabs={["memory"]}
          projectMemory={runtime}
          onSelectChatPanel={setPanel}
          onOpenCompanionTab={setPanel}
          onCloseCompanionDock={() => setPanel(undefined)}
          onReopenCompanionDock={() => setPanel("memory")}
          shellReady
          isTiled={params.has("tiled")}
        />
      ) : (
        <div
          style={{
            width,
            maxWidth: "100%",
            minHeight: 0,
            flex: 1,
            borderInlineEnd: "1px solid var(--gyro-border-soft)",
          }}
        >
          <ProjectMemoryPanel runtime={runtime} />
        </div>
      )}
    </main>
  );
  return params.has("shell") ? (
    <AppChrome
      activeDestination="workspace"
      activeSessionId="memory-fixture"
      activeWorkspaceLayout="thread"
      commandProfiles={[]}
      savedProjects={[]}
      sessions={[
        {
          id: "memory-fixture",
          title: "Project continuity",
          workspacePath: "/fixture/Gyro",
          origin: "desktop",
          createdAt: "2026-11-11T10:00:00Z",
          updatedAt: "2026-11-11T10:00:00Z",
          eventsPath: "/fixture/session.jsonl",
        },
      ]}
      workspacePath="/fixture/Gyro"
      onCreateCliSession={() => {}}
      onCreateSession={() => {}}
      onOpenCommandPalette={() => {}}
      onOpenSettings={() => {}}
      onOpenToolPanel={() => {}}
      onOpenWorkspace={() => {}}
      onSelectDestination={() => {}}
      onSelectSession={() => setPanel(undefined)}
      projectSettings={{
        details: {},
        folders: {},
        pickFolder: async () => null,
        save: () => {},
        memory: () => runtime,
      }}
      onSelectSessions={() => {}}
      onSelectWorkspaceLayout={() => {}}
    >
      {content}
    </AppChrome>
  ) : (
    content
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Fixture />);
