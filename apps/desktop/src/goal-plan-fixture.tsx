// Isolated rendering fixture: no providers, native commands or saved chat data.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, type ChatSidePanelId, type SessionGoal, type SessionPlan } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const stamp = "2026-09-16T09:00:00Z";
// The transcript row times itself against now, so a seeded event from last week
// reads as a six-day run. Seed the turn a moment ago instead.
const recentStamp = new Date(Date.now() - 12_000).toISOString();
/**
 * A goal set six seconds ago. The strip carries an elapsed clock, and a goal
 * without timestamps renders none — which would hide the very line the fixture
 * exists to check.
 */
function goalFor(status: SessionGoal["status"]): SessionGoal {
  const now = Date.now();
  return {
    text: "Keep the outcome visible while planning and working.",
    status,
    createdAt: new Date(now - 6_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

function Fixture() {
  const [panel, setPanel] = useState<ChatSidePanelId | undefined>("plan");
  const [goal, setGoal] = useState<SessionGoal | undefined>(() => goalFor("active"));
  // The mark rotates only while a turn is running, so the fixture has to be
  // able to run one.
  const [running, setRunning] = useState(true);
  /**
   * The `/goal` and "+ → Goal" paths put the editor chip under the pointer, so
   * the fixture has to reach that state: the chip must open and close without
   * firing a native hover tooltip.
   */
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [plan, setPlan] = useState<SessionPlan>({
    title: "Unify goal and plan",
    content: "# Unify goal and plan\n\nKeep the outcome visible in both views.\n\n## Verification\n\nCheck both themes, blocked steps and goal controls.",
    items: [
      {id:"spec", title:"Define the status ramp", status:"complete", createdAt:stamp, updatedAt:stamp},
      {id:"build", title:"Unify goal controls", status:"in-progress", createdAt:stamp, updatedAt:stamp},
      {id:"verify", title:"Check both themes", status:"blocked", createdAt:stamp, updatedAt:stamp},
      {id:"notes", title:"Record the evidence", status:"todo", createdAt:stamp, updatedAt:stamp},
    ],
  });
  return <div style={{height:"100vh", display:"flex", flexDirection:"column"}}>
    <nav aria-label="Fixture controls" style={{display:"flex", gap:12, padding:8}}>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; }}>Toggle theme</button>
      <button onClick={() => setPanel(panel ? undefined : "plan")}>Toggle rail</button>
      <button onClick={() => setRunning(value => !value)}>Toggle running</button>
      <button onClick={() => setGoalEditorOpen(value => !value)}>Toggle goal editor</button>
      <button onClick={() => setGoal(goalFor("active"))}>Restore goal</button>
    </nav>
    <div style={{flex:1,minHeight:0}}>
      <ChatSurface
        events={[{id:"user", sessionId:"goal-plan-fixture", turnId:"turn", kind:"user-message", message:"Keep the goal and plan together.", createdAt:recentStamp, payload:{}}]}
        config={{commandProfiles:[],modelProviders:[],requireCommandApproval:true,requireFileEditApproval:true,telemetryEnabled:false}}
        sessionGoal={goal} sessionPlan={plan}
        isComposerSending={running}
        isGoalComposerActive={goalEditorOpen}
        onCancelGoalComposer={() => setGoalEditorOpen(false)}
        onComposerAction={(action) => { if (action === "add-goal") setGoalEditorOpen(true); }}
        activeChatPanel={panel} companionWidth={600}
        onSelectChatPanel={setPanel} onOpenCompanionTab={setPanel} onCloseCompanionDock={() => setPanel(undefined)}
        onGoalAction={(action, text) => setGoal(current => action === "clear" ? undefined : {
          text: text ?? current?.text ?? "",
          status: action === "complete" ? "complete" : "active",
          createdAt: current?.createdAt ?? goalFor("active").createdAt,
          updatedAt: new Date().toISOString(),
        })}
        onPlanItemStatusChange={(id,status) => setPlan(current => ({...current,items:current.items.map(item => item.id === id ? {...item,status} : item)}))}
        onSend={() => {}} shellReady
      />
    </div>
  </div>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
