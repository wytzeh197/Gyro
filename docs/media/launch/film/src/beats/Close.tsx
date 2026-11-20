import { AbsoluteFill, useCurrentFrame } from "remotion";
import { GyroMark } from "../ui/parts";
import { Cursor } from "../ui/film";
import { Field, FieldName, Flash, Marquee, Slam, INK, WHITE, onField } from "../ui/bold";
import { C, display, mono, prog } from "../ui/theme";

// 39–45s. The promise: one line per hard colour cut.
export const TAGS = 180;
const tags: { at: number; field: FieldName; words: string[]; mq: string }[] = [
  { at: 0, field: "blue", words: ["Any", "agent."], mq: "ANY AGENT ·" },
  { at: 56, field: "coral", words: ["Any", "surface."], mq: "ANY SURFACE ·" },
  { at: 112, field: "ink", words: ["Your", "machine."], mq: "YOUR MACHINE ·" },
];

export const Taglines: React.FC = () => {
  const f = useCurrentFrame();
  const k = tags.filter((t) => f >= t.at).length - 1;
  const t = tags[k];
  const fg = onField(t.field);
  const ghost = t.field === "ink" ? "rgba(125,144,255,0.35)" : "rgba(255,255,255,0.28)";
  const at = t.at + 4;
  return (
    <Field color={t.field}>
      <Marquee text={t.mq} y={-40} size={300} speed={10} outline color={ghost} />
      <Marquee text={t.mq} y={780} size={300} speed={-10} start={-2000} outline color={ghost} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 40 }}>
        <Slam key={k} words={[t.words[0], { t: t.words[1], color: t.field === "ink" ? "#8FA0FF" : undefined }]} at={at} stagger={4} size={260} color={fg} weight={850} out={k < 2 ? t.at + 46 : undefined} />
        {f >= at + 6 && (k === 2 || f < t.at + 46) && <Cursor h={210} color={t.field === "blue" ? C.coral : C.blue} at={at + 6} />}
      </AbsoluteFill>
      {k > 0 && <Flash at={t.at} color={WHITE} len={3} />}
    </Field>
  );
};

// 45–50s. Lockup on blue: the mark assembles, the cursor writes the address.
export const OUTRO = 150;
export const Outro: React.FC = () => {
  const f = useCurrentFrame();
  const url = "usegyro.io";
  const n = Math.max(0, Math.min(url.length, Math.floor((f - 52) / 2.5)));
  const pill = prog(f, 44, 56);
  return (
    <Field color="blue">
      <Marquee text="ANY AGENT · ANY SURFACE · YOUR MACHINE ·" y={30} size={120} speed={4} color="rgba(255,255,255,0.12)" />
      <Marquee text="ANY AGENT · ANY SURFACE · YOUR MACHINE ·" y={930} size={120} speed={-4} start={-2400} color="rgba(255,255,255,0.12)" />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 56 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
          <GyroMark size={230} assembleAt={2} color={WHITE} />
          <Slam words={["Gyro"]} at={22} size={260} color={WHITE} weight={850} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: WHITE,
            color: INK,
            border: `4px solid ${INK}`,
            borderRadius: 999,
            padding: "18px 44px",
            boxShadow: `10px 10px 0 ${INK}`,
            fontFamily: mono,
            fontWeight: 650,
            fontSize: 60,
            height: 104,
            scale: `${pill}`,
            rotate: `${(1 - pill) * -8 - 2}deg`,
          }}
        >
          <span>{url.slice(0, n)}</span>
          <Cursor h={58} color={C.coral} at={52} solid={n < url.length} />
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", bottom: 150, left: 0, right: 0, textAlign: "center", fontFamily: display, fontWeight: 700, fontSize: 40, letterSpacing: -1, color: WHITE, opacity: prog(f, 84, 100) }}>
        Chat. CLI. IDE. One app.
      </div>
    </Field>
  );
};
