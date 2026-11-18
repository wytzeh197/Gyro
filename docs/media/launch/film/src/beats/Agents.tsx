import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Cursor } from "../ui/film";
import { Field, FieldName, Marquee, Slam, onField } from "../ui/bold";
import { C } from "../ui/theme";

// 21–25s. Bring the agent you already pay for: names slam in on hard colour cuts.
export const AGENTS = 120;
const names = ["Claude Code", "Codex", "Gemini CLI", "Grok", "Kimi", "Ollama", "Your own CLI."];
const fields: FieldName[] = ["blue", "coral", "white", "ink", "blue", "coral", "white"];
const START = 26;
const EVERY = 13;

export const Agents: React.FC = () => {
  const f = useCurrentFrame();
  if (f < START) {
    return (
      <Field color="ink">
        <Marquee text="BYO · BYO · BYO · BYO ·" y={-40} size={300} speed={12} outline color="rgba(125,144,255,0.4)" />
        <Marquee text="BYO · BYO · BYO · BYO ·" y={780} size={300} speed={-12} start={-2000} outline color="rgba(125,144,255,0.4)" />
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
          <Slam words={["Bring", "your"]} at={2} stagger={3} size={220} weight={850} />
          <Slam words={["own", { t: "agent.", color: "#8FA0FF" }]} at={8} stagger={3} size={220} weight={850} />
        </AbsoluteFill>
      </Field>
    );
  }
  const i = Math.min(names.length - 1, Math.floor((f - START) / EVERY));
  const at = START + i * EVERY;
  const field = fields[i];
  const fg = onField(field);
  const last = i === names.length - 1;
  return (
    <Field color={field}>
      <Marquee text={names.join(" · ").toUpperCase() + " ·"} y={40} size={150} speed={18} outline color={field === "white" ? "rgba(16,20,42,0.18)" : "rgba(255,255,255,0.28)"} />
      <Marquee text={names.join(" · ").toUpperCase() + " ·"} y={880} size={150} speed={-18} start={-3000} outline color={field === "white" ? "rgba(16,20,42,0.18)" : "rgba(255,255,255,0.28)"} />
      <div style={{ position: "absolute", top: 260, left: 0, right: 0, textAlign: "center", fontFamily: "'Geist Mono', monospace", fontSize: 40, fontWeight: 600, color: fg, opacity: 0.7 }}>
        {String(i + 1).padStart(2, "0")} / {String(names.length).padStart(2, "0")}
      </div>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 40 }}>
        <Slam key={i} words={[names[i]]} at={at} size={last ? 230 : 280} color={fg} weight={850} />
        <Cursor h={last ? 190 : 230} color={field === "blue" ? C.coral : C.blue} solid={!last} at={at} />
      </AbsoluteFill>
    </Field>
  );
};
