import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Cursor, Tiles } from "../ui/film";
import { Field, FieldName, Marquee, Slam, onField, INK } from "../ui/bold";
import { C, prog } from "../ui/theme";

// 0–4s. A cursor blinks, three surfaces slam in on hard colour cuts, then the
// cursor splits into the panels of the app.
export const HOOK = 120;
const G = 14;
const quads = [
  { x: 0, y: 0, w: 960 - G / 2, h: 540 - G / 2 },
  { x: 960 + G / 2, y: 0, w: 960 - G / 2, h: 540 - G / 2 },
  { x: 0, y: 540 + G / 2, w: 960 - G / 2, h: 540 - G / 2 },
  { x: 960 + G / 2, y: 540 + G / 2, w: 960 - G / 2, h: 540 - G / 2 },
];

const cuts: { at: number; end: number; field: FieldName; word: string; mq: string }[] = [
  { at: 14, end: 30, field: "blue", word: "Chat.", mq: "CHAT · CHAT · CHAT ·" },
  { at: 30, end: 46, field: "coral", word: "CLI.", mq: "CLI · CLI · CLI · CLI ·" },
  { at: 46, end: 62, field: "ink", word: "IDE.", mq: "IDE · IDE · IDE · IDE ·" },
];

export const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const cut = cuts.find((c) => f >= c.at && f < c.end);
  const gap = 1 - prog(f, 108, 118);

  if (f < 14) {
    return (
      <Field color="ink">
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <Cursor h={300} color={C.blue} style={{ scale: `${1 + Math.max(0, 8 - f) * 0.04}` }} />
        </AbsoluteFill>
      </Field>
    );
  }
  if (cut) {
    const fg = onField(cut.field);
    const ghost = cut.field === "ink" ? "rgba(125,144,255,0.22)" : "rgba(255,255,255,0.2)";
    return (
      <Field color={cut.field}>
        <Marquee text={cut.mq} y={-40} size={300} speed={14} color={ghost} outline />
        <Marquee text={cut.mq} y={780} size={300} speed={-14} start={-2400} color={ghost} outline />
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 40 }}>
          <Slam words={[cut.word]} at={cut.at} size={380} color={fg} weight={850} />
          <Cursor h={300} color={cut.field === "ink" ? C.blue : fg} solid />
        </AbsoluteFill>
      </Field>
    );
  }
  if (f < 94) {
    return (
      <Field color="white">
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 0 }}>
          <Slam words={["All", "in", "one"]} at={62} stagger={3} size={230} color={INK} weight={850} />
          <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
            <Slam words={[{ t: "place.", color: C.blue }]} at={71} size={230} color={INK} weight={850} />
            <Cursor h={190} color={C.coral} at={72} />
          </div>
        </AbsoluteFill>
      </Field>
    );
  }
  return (
    <Field color="white" grid={false}>
      <Tiles
        at={94}
        ox={1370}
        oy={640}
        len={14}
        stagger={2}
        radius={22 * gap}
        rects={quads.map((q, i) => ({
          x: q.x - (q.x > 0 ? (G / 2) * (1 - gap) : 0),
          y: q.y - (q.y > 0 ? (G / 2) * (1 - gap) : 0),
          w: q.w + (G / 2) * (1 - gap),
          h: q.h + (G / 2) * (1 - gap),
          color: gap > 0.02 ? [C.blue, C.coral, INK, C.blue][i] : C.blue,
        }))}
      />
    </Field>
  );
};
