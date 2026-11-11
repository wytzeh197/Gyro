import { interpolate, useCurrentFrame } from "remotion";
import { Check, FeatureFrame, GyroMark } from "../ui/parts";
import { C, cardStyle, display, inOut, mono, prog, rise, text } from "../ui/theme";

const CLICK = 104;

const ModelChip: React.FC<{ label: string; color: string }> = ({ label, color }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "4px 12px",
      borderRadius: 999,
      background: C.soft,
      border: `1px solid ${C.line}`,
      fontFamily: text,
      fontSize: 18,
      fontWeight: 500,
      color: C.body,
    }}
  >
    <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
    {label}
  </span>
);

export const MenuBarVignette: React.FC = () => {
  const frame = useCurrentFrame();
  const drop = prog(frame, 16, 36);
  const approved = frame >= CLICK + 3;
  const pressed = interpolate(frame, [CLICK, CLICK + 3, CLICK + 9], [1, 0.94, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cursorP = prog(frame, 70, CLICK, inOut);
  const badge = approved ? 0 : 1;

  return (
    <>
      <div style={{ position: "relative", width: 820, height: 520, ...rise(frame, 0, 30, 22) }}>
        {/* macOS menu bar strip */}
        <div
          style={{
            position: "absolute",
            left: -40,
            right: -40,
            top: 0,
            height: 56,
            borderRadius: 14,
            background: "rgba(255,255,255,0.75)",
            border: `1px solid ${C.line}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 30,
            padding: "0 28px",
            fontFamily: text,
            fontSize: 21,
            fontWeight: 500,
            color: C.ink,
          }}
        >
          <div style={{ position: "relative", display: "flex" }}>
            <div
              style={{
                padding: "6px 8px",
                borderRadius: 8,
                background: drop > 0.5 ? "rgba(16,20,42,0.08)" : "transparent",
                display: "flex",
              }}
            >
              <GyroMark size={30} />
            </div>
            <span
              style={{
                position: "absolute",
                right: -2,
                top: -2,
                minWidth: 20,
                height: 20,
                borderRadius: 99,
                background: C.blue,
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                scale: badge === 0 ? 0 : 1,
              }}
            >
              2
            </span>
          </div>
          <span style={{ color: C.muted }}>◐</span>
          <span>Mon 9 Nov 14:32</span>
        </div>

        {/* Popover */}
        <div
          style={{
            ...cardStyle,
            position: "absolute",
            right: 150,
            top: 76,
            width: 640,
            padding: 18,
            opacity: drop,
            translate: `0px ${(1 - drop) * -18}px`,
            transformOrigin: "top right",
            scale: 0.96 + drop * 0.04,
          }}
        >
          {/* Approval */}
          <div style={{ padding: 18, borderRadius: 16, background: C.soft, ...rise(frame, 26, 12, 16) }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: display, fontWeight: 650, fontSize: 26, color: C.ink }}>
                Fix sync retries
              </span>
              <ModelChip label="Claude · Opus" color="#D97757" />
            </div>
            <div style={{ fontFamily: text, fontSize: 22, color: C.body, margin: "12px 0 16px" }}>
              Wants to edit <span style={{ fontFamily: mono, color: C.ink }}>src/sync.js</span>
              <span style={{ fontFamily: mono, color: C.green, marginLeft: 12 }}>+3</span>
              <span style={{ fontFamily: mono, color: C.red, marginLeft: 6 }}>−1</span>
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              {!approved && (
                <span
                  style={{
                    padding: "9px 20px",
                    borderRadius: 10,
                    border: `1px solid ${C.line}`,
                    background: "#fff",
                    fontFamily: text,
                    fontSize: 20,
                    fontWeight: 600,
                    color: C.body,
                  }}
                >
                  Deny
                </span>
              )}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 22px",
                  borderRadius: 10,
                  background: approved ? C.greenSoft : C.blue,
                  color: approved ? C.green : "#fff",
                  fontFamily: text,
                  fontSize: 20,
                  fontWeight: 600,
                  scale: pressed,
                }}
              >
                {approved ? (
                  <>
                    <Check size={22} draw={prog(frame, CLICK + 3, CLICK + 15)} /> Approved
                  </>
                ) : (
                  "Approve"
                )}
              </span>
            </div>
          </div>

          {/* Question */}
          <div style={{ padding: "20px 18px 10px", ...rise(frame, 34, 12, 16) }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: display, fontWeight: 650, fontSize: 24, color: C.ink }}>
                Landing hero copy
              </span>
              <ModelChip label="Codex" color="#10A37F" />
            </div>
            <div style={{ fontFamily: text, fontSize: 21, color: C.body, marginTop: 8 }}>
              <span style={{ color: C.amber, fontWeight: 600 }}>Question · </span>
              Keep the current headline or shorten it?
            </div>
          </div>

          {/* Working */}
          <div
            style={{
              padding: "16px 18px 6px",
              borderTop: `1px solid ${C.line}`,
              marginTop: 12,
              ...rise(frame, 42, 12, 16),
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: display, fontWeight: 650, fontSize: 24, color: C.ink }}>
                Split backend modules
              </span>
              <ModelChip label="Ollama · local" color="#6B7383" />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center" }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 99,
                    background: C.blue,
                    opacity: 0.3 + 0.7 * Math.max(0, Math.sin((frame - i * 5) / 6)),
                  }}
                />
              ))}
              <span style={{ fontFamily: text, fontSize: 20, color: C.muted, marginLeft: 8 }}>
                Working
              </span>
            </div>
          </div>
        </div>

        {/* Pointer */}
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          style={{
            position: "absolute",
            left: interpolate(cursorP, [0, 1], [790, 560]),
            top: interpolate(cursorP, [0, 1], [500, 218]),
            opacity: prog(frame, 64, 72) * (1 - prog(frame, CLICK + 24, CLICK + 34)),
            scale: pressed,
            filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.25))",
          }}
        >
          <path d="M4 2l15 10.5-6.6 1.2 3.9 7.1-2.6 1.4-3.9-7.2L4 19.6z" fill="#111" stroke="#fff" strokeWidth={1.4} />
        </svg>
      </div>
    </>
  );
};

export const MenuBar: React.FC = () => (
  <FeatureFrame
      index="03"
      kicker="Menu bar"
      title={<>Answer from the menu bar.</>}
      body={<>Approve edits and see waiting questions without hunting for the chat. Every chat shows its provider and model.</>}
    >
    <MenuBarVignette />
  </FeatureFrame>
);
