import { useCurrentFrame } from "remotion";
import { Check, FeatureFrame } from "../ui/parts";
import { C, cardStyle, display, prog, rise, text } from "../ui/theme";

const Item: React.FC<{
  at: number;
  title: string;
  detail: React.ReactNode;
  children: React.ReactNode;
}> = ({ at, title, detail, children }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        ...cardStyle,
        padding: "24px 28px",
        display: "flex",
        gap: 22,
        alignItems: "flex-start",
        ...rise(frame, at, 34, 22),
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: 12,
          background: C.greenSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Check size={28} draw={prog(frame, at + 14, at + 28)} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: display, fontWeight: 650, fontSize: 30, color: C.ink }}>{title}</div>
        <div style={{ fontFamily: text, fontSize: 22, color: C.body, marginTop: 6, lineHeight: 1.4 }}>
          {detail}
        </div>
        <div style={{ marginTop: 16 }}>{children}</div>
      </div>
    </div>
  );
};

const Pill: React.FC<{ bg: string; fg: string; children: React.ReactNode }> = ({ bg, fg, children }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 14px",
      borderRadius: 999,
      background: bg,
      color: fg,
      fontFamily: text,
      fontSize: 19,
      fontWeight: 600,
      marginRight: 10,
    }}
  >
    {children}
  </span>
);

export const Reliability: React.FC = () => {
  return (
    <FeatureFrame
      index="04"
      kicker="Reliability"
      title={<>Fewer surprises mid-task.</>}
      body={<>Clearer chat delivery, provider recovery that tells you what to do, and steadier browser work.</>}
    >
      <div style={{ width: 860, display: "flex", flexDirection: "column", gap: 22 }}>
        <Item
          at={10}
          title="Queued messages keep their state"
          detail="A saved turn and an instruction that never started now look different, and saved failures aren’t replayed."
        >
          <Pill bg={C.greenSoft} fg={C.green}>● Saved</Pill>
          <Pill bg={C.amberSoft} fg={C.amber}>● Not started · Retry</Pill>
        </Item>
        <Item
          at={34}
          title="Provider limits come with guidance"
          detail="Quota categories are kept, with next steps for the provider you picked."
        >
          <Pill bg={C.soft} fg={C.body}>Usage limit reached</Pill>
          <Pill bg={C.blueSoft} fg={C.blue}>What you can do →</Pill>
        </Item>
        <Item
          at={58}
          title="Steadier in-app browser"
          detail="Navigation and event routing, form errors, and panel sizing on first reveal."
        >
          <Pill bg={C.soft} fg={C.body}>Navigation</Pill>
          <Pill bg={C.soft} fg={C.body}>Forms</Pill>
          <Pill bg={C.soft} fg={C.body}>Panel sizing</Pill>
        </Item>
      </div>
    </FeatureFrame>
  );
};
