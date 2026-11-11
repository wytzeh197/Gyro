import { interpolate, useCurrentFrame } from "remotion";
import { FeatureFrame } from "../ui/parts";
import { C, cardStyle, mono, prog, rise, text } from "../ui/theme";

const GROUPS = [
  { name: "Chat", items: [["/help", "Browse every chat command"], ["/compact", "Condense earlier conversation"]] },
  { name: "Attach", items: [["/image", "Attach an image"], ["/file", "Attach a workspace file"]] },
  { name: "Workspace", items: [["/search", "Search workspace files"], ["/model", "Choose a provider and model"]] },
];

const MATCHES = [
  ["/model", "Choose a provider and model"],
  ["/compact", "Condense earlier conversation"],
  ["/permissions", "Change approval settings"],
];

const TYPE_SLASH = 14;
const TYPE_M = 58;
const ENTER = 112;

const Row: React.FC<{ cmd: string; desc: string; selected?: boolean; typed?: string }> = ({
  cmd,
  desc,
  selected,
  typed,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "baseline",
      gap: 18,
      padding: "11px 16px",
      borderRadius: 12,
      background: selected ? C.blueSoft : "transparent",
    }}
  >
    <span style={{ fontFamily: mono, fontSize: 25, color: C.ink, minWidth: 170 }}>
      {typed && cmd.startsWith(typed) ? (
        <>
          <span style={{ color: C.blue, fontWeight: 700 }}>{typed}</span>
          {cmd.slice(typed.length)}
        </>
      ) : (
        cmd
      )}
    </span>
    <span style={{ fontFamily: text, fontSize: 22, color: C.muted }}>{desc}</span>
  </div>
);

export const SlashVignette: React.FC = () => {
  const frame = useCurrentFrame();
  const open = prog(frame, TYPE_SLASH, TYPE_SLASH + 14);
  const filtered = prog(frame, TYPE_M, TYPE_M + 10);
  const press = interpolate(frame, [ENTER, ENTER + 4, ENTER + 12], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const draft = frame < TYPE_SLASH ? "" : frame < TYPE_M ? "/" : "/m";
  const caretOn = Math.floor(frame / 15) % 2 === 0;

  return (
    <>
      <div style={{ position: "relative", width: 820, height: 780, ...rise(frame, 2, 40, 24) }}>
        {/* Menu */}
        <div
          style={{
            ...cardStyle,
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 140,
            padding: 16,
            opacity: open,
            translate: `0px ${(1 - open) * 20}px`,
            transformOrigin: "bottom left",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: text,
              fontSize: 18,
              color: C.faint,
              padding: "4px 16px 10px",
            }}
          >
            <span style={{ fontWeight: 600, letterSpacing: 1.4, textTransform: "uppercase" }}>
              Commands
            </span>
            <span>↑↓ select · ↵ run · esc close</span>
          </div>

          <div style={{ position: "relative", height: 470 }}>
            {/* Unfiltered, grouped */}
            <div style={{ position: "absolute", inset: 0, opacity: 1 - filtered }}>
              {GROUPS.map((g) => (
                <div key={g.name} style={{ marginBottom: 6 }}>
                  <div
                    style={{
                      fontFamily: text,
                      fontSize: 18,
                      fontWeight: 600,
                      color: C.blue,
                      padding: "8px 16px 2px",
                    }}
                  >
                    {g.name}
                  </div>
                  {g.items.map(([cmd, desc], i) => (
                    <Row key={cmd} cmd={cmd} desc={desc} selected={g.name === "Chat" && i === 0} />
                  ))}
                </div>
              ))}
            </div>
            {/* Filtered for "/m": best match first */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: filtered,
                translate: `0px ${(1 - filtered) * 12}px`,
              }}
            >
              <div
                style={{
                  fontFamily: text,
                  fontSize: 18,
                  fontWeight: 600,
                  color: C.blue,
                  padding: "8px 16px 2px",
                }}
              >
                Best match
              </div>
              {MATCHES.map(([cmd, desc], i) => (
                <div
                  key={cmd}
                  style={{
                    ...rise(frame, TYPE_M + i * 4, 10, 12),
                    scale: i === 0 ? 1 + press * 0.015 : 1,
                  }}
                >
                  <Row cmd={cmd} desc={desc} selected={i === 0} typed="/m" />
                </div>
              ))}
              {/* Detail strip for the selected command */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "18px 18px",
                  borderTop: `1px solid ${C.line}`,
                  fontFamily: text,
                  fontSize: 22,
                  color: C.body,
                  ...rise(frame, TYPE_M + 14, 10, 14),
                }}
              >
                <span style={{ fontFamily: mono, color: C.ink, fontWeight: 600 }}>/model</span>
                <span style={{ flex: 1 }}>Choose a provider and model for this chat</span>
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 20,
                    padding: "4px 12px",
                    borderRadius: 8,
                    border: `1px solid ${C.line}`,
                    background: press > 0.1 ? C.blue : C.soft,
                    color: press > 0.1 ? "#fff" : C.muted,
                  }}
                >
                  ↵
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Composer */}
        <div
          style={{
            ...cardStyle,
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 112,
            display: "flex",
            alignItems: "center",
            padding: "0 30px",
            fontFamily: mono,
            fontSize: 30,
            color: C.ink,
          }}
        >
          {draft === "" ? (
            <span style={{ fontFamily: text, color: C.faint }}>Ask Gyro to change something…</span>
          ) : (
            draft
          )}
          <span
            style={{
              width: 3,
              height: 36,
              marginLeft: 3,
              background: C.blue,
              opacity: caretOn ? 1 : 0,
            }}
          />
        </div>
      </div>
    </>
  );
};

export const SlashMenu: React.FC = () => (
  <FeatureFrame
      index="02"
      kicker="Composer"
      title={<>A sharper slash menu.</>}
      body={<>Commands grouped by purpose. The best match comes first, so Enter runs what you typed.</>}
    >
    <SlashVignette />
  </FeatureFrame>
);
