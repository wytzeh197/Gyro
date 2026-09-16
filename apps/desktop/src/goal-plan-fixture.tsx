// Isolated rendering fixture: no providers, native commands or saved chat data.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, type ChatSidePanelId, type SessionGoal, type SessionPlan } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const stamp = "2026-09-16T09:00:00Z";
function Fixture() {
  const [panel, setPanel] = useState<ChatSidePanelId | undefined>("plan");
  const [goal, setGoal] = useState<SessionGoal | undefined>({text: "Keep the outcome visible while planning and working.", status: "active"});
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
      <button onClick={() => setGoal({text:"Keep the outcome visible while planning and working.",status:"active"})}>Restore goal</button>
    </nav>
    <div style={{flex:1,minHeight:0}}>
      <ChatSurface
        events={[{id:"user", sessionId:"goal-plan-fixture", turnId:"turn", kind:"user-message", message:"Keep the goal and plan together.", createdAt:stamp, payload:{}}]}
        config={{commandProfiles:[],modelProviders:[],requireCommandApproval:true,requireFileEditApproval:true,telemetryEnabled:false}}
        sessionGoal={goal} sessionPlan={plan}
        activeChatPanel={panel} companionWidth={600}
        onSelectChatPanel={setPanel} onOpenCompanionTab={setPanel} onCloseCompanionDock={() => setPanel(undefined)}
        onGoalAction={(action, text) => setGoal(current => action === "clear" ? undefined : {text:text ?? current?.text ?? "",status:action === "complete" ? "complete" : "active"})}
        onPlanItemStatusChange={(id,status) => setPlan(current => ({...current,items:current.items.map(item => item.id === id ? {...item,status} : item)}))}
        onSend={() => {}} shellReady
      />
    </div>
  </div>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
