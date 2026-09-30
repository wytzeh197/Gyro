// Development-only check page: the production chat surface walking through
// Plan mode (questions, the plan card with its implement dock, and the plan
// open in the panel) without the desktop bridge or a provider call.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  formatChatAnswers,
  providersForConfig,
  type ChatSidePanelId,
  type GyroConfig,
  type SessionEvent,
  type SessionPlan,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const emptyConfig: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: false,
  requireFileEditApproval: false,
  modelProviders: [],
  commandProfiles: [],
};
const config: GyroConfig = {
  ...emptyConfig,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(emptyConfig).map((provider) =>
    provider.id === "openai"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
};

const sessionId = "plan-mode-fixture";
const questions = {
  questions: [
    {
      question: "Which release should this plan target?",
      options: [
        {
          label: "v0.1.0 stable",
          detail:
            "Plan the first signed and notarized public release, including launch gates.",
          recommended: true,
        },
        {
          label: "Next Alpha",
          detail: "An incremental release after alpha.49.7 on the Alpha channel.",
        },
        {
          label: "Catalog-only update",
          detail: "A model catalog or site update without new app binaries.",
        },
      ],
    },
    {
      question: "How should the existing `v0.1.0` work enter the candidate?",
      options: [
        {
          label: "Review and merge",
          detail: "Split the uncommitted work into reviewed PRs first.",
          recommended: true,
        },
        {
          label: "Only proven fixes",
          detail: "Cherry-pick readiness fixes; defer UI and feature changes.",
        },
        {
          label: "Start from main",
          detail: "Treat the branch as exploratory and cut a fresh candidate.",
        },
      ],
    },
    {
      question: "How much launch activity belongs in this plan?",
      options: [
        {
          label: "Coordinated launch",
          detail: "Site, docs, launch film and announcement after the binaries.",
          recommended: true,
        },
        {
          label: "Quiet release",
          detail: "Ship verified binaries and docs; plan promotion separately.",
        },
      ],
    },
  ],
};

const planContent = `# Gyro v0.1.0 release plan

## Summary
Ship Gyro's first stable macOS release when the signing and product acceptance gates pass, then coordinate the public launch. There is no fixed date. The audience is macOS 14+ developers on Apple Silicon and Intel.

## Prepare the candidate
1. Review the eight uncommitted files on \`v0.1.0\` and merge approved work through reviewed PRs.
2. Cut \`release/v0.1.0\` from the updated \`main\`.
3. Align workspace, Cargo, Tauri, lockfile and Homebrew versions; add \`docs/releases/v0.1.0.md\`.

## Release gates
- **Distribution:** verify the Developer ID certificate and updater signing without exposing secrets.
- **Product:** clean-machine install and first run on Apple Silicon and Intel.
- **Preflight:** every command in \`docs/release.md\` passes against the exact candidate.

## Publish and launch
- Publish binaries and the Homebrew cask, then the site and announcement.`;

const plan: SessionPlan = {
  sessionId,
  title: "Plan",
  content: planContent,
  sourceTurnId: "turn-2",
  updatedAt: "2026-09-29T15:03:00Z",
  items: [
    "Review uncommitted v0.1.0 work",
    "Merge approved work through PRs",
    "Cut release/v0.1.0 from main",
    "Align release versions",
    "Verify signing and notarization",
    "Clean-machine acceptance",
    "Run release preflight",
    "Publish binaries and cask",
    "Launch site and announcement",
  ].map((title, index) => ({
    id: `step-${index + 1}`,
    title,
    status: "todo" as const,
    createdAt: "2026-09-29T15:03:00Z",
    updatedAt: "2026-09-29T15:03:00Z",
  })),
};

// Mid-implementation: three steps done, one running, one blocked.
const implementingPlan: SessionPlan = {
  ...plan,
  items: plan.items.map((item, index) =>
    index < 3
      ? { ...item, status: "complete" as const }
      : index === 3
        ? { ...item, status: "in-progress" as const }
        : index === 6
          ? { ...item, status: "blocked" as const }
          : item,
  ),
};

const at = (seconds: number) =>
  new Date(Date.parse("2026-09-29T15:00:00Z") + seconds * 1000).toISOString();

const askTurn: SessionEvent[] = [
  {
    id: "ask-user",
    sessionId,
    turnId: "turn-1",
    kind: "user-message",
    createdAt: at(0),
    message: "Plan a release",
    payload: {},
  },
  {
    id: "ask-response",
    sessionId,
    turnId: "turn-1",
    kind: "assistant-message",
    createdAt: at(40),
    message:
      "The repo has a documented release pipeline and the checkout is on `v0.1.0` with uncommitted work. A few decisions before I draft the plan.",
    payload: { kind: "provider-response", status: "done", questions },
  },
];

const planTurn: SessionEvent[] = [
  {
    id: "answers",
    sessionId,
    turnId: "turn-2",
    kind: "user-message",
    createdAt: at(60),
    message: formatChatAnswers([
      {
        question: "Which release should this plan target?",
        answer: "v0.1.0 stable",
      },
      {
        question: "How should the existing v0.1.0 work enter the candidate?",
        answer: "Review and merge",
      },
      { question: "How much launch activity belongs in this plan?" },
    ]),
    payload: {},
  },
  {
    id: "plan-response",
    sessionId,
    turnId: "turn-2",
    kind: "assistant-message",
    createdAt: at(180),
    message: planContent,
    payload: { kind: "provider-response", status: "done" },
  },
];

type Stage = "questions" | "plan" | "panel";

function Fixture() {
  const [stage, setStage] = useState<Stage>(
    (new URLSearchParams(location.search).get("stage") as Stage) ??
      "questions",
  );
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<ChatSidePanelId | undefined>(
    (new URLSearchParams(location.search).get("panel") as ChatSidePanelId) ??
      (stage === "panel" ? "plan" : undefined),
  );
  const events = stage === "questions" ? askTurn : [...askTurn, ...planTurn];
  return (
    <div className="gyro-workspace-route is-thread">
      <nav
        style={{
          display: "flex",
          gap: 6,
          left: 12,
          position: "fixed",
          top: 8,
          zIndex: 50,
        }}
      >
        {(["questions", "plan", "panel"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              setStage(value);
              setPanel(value === "panel" ? "plan" : undefined);
            }}
            type="button"
          >
            {value}
          </button>
        ))}
        <button
          onClick={() => {
            const root = document.documentElement;
            root.dataset.theme =
              root.dataset.theme === "light" ? "dark" : "light";
          }}
          type="button"
        >
          theme
        </button>
      </nav>
      <section className="gyro-workspace-primary" aria-label="Plan mode">
        <ChatSurface
          activeChatPanel={panel}
          chatMode="plan"
          config={config}
          events={events}
          sessionTitle="Plan a release"
          sessionPlan={
            stage === "questions"
              ? undefined
              : stage === "panel"
                ? implementingPlan
                : plan
          }
          paneKey="plan-mode-fixture"
          workspacePath="/Users/dev/Gyro"
          branchName="v0.1.0"
          sessionModel={{
            providerId: "openai",
            modelId: "gpt-6-astra",
            modelLabel: "GPT-6 Astra",
            reasoningEffort: "high",
          }}
          draft={draft}
          onDraftChange={setDraft}
          onComposerAction={() => {}}
          onPlanDecision={(decision) => {
            if (decision === "reject") setStage("plan");
            return true;
          }}
          onTogglePlanPanel={() =>
            setPanel((current) => (current === "plan" ? undefined : "plan"))
          }
          onSend={() => {}}
          onStopChat={() => {}}
        />
      </section>
    </div>
  );
}

document.documentElement.dataset.theme = "dark";
if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
