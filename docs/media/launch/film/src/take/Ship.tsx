// "Your all-in-one stop for shipping your ___." The last word spins like a slot reel and lands on "idea".
import { useFrame } from "../pace";
import { AbsoluteFill, interpolate } from "remotion";
import { Block, line } from "../ui/skale";
import { C, out } from "../ui/theme";
import { clamp, p01 } from "./kit";

export const SHIP = 132;
const WORDS = ["checkout flow.", "CLI.", "SaaS.", "side project.", "idea."];
const L1 = "Your all-in-one stop";
const L2 = "for shipping your";
const SIZE = 96;
const REEL = [34, 44, 53, 61, 74]; // frame each word settles
const H = SIZE * 1.15;

export const Ship: React.FC = () => {
  const f = useFrame();
  const n1 = Math.min(L1.length, Math.max(0, Math.floor((f - 2) * 1.4)));
  const n2 = Math.min(L2.length, Math.max(0, Math.floor((f - 16) * 1.4)));
  const pos = interpolate(f, [30, ...REEL], [-1, 0, 1, 2, 3, 4], { ...clamp, easing: (t) => t });
  // Snap each word in with a little overshoot on the last.
  const settle = f >= REEL[4] ? 4 + Math.sin(p01(f, REEL[4], REEL[4] + 14) * Math.PI) * -0.06 * (1 - p01(f, REEL[4], REEL[4] + 14)) : pos;
  const under = p01(f, REEL[4] + 4, REEL[4] + 22, out);
  const exit = p01(f, SHIP - 22, SHIP - 4);
  const font: React.CSSProperties = { fontFamily: line, fontWeight: 500, fontSize: SIZE, letterSpacing: "-0.035em", lineHeight: `${H}px`, whiteSpace: "pre" };
  return (
    <AbsoluteFill style={{ background: "#fff", alignItems: "center", justifyContent: "center", opacity: 1 - exit, transform: `translateY(${-exit * 30}px)` }}>
      <div style={{ ...font, color: C.ink, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
        <span>{L1.slice(0, n1)}</span>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span>{L2.slice(0, n2) + (n2 === L2.length ? " " : "")}</span>
          {f < 30 && n2 > 0 && <Block h={SIZE * 0.92} at={0} solid={n2 < L2.length} color={C.blue} />}
          {f >= 30 && (
            <div style={{ position: "relative", height: H, overflow: "hidden", width: 760 }}>
              {WORDS.map((w, i) => {
                const d = i - settle;
                if (Math.abs(d) > 1.2) return null;
                const last = i === WORDS.length - 1;
                return (
                  <div key={w} style={{ position: "absolute", left: 0, top: d * H, color: last ? C.blue : C.ink, filter: f < REEL[4] ? `blur(${Math.min(6, Math.abs(d) * 10)}px)` : undefined }}>
                    {w}
                    {last && <div style={{ position: "absolute", left: 4, bottom: 10, height: 8, borderRadius: 4, width: `calc(${under} * (100% - 34px))`, background: C.blue }} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
