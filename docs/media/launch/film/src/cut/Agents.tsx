// 23–27s. Three real chats, side by side, each on its own model.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { depthIn } from "../ui/motion";
import { Canvas, MonoLabel, WordBuild, drift } from "../ui/skale";
import { panes } from "./data";
import { Pane } from "./Pane";
import { useAppTheme } from "../app/GyroApp";

export const AGENTS = 120;
const CW = 540;
const CH = 738;
const X = [120, 690, 1260];
const AT = [0, 8, 16];

export const Agents: React.FC = () => {
  useAppTheme("light");
  const f = useCurrentFrame();
  const d = drift(f, 4);
  return (
    <AbsoluteFill>
      <Canvas />
      {X.map((x, i) => (
        <div key={i} style={{ position: "absolute", left: x + d.x, top: 210 + d.y, width: CW, height: CH, ...depthIn(f, AT[i]) }}>
          <div style={{ width: CW / 0.9, height: CH / 0.9, transform: "scale(0.9)", transformOrigin: "0 0", borderRadius: 16, overflow: "hidden", background: "#fff", boxShadow: "0 0 0 1px rgba(16,20,42,0.06), 0 30px 70px -30px rgba(16,20,42,0.35)" }}>
            <Pane i={i} t={f - AT[i] + 10} every={18} />
          </div>
        </div>
      ))}
      {X.map((x, i) => (
        <MonoLabel key={"l" + i} text={panes[i].modelId.toUpperCase()} at={24 + i * 6} x={x + CW / 2} y={170} />
      ))}
      <WordBuild words={["Run", "agents", "in", "parallel."]} at={40} size={80} y={90} keyword={3} keyAt={70} />
    </AbsoluteFill>
  );
};
