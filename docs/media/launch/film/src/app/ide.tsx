// The real IdeSurface with a static, highlighted editor (Monaco does not render in the film).
import { IdeSurface } from "@gyro-ui/surfaces.tsx";
import { files, terminalPanes } from "./fixtures";
import { mono } from "../ui/theme";

const W = "/Users/demo/aurora";
const noop = () => {};
const PATH = `${W}/src/cart/total.ts`;
export const CODE = `import type { Cart } from "./types";

/** Cents, so totals match the receipt. */
const cents = (n: number) => Math.round(n * 100) / 100;

export function cartTotal(cart: Cart): number {
  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discount = cents(cart.discounts.reduce((sum, d) => sum + d.amount, 0));
  return cents(subtotal - discount);
}
`;
const KW = /\b(import|type|from|const|export|function|return|number)\b/g;
const Line: React.FC<{ s: string; hl?: boolean }> = ({ s, hl }) => {
  const parts: React.ReactNode[] = [];
  if (s.trim().startsWith("/**")) return <span style={{ color: "#8A8FA3" }}>{s}</span>;
  let last = 0;
  const re = /("[^"]*")|\b(import|type|from|const|export|function|return|number)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    parts.push(s.slice(last, m.index));
    parts.push(<span key={m.index} style={{ color: m[1] ? "#2F9E62" : "#4F5BD5", fontWeight: m[1] ? 400 : 500 }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(s.slice(last));
  void KW; void hl;
  return <>{parts}</>;
};
const Editor: React.FC<{ hl: number[] }> = ({ hl }) => (
  <div style={{ fontFamily: mono, fontSize: 13, lineHeight: "22px", padding: "10px 0", color: "#1C2033", background: "var(--gyro-surface,#fff)", height: "100%" }}>
    {CODE.split("\n").map((s, i) => (
      <div key={i} style={{ display: "flex", whiteSpace: "pre", background: hl.includes(i + 1) ? "rgba(47,158,98,0.10)" : undefined }}>
        <span style={{ width: 48, textAlign: "right", paddingRight: 18, color: "#B4B8C6", flexShrink: 0 }}>{i + 1}</span>
        <span><Line s={s} /></span>
      </div>
    ))}
  </div>
);

export const ide = (t: number, hl: number[] = []) => (
  <IdeSurface
    files={files as never}
    workspacePath={W}
    selectedPath={PATH}
    fileContent={{ path: PATH, content: CODE } as never}
    fileLoadState="ready"
    editorTabs={[{ path: PATH, title: "total.ts", pinned: true }, { path: `${W}/src/cart/total.test.ts`, title: "total.test.ts" }] as never}
    renderEditor={() => <Editor hl={hl} />}
    onSelectFile={noop}
    terminalOutput=""
    activePaneTab="terminal"
    terminalPanes={terminalPanes(t).slice(3) as never}
    selectedTerminalPaneId="t4"
    terminalTemplate={1 as never}
    onPaneTabChange={noop}
  />
);
