// Work uses the retained film panels with one action per surface.
// Composer geometry follows packages/ui/src/chat.css and surfaces.tsx.
import { useFrame } from "../pace";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { ProviderLogo } from "@gyro-ui/workspace-sidebar.tsx";
import { ASK } from "../cut/data";
import { Check } from "../ui/parts";
import { Block, line } from "../ui/skale";
import { C, mono, out, text } from "../ui/theme";
import { Key, Stripes, TakeCam, TakePointer, camAt, p01, toScreen } from "./kit";

const AX = 320, AY = 140, AW = 1280, AH = 800;
export const SIDE = "#F5F6F8";

// ---- Beats ---------------------------------------------------------------
const TYPE = 24, MODEL = 62, PICK = 84, SEND = 102, STEP0 = 122, CARD = 180, APPROVE = 212, COLLAPSE = 236, REPLY = 244, EDITED = 300;
const NEWS = 356, OPENP = 374, CLI0 = 406, PLUS = [432, 456, 480];
const CODEBTN = 614, FILE = 654, EDIT = 696, TEST = 804, DIFF = 872;


// ---- Small UI parts ------------------------------------------------------
export const abs = (x: number, y: number, s: React.CSSProperties = {}): React.CSSProperties => ({ position: "absolute", left: x, top: y, ...s });
export const ui = (size = 13, color: string = C.ink, weight = 400): React.CSSProperties => ({ fontFamily: text, fontSize: size, color, fontWeight: weight, whiteSpace: "pre", lineHeight: 1.25 });
const codeFont = (size = 13, color: string = C.ink): React.CSSProperties => ({ fontFamily: mono, fontSize: size, color, whiteSpace: "pre" });

export const I: React.FC<{ d: string; size?: number; color?: string; w?: number }> = ({ d, size = 15, color = "currentColor", w = 1.6 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flex: "none" }}>
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
);
export const ic = {
  plus: "M12 5v14|M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|M20 20l-4-4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5",
  pencil: "M4 20h4L19 9l-4-4L4 16z|M13.5 6.5l4 4",
  term: "M4 17l6-5-6-5|M12 19h8",
  chat: "M5 18l-2 3V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z",
  code: "M8 8l-4 4 4 4|M16 8l4 4-4 4",
  side: "M4 5h16v14H4z|M9 5v14",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
  down: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  left: "M15 6l-6 6 6 6",
  up: "M12 19V5|M6 11l6-6 6 6",
  copy: "M9 9h10v10H9z|M5 15V5h10",
  undo: "M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12|M11 11V4.5a1.5 1.5 0 0 1 3 0V12|M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 15.5a1.5 1.5 0 0 1 2.3-1.9L8 16",
  branch: "M6 3v12|M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 9a9 9 0 0 1-9 9",
  dots: "M5 12h.01|M12 12h.01|M19 12h.01",
  sliders: "M4 6h10|M18 6h2|M4 18h4|M12 18h8|M16 4v4|M10 16v4",
};

export const Logo: React.FC<{ id: string; size?: number }> = ({ id, size = 14 }) => (
  <span className="wk-logo" style={{ display: "inline-block", width: size, height: size, flex: "none", color: id === "anthropic" ? "#D97757" : C.ink }}>
    <ProviderLogo providerId={id as never} label={id} />
  </span>
);

export const Traffic: React.FC = () => (
  <div style={abs(18, 15, { display: "flex", gap: 8 })}>
    {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.12)" }} />)}
  </div>
);

export const Segmented: React.FC<{ active: "chat" | "code"; press?: number }> = ({ active, press = 0 }) => (
  <>
    <div style={abs(84, 13, { color: C.muted })}><I d={ic.side} size={16} /></div>
    <div style={abs(114, 9, { width: 76, height: 26, borderRadius: 8, background: "rgba(16,20,42,0.05)", display: "flex", alignItems: "center", padding: 2, gap: 2 })}>
      {(["chat", "code"] as const).map((k) => (
        <div key={k} style={{ flex: 1, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: active === k ? C.ink : C.faint, background: active === k ? "#fff" : k === "code" && press ? `rgba(255,255,255,${press})` : "transparent", boxShadow: active === k ? "0 1px 2px rgba(16,20,42,0.12)" : undefined }}>
          <I d={k === "chat" ? ic.chat : ic.code} size={14} />
        </div>
      ))}
    </div>
  </>
);

export const Row: React.FC<{ y: number; icon: string; label: string; right?: string; on?: number }> = ({ y, icon, label, right, on = 0 }) => (
  <div style={abs(12, y - 14, { width: 190, height: 28, borderRadius: 8, background: `rgba(16,20,42,${0.06 * on})`, display: "flex", alignItems: "center", gap: 9, padding: "0 10px", boxSizing: "border-box", color: C.body })}>
    <I d={icon} size={15} />
    <span style={ui(13, C.ink)}>{label}</span>
    {right && <span style={{ ...ui(11, C.faint), marginLeft: "auto" }}>{right}</span>}
  </div>
);

// Streams `segs` left to right, `n` characters in.
export type Seg = { t: string; s?: React.CSSProperties };
export const Stream: React.FC<{ segs: Seg[]; n: number }> = ({ segs, n }) => {
  let left = n;
  return (
    <>
      {segs.map((g, i) => {
        const k = Math.max(0, Math.min(g.t.length, left));
        left -= g.t.length;
        return k > 0 ? <span key={i} style={g.s}>{g.t.slice(0, k)}</span> : null;
      })}
    </>
  );
};

// ---- Chat ------------------------------------------------------------------
const CL = 400, CW = 693;
const MODEL_LIST = [
  { id: "anthropic", name: "Claude Opus 5.5" },
  { id: "openai", name: "GPT-5.6 Sol" },
  { id: "anthropic", name: "Claude Sonnet 5.5" },
];
const STEPS = [
  { icon: ic.search, label: "Searched for cartTotal", detail: "4 results" },
  { icon: ic.file, label: "Read src/cart/total.ts" },
  { icon: ic.pencil, label: "Edited src/cart/total.ts", add: 6, del: 2 },
  { icon: ic.term, label: "Ran pnpm test cart", detail: "12 passed" },
];
const REPLY_SEGS: Seg[] = [
  { t: "Fixed. Discounts are now rounded to cents before the total is summed, so checkout matches the receipt. Added a regression test (12 passing) and opened " },
  { t: "PR #214", s: { fontWeight: 600, color: C.ink } },
  { t: " against " },
  { t: "main", s: { fontFamily: mono, fontSize: 12, background: C.soft, borderRadius: 4, padding: "1px 4px" } },
  { t: "." },
];
const REPLY_LEN = REPLY_SEGS.reduce((n, s) => n + s.t.length, 0);
const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

const ChatPanel: React.FC<{ f: number; demo?: number }> = ({ f, demo }) => {
  const sent = demo === undefined && f >= SEND + 2;
  const prompt = demo === undefined ? ASK : "Fix the checkout bug and open a PR.";
  const typed = sent ? "" : prompt.slice(0, Math.max(0, Math.floor(demo === undefined ? (f - TYPE) * 1.2 : (demo - 124) * 2.0)));
  const menu = demo === undefined ? p01(f, MODEL + 2, MODEL + 10, out) * (1 - p01(f, PICK + 2, PICK + 8)) : p01(demo, 99, 103, out) * (1 - p01(demo, 115, 119));
  const model = (demo === undefined ? f >= PICK + 2 : demo >= 115) ? 0 : demo === undefined ? 1 : 2;
  const working = sent && f < COLLAPSE;
  const secs = Math.floor(Math.max(0, Math.min(f, COLLAPSE) - SEND) * 0.5);
  const nSteps = sent ? Math.max(0, Math.min(STEPS.length, Math.floor((f - STEP0) / 14) + 1)) : 0;
  const card = p01(f, CARD, CARD + 12, out);
  const approved = f >= APPROVE + 2;
  const col = p01(f, COLLAPSE, COLLAPSE + 16);
  const replyN = Math.max(0, Math.floor((f - REPLY) * 3.6));
  const edited = p01(f, EDITED, EDITED + 14, out);
  const newRow = p01(f, SEND + 2, SEND + 16, out);
  const menuNew = p01(f, NEWS + 2, NEWS + 10, out) * (1 - p01(f, OPENP + 2, OPENP + 6));
  const stepsH = (4 * 30 + 8 + 168 * card) * (1 - col);
  return (
    <div style={abs(0, 0, { width: AW, height: AH, background: "#fff", overflow: "hidden" })}>
      {/* Sidebar */}
      <div style={abs(0, 0, { width: 214, height: AH, background: SIDE, borderRight: `1px solid ${C.line}` })}>
        <Segmented active="chat" />
        <Row y={56} icon={ic.plus} label="New Session" on={f >= NEWS && f < OPENP + 4 ? 1 : 0} />
        <Row y={84} icon={ic.search} label="Search" right="⌘K" />
        <Row y={113} icon={ic.clock} label="Automations" />
        <div style={abs(22, 141, ui(11, C.faint, 500))}>Projects</div>
        <div style={abs(22, 168, { display: "flex", gap: 8, alignItems: "center", color: C.muted })}>
          <I d={ic.folder} size={14} />
          <span style={ui(13, C.ink, 500)}>aurora</span>
        </div>
        {[
          { t: "Fix the checkout bug", id: "anthropic", age: "now", fresh: true },
          { t: "Fix flaky editor file tests", id: "anthropic", age: "4h" },
          { t: "Audit provider arguments", id: "openai", age: "11h" },
        ].map((s, i) => {
          const y = 208 + (i - 1 + (s.fresh ? 1 : newRow)) * 29;
          const op = s.fresh ? newRow : 1;
          return (
            <div key={s.t} style={abs(16, y - 14, { width: 189, height: 28, borderRadius: 8, display: "flex", alignItems: "center", gap: 8, padding: "0 10px 0 22px", boxSizing: "border-box", opacity: op, background: s.fresh ? "rgba(16,20,42,0.06)" : undefined })}>
              <Logo id={s.id} size={12} />
              <span style={{ ...ui(12.5, C.ink), overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{s.t}</span>
              {s.fresh && working ? <div style={{ width: 6, height: 6, borderRadius: 3, background: C.blue, opacity: 0.5 + 0.5 * Math.sin(f / 4) }} /> : <span style={ui(11, C.faint)}>{s.age}</span>}
            </div>
          );
        })}
        <div style={abs(22, 300 + 29 * newRow, ui(11, C.faint, 500))}>Recents</div>
        <div style={abs(22, 322 + 29 * newRow, ui(12, C.faint))}>No chats yet</div>
        <div style={abs(0, 753, { width: 214, borderTop: `1px solid ${C.line}` })} />
        <Row y={776} icon={ic.gear} label="Settings" />
      </div>
      {/* Header */}
      <div style={abs(214, 0, { width: AW - 214, height: 43, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", boxSizing: "border-box", color: C.muted })}>
        <I d={ic.folder} size={14} />
        <span style={ui(13, C.ink, 500)}>{sent ? "Fix the checkout bug" : "aurora"}</span>
        <I d={ic.dots} size={16} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 14 }}><I d={ic.sliders} size={15} /><I d={ic.side} size={15} /></div>
      </div>
      {/* Thread */}
      {sent && (
        <div style={abs(CL, 0, { width: CW, height: 670 })}>
          <div style={abs(0, 62, { width: CW, display: "flex", justifyContent: "flex-end", opacity: p01(f, SEND + 2, SEND + 10, out), transform: `translateY(${(1 - p01(f, SEND + 2, SEND + 14, out)) * 14}px)` })}>
            <div style={{ ...ui(13, C.ink), background: "#F0F2F5", borderRadius: 14, padding: "12px 16px" }}>{ASK}</div>
          </div>
          <div style={abs(0, 122, { width: CW, display: "flex", alignItems: "center", gap: 6, opacity: p01(f, STEP0 - 8, STEP0, out) })}>
            {working ? (
              <span style={{ ...ui(13, C.muted, 500), backgroundImage: `linear-gradient(90deg, ${C.faint} 0%, ${C.ink} ${((f * 4) % 160) - 30}%, ${C.faint} 100%)`, WebkitBackgroundClip: "text", color: "transparent" }}>{`Working for ${fmt(secs)}`}</span>
            ) : (
              <span style={{ ...ui(13, C.muted, 500), display: "flex", alignItems: "center", gap: 4 }}>{`Worked for ${fmt(secs)}`}<I d={ic.down} size={13} /></span>
            )}
            <div style={{ flex: 1, height: 1, background: C.line, marginLeft: 10 }} />
          </div>
          <div style={abs(0, 150, { width: CW, height: stepsH, overflow: "hidden", opacity: 1 - col })}>
            {STEPS.slice(0, nSteps).map((s, i) => {
              const a = p01(f, STEP0 + i * 14, STEP0 + i * 14 + 10, out);
              return (
                <div key={s.label} style={abs(0, i * 30, { display: "flex", alignItems: "center", gap: 9, color: C.muted, opacity: a, transform: `translateX(${(1 - a) * -12}px)` })}>
                  <I d={s.icon} size={14} />
                  <span style={ui(13, C.body)}>{s.label}</span>
                  {s.detail && <span style={ui(12.5, C.faint)}>{s.detail}</span>}
                  {s.add && <span style={{ ...ui(12.5, "#2F9E62", 500) }}>+{s.add}</span>}
                  {s.del && <span style={{ ...ui(12.5, C.red, 500) }}>−{s.del}</span>}
                  <I d={ic.right} size={12} />
                </div>
              );
            })}
            {card > 0 && (
              <div style={abs(0, 128, { width: CW, height: 160, boxSizing: "border-box", borderRadius: 14, border: `1px solid ${approved ? C.line : "#EAD7B4"}`, background: "#fff", boxShadow: "0 1px 2px rgba(16,20,42,0.04), 0 10px 30px -14px rgba(16,20,42,0.18)", padding: "14px 16px", opacity: card, transform: `translateY(${(1 - card) * 16}px) scale(${0.98 + 0.02 * card})` })}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.body }}>
                  <I d={ic.term} size={15} />
                  <span style={ui(13.5, C.ink, 600)}>Run gh pr create</span>
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                    {approved ? (
                      <><Check size={15} color="#2F9E62" draw={p01(f, APPROVE + 2, APPROVE + 12, out)} /><span style={ui(12, "#2F9E62", 500)}>Approved</span></>
                    ) : (
                      <><div style={{ width: 7, height: 7, borderRadius: 4, background: C.amber, opacity: 0.55 + 0.45 * Math.sin(f / 3) }} /><span style={ui(12, C.amber, 500)}>Waiting for your approval</span></>
                    )}
                  </div>
                </div>
                <div style={{ ...ui(12.5, C.muted), marginTop: 6 }}>Open a pull request with the fix</div>
                <div style={{ ...codeFont(12, C.ink), marginTop: 10, background: C.soft, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}>gh pr create --fill --base main</div>
                <div style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
                  <span style={ui(11.5, C.faint)}>In /Users/demo/aurora</span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, opacity: 1 - p01(f, APPROVE + 4, APPROVE + 12) }}>
                    <div style={{ ...ui(12.5, C.ink, 500), border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 14px" }}>Reject</div>
                    <div style={{ ...ui(12.5, "#fff", 500), background: C.ink, borderRadius: 8, padding: "6px 14px", transform: `scale(${f >= APPROVE && f < APPROVE + 5 ? 0.95 : 1})` }}>Approve</div>
                  </div>
                </div>
              </div>
            )}
          </div>
          {f >= REPLY && (
            <div style={abs(0, 150 + stepsH * 0 + 6, { width: CW, ...ui(13.5, C.body), whiteSpace: "normal", lineHeight: 1.6 })}>
              <Stream segs={REPLY_SEGS} n={replyN} />
              {replyN < REPLY_LEN && <span style={{ display: "inline-block", width: 7, height: 14, background: C.ink, marginLeft: 2, verticalAlign: "-2px", opacity: 0.7 }} />}
              {replyN >= REPLY_LEN && <div style={{ marginTop: 8, color: C.faint, opacity: p01(f, EDITED - 10, EDITED) }}><I d={ic.copy} size={13} /></div>}
            </div>
          )}
          {edited > 0 && (
            <div style={abs(0, 262, { width: CW, boxSizing: "border-box", borderRadius: 14, border: `1px solid ${C.line}`, background: "#fff", opacity: edited, transform: `translateY(${(1 - edited) * 14}px)`, overflow: "hidden" })}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, color: C.muted }}>
                <I d={ic.file} size={14} />
                <span style={ui(13, C.ink, 500)}>Edited 1 file</span>
                <span style={ui(12.5, "#2F9E62", 500)}>+6</span>
                <span style={ui(12.5, C.red, 500)}>−2</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <div style={{ ...ui(12, C.ink, 500), border: `1px solid ${C.line}`, borderRadius: 7, padding: "4px 10px", display: "flex", gap: 5, alignItems: "center" }}>Undo<I d={ic.undo} size={12} /></div>
                  <div style={{ ...ui(12, C.ink, 500), border: `1px solid ${C.line}`, borderRadius: 7, padding: "4px 10px" }}>Review</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}>
                <span style={codeFont(12, C.body)}>src/cart/total.ts</span>
                <span style={{ ...ui(12, "#2F9E62", 500), marginLeft: "auto" }}>+6</span>
                <span style={ui(12, C.red, 500)}>−2</span>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Current composer: context, rounded input, independent toolbar (chat.css). */}
      <div style={abs(CL, 655, { width: CW, height: 128 })}>
        <div style={abs(8, 0, { display: "flex", alignItems: "center", gap: 7, color: C.muted })}>
          <I d={ic.folder} size={13} /><span style={ui(12, C.muted)}>aurora</span><I d={ic.down} size={11} />
        </div>
        <div style={abs(0, 26, { width: CW, height: 58, borderRadius: 16, border: `1px solid ${C.line}`, background: "#fff", boxSizing: "border-box", padding: 16, display: "flex", alignItems: "center" })}>
          <span style={ui(13.5, typed ? C.ink : C.faint)}>{typed || "Describe a task or attach images"}</span>
          {typed && <Block h={16} at={118} solid={typed.length < prompt.length} color={C.blue} />}
        </div>
        <div style={abs(4, 94, { display: "flex", alignItems: "center", gap: 12, color: C.muted })}>
          <I d={ic.plus} size={17} />
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}><I d={ic.hand} size={14} /><span style={ui(12, C.muted)}>Ask for approval</span><I d={ic.down} size={12} /></div>
        </div>
        <div style={abs(CW - 300, 90, { height: 28, display: "flex", alignItems: "center", gap: 7, padding: "0 8px", borderRadius: 99, background: menu > 0.01 ? C.soft : undefined, color: C.muted })}>
          <Logo id={MODEL_LIST[model].id} size={15} />
          <span style={ui(12, C.ink, 500)}>{MODEL_LIST[model].name}</span><I d={ic.down} size={12} />
        </div>
        <div style={abs(CW - 104, 90, { height: 28, display: "flex", alignItems: "center", gap: 7, color: C.muted })}>
          <span style={ui(12, C.ink, 500)}>High</span><I d={ic.down} size={12} />
        </div>
        <div style={abs(CW - 32, 90, { width: 28, height: 28, borderRadius: 14, background: typed.length === prompt.length ? C.ink : C.soft, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${demo !== undefined ? 1 + 0.22 * Math.sin(Math.PI * p01(demo, 144, 147, (t) => t)) : 1})` })}>
          <I d={ic.up} size={14} color={typed.length === prompt.length ? "#fff" : C.faint} w={2} />
        </div>
        {menu > 0.01 && (
          <div style={abs(CW - 380, -245, { width: 348, height: 322, display: "flex", borderRadius: 12, background: "#fff", border: `1px solid ${C.line}`, boxShadow: "0 18px 40px -12px rgba(16,20,42,0.28)", opacity: menu, transform: `translateY(${(1 - menu) * 8}px)`, overflow: "hidden" })}>
            <div style={{ width: 52, background: SIDE, padding: "10px 6px", boxSizing: "border-box", borderRight: `1px solid ${C.line}` }}>
              {["anthropic", "openai", "xai", "deepseek", "kimi", "gemini", "ollama"].map(id => <div key={id} style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: id === "anthropic" ? "#fff" : undefined }}><Logo id={id} size={19} /></div>)}
            </div>
            <div style={{ flex: 1, padding: 12 }}>
              <div style={ui(14, C.ink, 600)}>Anthropic</div>
              <div style={{ ...ui(11, C.muted), marginTop: 5 }}>API · 2 models</div>
              <div style={{ ...ui(11, C.faint, 500), marginTop: 22, marginBottom: 8 }}>Opus</div>
              <div style={{ height: 36, display: "flex", alignItems: "center", padding: "0 8px", borderRadius: 8, background: C.soft, ...ui(13, C.ink, 500) }}>Claude Opus 5.5</div>
              <div style={{ ...ui(11, C.faint, 500), marginTop: 18, marginBottom: 8 }}>Sonnet</div>
              <div style={{ ...ui(13, C.ink), padding: "10px 8px" }}>Claude Sonnet 5.5</div>
            </div>
          </div>
        )}
      </div>
      {/* New session menu */}
      {menuNew > 0.01 && (
        <div style={abs(12, 72, { width: 236, boxSizing: "border-box", padding: 5, borderRadius: 12, background: "#fff", border: `1px solid ${C.line}`, boxShadow: "0 18px 40px -12px rgba(16,20,42,0.28)", opacity: menuNew, transform: `translateY(${(1 - menuNew) * -8}px)`, zIndex: 5 })}>
          <div style={{ height: 32, display: "flex", alignItems: "center", gap: 9, padding: "0 10px", color: C.body }}><I d={ic.chat} size={14} /><span style={ui(13, C.ink)}>New Chat</span></div>
          <div style={{ height: 1, background: C.line, margin: "4px 6px" }} />
          <div style={{ ...ui(11, C.faint, 500), padding: "6px 10px 4px" }}>CLI sessions</div>
          <div style={{ borderRadius: 8, display: "flex", alignItems: "center", gap: 9, padding: "7px 10px", color: C.body, background: f >= OPENP - 6 ? "rgba(66,92,235,0.08)" : undefined }}>
            <I d={ic.term} size={14} />
            <div><div style={ui(13, C.ink)}>Open project</div><div style={{ ...ui(11, C.faint), marginTop: 2 }}>Choose where the CLI should run</div></div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---- CLI -----------------------------------------------------------------
const GX = 428, GY = 82, GW = 844, GH = 710, GAP = 8;
type R = [number, number, number, number];
const rects = (n: number): R[] => {
  if (n <= 1) return [[0, 0, GW, GH]];
  if (n <= 3) {
    const w = (GW - GAP * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => [i * (w + GAP), 0, w, GH] as R);
  }
  const w = (GW - GAP) / 2, h = (GH - GAP) / 2;
  return [[0, 0, w, h], [w + GAP, 0, w, h], [0, h + GAP, w, h], [w + GAP, h + GAP, w, h]];
};
type L = [number, string, string?];
const PANES: { name: string; sub: string; cmd: string; at: number; lines: L[] }[] = [
  { name: "claude", sub: "claude", cmd: "claude", at: CLI0, lines: [
    [16, "> Fix the checkout bug and open a PR.", C.ink], [30, "● Searched for cartTotal · 4 results"], [44, "● Read src/cart/total.ts"],
    [60, "● Edited src/cart/total.ts  +6 −2"], [80, "● Ran pnpm test cart · 12 passed"], [100, "● Opened PR #214"], [142, "✓ Done in 1m 12s", "#2F9E62"],
  ] },
  { name: "codex", sub: "codex", cmd: "codex", at: PLUS[0] + 2, lines: [
    [16, "> Audit provider arguments for unsafe flags.", C.ink], [34, "• Scanned src/providers"], [56, "• Patched src/providers/args.ts"], [150, "✓ 0 unsafe flags remain", "#2F9E62"],
  ] },
  { name: "gemini", sub: "gemini", cmd: "gemini", at: PLUS[1] + 2, lines: [
    [16, "> Write release notes from main..HEAD.", C.ink], [34, "• Read 23 commits"], [58, "• Wrote CHANGELOG.md"], [96, "✓ Ready for review", "#2F9E62"],
  ] },
  { name: "dev server", sub: "shell", cmd: "pnpm dev", at: PLUS[2] + 2, lines: [
    [16, "VITE v6.2.0  ready in 412 ms", "#2F9E62"], [22, "➜  Local:   http://localhost:5173/"], [28, "➜  press h + enter to show help", C.faint],
    [56, "[vite] hmr update /src/cart/total.ts", C.muted], [84, "[vite] hmr update /src/cart/total.ts (x2)", C.muted],
  ] },
];

const TermPane: React.FC<{ f: number; i: number; r: R; focus: boolean; commandOnly?: boolean }> = ({ f, i, r, focus, commandOnly }) => {
  const p = commandOnly && i === 2 ? { ...PANES[i], name: "terminal", cmd: "git status", lines: [] } : PANES[i];
  const t = f - p.at;
  const typed = p.cmd.slice(0, Math.max(0, Math.floor((t - 4) * 0.7)));
  const ran = !commandOnly && t >= 6 + p.cmd.length / 0.7;
  const shown = (commandOnly ? [] : p.lines).filter(([d]) => t >= d + 6);
  const busy = ran && shown.length < p.lines.length && i < 3;
  return (
    <div style={abs(r[0], r[1], { width: r[2], height: r[3], borderRadius: 10, background: "#fff", border: `1px solid ${focus ? "#C9CEF5" : C.line}`, boxSizing: "border-box", overflow: "hidden" })}>
      <div style={{ height: 30, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: `1px solid ${C.line}`, background: "#FAFAFC" }}>
        <div style={{ width: 6, height: 6, borderRadius: 3, background: "#2F9E62" }} />
        <span style={ui(12, C.ink, 500)}>{p.name}</span>
        <span style={codeFont(11, C.faint)}>~/aurora</span>
      </div>
      <div style={{ padding: "10px 14px", ...codeFont(commandOnly ? 15 : 12.5, C.body), lineHeight: "22px" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ color: "#2F9E62" }}>$ </span>
          <span style={{ color: C.ink }}>{typed}</span>
          {!ran && (!commandOnly || focus) && <Block h={15} at={commandOnly ? 0 : p.at} solid={typed.length > 0 && typed.length < p.cmd.length} color={C.blue} style={{ marginLeft: 1 }} />}
        </div>
        {shown.map(([d, s, c]) => (
          <div key={d} style={{ color: c ?? C.body, opacity: p01(f, p.at + d + 6, p.at + d + 10), fontWeight: s.startsWith("✓") ? 600 : 400 }}>{s}</div>
        ))}
        {busy && <div style={{ color: C.faint }}>{"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(f / 2) % 10]} working…</div>}
      </div>
    </div>
  );
};

const CliPanel: React.FC<{ f: number; paneF?: (i: number) => number; fixedN?: number; commandOnly?: boolean }> = ({ f, paneF, fixedN, commandOnly }) => {
  const n = fixedN ?? 1 + PLUS.filter((p) => f >= p + 2).length;
  const k = fixedN ? -1 : PLUS.findIndex((p) => f >= p + 2 && f < p + 18);
  const prev = rects(Math.max(1, n - 1)), cur = rects(n);
  const m = k >= 0 ? p01(f, PLUS[k] + 2, PLUS[k] + 16, out) : 1;
  const lerp = (a: R, b: R): R => a.map((v, j) => v + (b[j] - v) * m) as R;
  const grown = (b: R): R => [b[0] + b[2], b[1], 0, b[3]];
  const tabs = PANES.slice(0, n).map((p, i) => commandOnly && i === 2 ? { ...p, name: "terminal", sub: "shell" } : p);
  return (
    <div style={abs(0, 0, { width: AW, height: AH, background: "#fff", overflow: "hidden" })}>
      <div style={abs(0, 0, { width: 200, height: AH, background: SIDE, borderRight: `1px solid ${C.line}` })}>
        <Segmented active="chat" press={p01(f, CODEBTN - 6, CODEBTN)} />
        <div style={abs(12, 42, { width: 176, height: 28, borderRadius: 8, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", boxSizing: "border-box", color: C.body })}>
          <I d={ic.plus} size={15} /><span style={ui(13, C.ink)}>New session</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, color: C.faint }}><I d={ic.search} size={13} /><I d={ic.branch} size={13} /></div>
        </div>
        <div style={abs(12, 70, { display: "flex", alignItems: "center", gap: 8, padding: "0 10px", color: C.muted })}><I d={ic.left} size={14} /><span style={ui(13, C.body)}>Back to chats</span></div>
        <div style={abs(0, 753, { width: 200, borderTop: `1px solid ${C.line}` })} />
        <Row y={776} icon={ic.gear} label="Settings" />
      </div>
      <div style={abs(200, 0, { width: 228, height: AH, borderRight: `1px solid ${C.line}`, padding: "14px 14px", boxSizing: "border-box" })}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={ui(14, C.ink, 600)}>Terminal grid</span>
          <span style={{ ...ui(11, "#2F9E62", 500), background: C.greenSoft, borderRadius: 99, padding: "2px 8px" }}>running</span>
        </div>
        <div style={{ ...ui(11.5, C.muted), marginTop: 5 }}>{`${n}/16 panes · aurora`}</div>
        <div style={{ marginTop: 14, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", ...codeFont(11, "#fff") }}>{">_"}</div>
          <div><div style={ui(12.5, C.ink, 500)}>Command center</div><div style={{ ...ui(11, C.muted), marginTop: 2 }}>Repo: aurora</div></div>
        </div>
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {[["AGENT", "Claude Code", C.ink], ["BRANCH", "main", C.ink], ["PANES", `${n}/16`, C.ink], ["APPROVAL", "terminal only", C.amber]].map(([a, b, c]) => (
            <div key={a} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 9px", background: a === "APPROVAL" ? C.amberSoft : undefined }}>
              <div style={{ ...ui(9.5, C.faint, 600), letterSpacing: "0.06em" }}>{a}</div>
              <div style={{ ...ui(12, c, 500), marginTop: 3 }}>{b}</div>
            </div>
          ))}
        </div>
        <div style={{ ...ui(11, C.muted), whiteSpace: "normal", marginTop: 10, lineHeight: 1.45 }}>This pane runs like any terminal. Gyro cannot review its file edits.</div>
        <div style={{ ...ui(10, C.faint, 600), letterSpacing: "0.06em", marginTop: 18 }}>RUNNING SESSIONS</div>
        {tabs.map((p, i) => (
          <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9, opacity: i === n - 1 && k >= 0 ? m : 1 }}>
            <div style={{ width: 7, height: 7, borderRadius: 4, background: "#2F9E62" }} />
            <div><div style={ui(12.5, C.ink, 500)}>{p.name}</div><div style={codeFont(10.5, C.faint)}>{p.sub}</div></div>
            <span style={{ ...ui(11, "#2F9E62"), marginLeft: "auto" }}>running</span>
          </div>
        ))}
        <div style={{ ...ui(10, C.faint, 600), letterSpacing: "0.06em", marginTop: 18 }}>WORKSPACE FILES</div>
        {["/Users/demo/aurora/src", "src/cart", "src/providers", "package.json"].map((s) => <div key={s} style={{ ...codeFont(11, C.muted), marginTop: 7 }}>{s}</div>)}
      </div>
      <div style={abs(428, 0, { width: AW - 428, height: 40, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "flex-end", gap: 22, padding: "0 16px", boxSizing: "border-box" })}>
        {["Diff", "Terminal", "Browser", "Problems", "Test Results", "Output"].map((t) => (
          <div key={t} style={{ ...ui(12.5, t === "Terminal" ? C.ink : C.muted, t === "Terminal" ? 500 : 400), paddingBottom: 11, borderBottom: t === "Terminal" ? `2px solid ${C.ink}` : "2px solid transparent" }}>{t}</div>
        ))}
      </div>
      <div style={abs(428, 40, { width: AW - 428, height: 36 })}>
        {tabs.map((p, i) => (
          <div key={p.name} style={abs(4 + i * 104, 6, { width: 98, height: 24, borderRadius: 7, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 9px", background: i === n - 1 ? C.soft : undefined, border: `1px solid ${i === n - 1 ? C.line : "transparent"}`, opacity: i === n - 1 && k >= 0 ? m : 1 })}>
            <I d={ic.term} size={12} color={C.muted} />
            <span style={ui(12, C.ink)}>{p.name}</span>
            {i === n - 1 && <span style={{ ...ui(11, C.faint), marginLeft: "auto" }}>×</span>}
          </div>
        ))}
        {n < 4 || f < PLUS[2] + 20 ? (
          <div style={abs(4 + n * 104 + 2, 8, { width: 20, height: 20, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, background: PLUS.some((p) => f >= p - 3 && f < p + 3) ? "rgba(16,20,42,0.08)" : undefined })}><I d={ic.plus} size={14} /></div>
        ) : null}
        <div style={abs(AW - 428 - 32, 9, { color: C.muted })}><I d={ic.dots} size={16} /></div>
      </div>
      <div style={abs(GX - 6, GY - 4, { width: GW + 12, height: GH + 12, background: "#EEF0F3", borderRadius: 12 })} />
      <div style={abs(GX, GY + 2, { width: GW, height: GH })}>
        {tabs.map((_, i) => {
          const b = cur[i];
          const a = i < prev.length && n > 1 ? prev[i] : grown(b);
          const r = k >= 0 ? lerp(i === n - 1 ? grown(b) : a, b) : b;
          return <TermPane commandOnly={commandOnly} key={i} f={paneF ? paneF(i) : f} i={i} r={r} focus={paneF ? i === 0 : i === n - 1} />;
        })}
      </div>
    </div>
  );
};

// ---- IDE -----------------------------------------------------------------
const KW = /(\/\/.*$)|("[^"]*")|\b(import|type|from|const|export|function|return)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\()/g;
const Code: React.FC<{ s: string }> = ({ s }) => {
  const out: React.ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null;
  KW.lastIndex = 0;
  while ((m = KW.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const color = m[1] ? "#8A8FA3" : m[2] ? "#2F9E62" : m[3] ? "#4F5BD5" : m[4] ? C.amber : "#B0482E";
    out.push(<span key={m.index} style={{ color, fontWeight: m[3] ? 500 : 400, fontStyle: m[1] ? "italic" : undefined }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return <>{out}</>;
};

const LH = 22;
type Ln = { s: string; h: number; mark: number; diff?: "add" | "del"; caret?: number };
const ty = (f: number, s: string, t0: number, cps: number) => s.slice(0, Math.max(0, Math.min(s.length, Math.floor((f - t0) * cps))));
const INS = ["// Round to cents before summing.", "const cents = (n: number) =>", "  Math.round(n * 100) / 100;", ""];
const INS_AT = [EDIT + 12, EDIT + 31, EDIT + 47];
const OFF0 = "  const off = sub * discount;", RET0 = "  return sub - off;";

const docAt = (f: number, fd = f): Ln[] => {
  const grow = p01(f, EDIT, EDIT + 10, out);
  const dm = p01(fd, DIFF, DIFF + 12, out);
  const ins: Ln[] = INS.map((s, i) => {
    const t = i < 3 ? ty(f, s, INS_AT[i], 2) : "";
    const typing = i < 3 && f >= INS_AT[i] && t.length < s.length;
    return { s: t, h: grow, mark: grow, diff: "add", caret: typing || (i === 0 && f >= EDIT && f < INS_AT[0]) ? t.length : undefined };
  });
  const offC = ty(f, "cents(", EDIT + 66, 1), offE = ty(f, ")", EDIT + 74, 1);
  const retC = ty(f, "cents(", EDIT + 80, 1), retE = ty(f, ")", EDIT + 88, 1);
  const offCaret = f >= EDIT + 62 && f < EDIT + 78 ? (offE ? 35 : f >= EDIT + 72 ? 33 : 14 + offC.length) : undefined;
  const retCaret = f >= EDIT + 78 && f < EDIT + 96 ? (retE ? 25 : f >= EDIT + 86 ? 23 : 9 + retC.length) : undefined;
  return [
    { s: 'import type { Item } from "./types";', h: 1, mark: 0 },
    { s: "", h: 1, mark: 0 },
    ...ins,
    { s: "export function cartTotal(items: Item[], discount: number) {", h: 1, mark: 0 },
    { s: "  const sub = items.reduce((s, i) => s + i.price * i.qty, 0);", h: 1, mark: 0 },
    { s: OFF0, h: dm, mark: 1, diff: "del" },
    { s: `  const off = ${offC}sub * discount${offE};`, h: 1, mark: p01(f, EDIT + 66, EDIT + 70), diff: "add", caret: offCaret },
    { s: RET0, h: dm, mark: 1, diff: "del" },
    { s: `  return ${retC}sub - off${retE};`, h: 1, mark: p01(f, EDIT + 80, EDIT + 84), diff: "add", caret: retCaret },
    { s: "}", h: 1, mark: 0 },
  ];
};

const TREE: [number, string, boolean?][] = [[0, "src", true], [1, "cart", true], [2, "total.ts"], [2, "total.test.ts"], [1, "checkout", false], [1, "providers", false], [1, "editor", false], [0, "package.json"], [0, "README.md"]];
const TESTS: [number, string, string?][] = [
  [20, " RUN  v3.2.0 /Users/demo/aurora", C.faint], [28, " ✓ src/cart/total.test.ts (12 tests) 41ms", "#2F9E62"], [36, ""],
  [40, " Test Files  1 passed (1)", C.body], [46, "      Tests  12 passed (12)", "#2F9E62"], [52, "   Duration  612ms", C.faint],
];

// Test Results tab: the pass count rolls up to 12 as `f` runs from 0.
const TestRoll: React.FC<{ f: number }> = ({ f }) => {
  const p = p01(f, 0, 22, out);
  const n = Math.round(12 * p);
  const done = n >= 12;
  return (
    <div style={{ padding: "16px 20px", opacity: p01(f, -4, 2) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {done ? <Check size={20} color="#2F9E62" draw={p01(f, 22, 30, out)} /> : <div style={{ width: 16, height: 16, borderRadius: 8, border: `2px solid ${C.line}`, borderTopColor: "#2F9E62", transform: `rotate(${f * 24}deg)` }} />}
        <span style={{ fontFamily: line, fontWeight: 500, fontSize: 40, letterSpacing: "-0.03em", color: done ? "#2F9E62" : C.ink, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{`${n} passed`}</span>
        <span style={{ ...ui(15, C.faint), marginLeft: 4 }}>(12)</span>
      </div>
      <div style={{ marginTop: 14, height: 6, borderRadius: 3, background: C.soft, overflow: "hidden" }}>
        <div style={{ width: `${p * 100}%`, height: 6, background: "#2F9E62" }} />
      </div>
      <div style={{ ...codeFont(12.5, C.body), marginTop: 14, display: "flex", alignItems: "center", gap: 8, opacity: p01(f, 4, 10) }}>
        <span style={{ color: "#2F9E62" }}>✓</span><span>src/cart/total.test.ts</span><span style={{ color: C.faint }}>{`${n}/12`}</span>
        <span style={{ marginLeft: "auto", color: C.faint }}>{done ? "41ms" : ""}</span>
      </div>
    </div>
  );
};

const IdePanel: React.FC<{ f: number; fd?: number; ft?: number; W?: number; walkthrough?: number }> = ({ f, fd = f, ft, W = AW, walkthrough }) => {
  const open = f >= FILE + 2;
  const dm = p01(fd, DIFF, DIFF + 12, out);
  const doc = docAt(f, fd);
  let y = 0, no = 0;
  const cmd = ty(f, "pnpm test cart", TEST + 2, 1);
  return (
    <div style={abs(0, 0, { width: W, height: AH, background: "#fff", overflow: "hidden" })}>
      <div style={abs(0, 0, { width: 230, height: AH, background: SIDE, borderRight: `1px solid ${C.line}`, transform: walkthrough === undefined ? undefined : `translateX(${-230 * (1 - p01(walkthrough, 330, 344, out))}px)` })}>
        <Segmented active="code" />
        <div style={abs(18, 50, { display: "flex", alignItems: "center", gap: 8, color: C.muted })}><I d={ic.folder} size={14} /><span style={ui(13, C.ink, 600)}>{walkthrough !== undefined && walkthrough < 360 ? "Workspace" : "aurora"}</span></div>
        {walkthrough !== undefined && walkthrough < 360 ? <div style={abs(18, 90, { ...ui(13, C.ink, 500), padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff", display: "flex", alignItems: "center", gap: 8 })}><I d={ic.folder} size={14} />Open folder</div> : TREE.filter(([d]) => walkthrough === undefined || (walkthrough >= 380 ? true : walkthrough >= 370 ? d < 2 : d === 0)).map(([d, name, dir], i) => {
          const sel = name === "total.ts" && f >= FILE;
          return (
            <div key={name} style={abs(10, 76 + i * 26 - 0, { width: 210, height: 24, borderRadius: 6, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, paddingLeft: 10 + d * 14, background: sel ? "rgba(66,92,235,0.10)" : undefined, color: C.muted })}>
              {dir !== undefined ? <I d={dir && (walkthrough === undefined || walkthrough >= (name === "src" ? 370 : 380)) ? ic.down : ic.right} size={11} /> : <span style={{ width: 11 }} />}
              <I d={dir !== undefined ? ic.folder : ic.file} size={13} />
              <span style={ui(12.5, sel ? C.blue : C.ink, sel ? 500 : 400)}>{name}</span>
              {name === "total.ts" && f >= EDIT + 10 && <span style={{ ...ui(11, C.amber, 600), marginLeft: "auto", marginRight: 10 }}>M</span>}
            </div>
          );
        })}
      </div>
      <div style={abs(230, 0, { width: W - 230, height: 40, borderBottom: `1px solid ${C.line}`, background: "#FAFAFC" })}>
        {open && (
          <div style={abs(0, 0, { height: 40, padding: "0 16px", display: "flex", alignItems: "center", gap: 8, background: "#fff", borderRight: `1px solid ${C.line}`, opacity: p01(f, FILE + 2, FILE + 8), color: C.muted })}>
            <I d={ic.file} size={13} />
            <span style={ui(12.5, C.ink, 500)}>total.ts</span>
            {f >= EDIT + 10 && <div style={{ width: 7, height: 7, borderRadius: 4, background: C.amber }} />}
            {dm > 0 && <span style={{ ...ui(11, C.blue, 500), background: C.blueSoft, borderRadius: 5, padding: "1px 6px", opacity: dm }}>Diff</span>}
            <span style={ui(12, C.faint)}>×</span>
          </div>
        )}
      </div>
      {open ? (
        <>
          <div style={abs(246, 48, { ...ui(11.5, C.faint), opacity: p01(f, FILE + 4, FILE + 10) })}>src › cart › total.ts</div>
          <div style={abs(230, 76, { width: W - 230 })}>
            {doc.map((l, i) => {
              const top = y;
              const h = LH * l.h;
              y += h;
              if (l.h > 0.5 && l.diff !== "del") no++;
              if (h < 0.5) return null;
              const reveal = walkthrough === undefined ? p01(f, FILE + 4 + i * 1.6, FILE + 12 + i * 1.6, out) : p01(walkthrough, 390, 397, out);
              const bg = l.diff === "del" ? `rgba(169,65,47,${0.09 * dm})` : l.diff === "add" ? `rgba(47,158,98,${0.10 * dm})` : undefined;
              return (
                <div key={i} style={abs(0, top, { width: W - 230, height: h, overflow: "hidden", background: bg, opacity: reveal })}>
                  <div style={abs(0, 0, { width: 44, textAlign: "right", ...codeFont(12, "#B4B8C6"), lineHeight: `${LH}px` })}>{l.diff === "del" ? "" : no}</div>
                  <div style={abs(52, 3, { width: 3, height: LH - 6, borderRadius: 2, background: l.diff === "del" ? C.red : "#2F9E62", opacity: l.mark * (l.diff ? 1 : 0) })} />
                  {dm > 0 && l.diff && <div style={abs(60, 0, { ...codeFont(12, l.diff === "del" ? C.red : "#2F9E62"), lineHeight: `${LH}px`, opacity: dm })}>{l.diff === "del" ? "−" : "+"}</div>}
                  <div style={abs(74, 0, { ...codeFont(13, l.diff === "del" ? "#9C5A4E" : C.ink), lineHeight: `${LH}px`, textDecoration: l.diff === "del" ? "line-through rgba(169,65,47,0.4)" : undefined })}>
                    <Code s={l.s} />
                    {l.caret !== undefined && (
                      <div style={abs(0, 2, { left: `${l.caret}ch`, width: 2, height: LH - 4, background: C.coral })}>
                        <div style={abs(-1, -15, { ...ui(9.5, "#fff", 600), background: C.coral, borderRadius: 4, padding: "1px 5px" })}>Claude</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div style={abs(230, 40, { width: W - 230, height: 500, display: "flex", alignItems: "center", justifyContent: "center", ...ui(13, C.faint) })}>Select a file to view it</div>
      )}
      <div style={abs(230, 540, { width: W - 230, height: 260, borderTop: `1px solid ${C.line}`, background: "#fff" })}>
        <div style={{ height: 34, display: "flex", alignItems: "flex-end", gap: 22, padding: "0 16px", borderBottom: `1px solid ${C.line}` }}>
          {["Terminal", "Problems", "Test Results", "Output"].map((t) => {
            const on = t === (ft === undefined ? "Terminal" : "Test Results");
            return <div key={t} style={{ ...ui(12, on ? C.ink : C.muted, on ? 500 : 400), paddingBottom: 9, borderBottom: on ? `2px solid ${C.ink}` : "2px solid transparent" }}>{t}</div>;
          })}
        </div>
        {ft !== undefined ? <TestRoll f={ft} /> : <div style={{ padding: "10px 16px", ...codeFont(12.5, C.body), lineHeight: "20px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ color: "#2F9E62" }}>~/aurora $ </span>
            <span style={{ color: C.ink }}>{cmd}</span>
            {f < TEST + 18 && <Block h={15} at={walkthrough === undefined ? TEST - 2 : 300} solid={cmd.length > 0} color={C.blue} style={{ marginLeft: 1 }} />}
          </div>
          {TESTS.filter(([d]) => f >= TEST + d).map(([d, s, c]) => <div key={d} style={{ color: c, fontWeight: s.includes("passed (12)") ? 600 : 400, minHeight: 20 }}>{s}</div>)}
        </div>}
      </div>
    </div>
  );
};

// ---- Caption ---------------------------------------------------------------
export const Caption: React.FC<{ t: string; at: number; until: number }> = ({ t, at, until }) => {
  const f = useFrame();
  if (f < at || f >= until) return null;
  const del = until - 16;
  let n = Math.min(t.length, Math.floor((f - at - 3) * 0.75));
  if (f >= del) n = Math.max(0, t.length - Math.floor((f - del) * 1.6));
  const pop = p01(f, at, at + 10, out) * (1 - p01(f, until - 6, until, out));
  return (
    <div style={{ position: "absolute", left: 960, top: 92, transform: `translate(-50%,-50%) scale(${0.94 + 0.06 * pop})`, opacity: pop, display: "flex", alignItems: "center", gap: 6, padding: "14px 26px", borderRadius: 999, background: "rgba(255,255,255,0.92)", boxShadow: "0 0 0 1px rgba(16,20,42,0.06), 0 18px 44px -16px rgba(16,20,42,0.35)", whiteSpace: "pre" }}>
      <span style={{ fontFamily: line, fontWeight: 500, fontSize: 46, letterSpacing: "-0.03em", color: C.ink, lineHeight: 1 }}>{t.slice(0, Math.max(0, n))}</span>
      <Block h={40} at={at} solid={n < t.length} color={C.blue} />
    </div>
  );
};

// ---- Side chat (IDE split) ---------------------------------------------------
export const SideChat: React.FC<{ s: number; x: number; w: number }> = ({ s, x, w }) => {
  const n = Math.max(0, Math.floor((s - 6) * 3.2));
  const edited = p01(s, 74, 86, out);
  return (
    <div style={abs(x, 0, { width: w, height: AH, background: "#fff", borderLeft: `1px solid ${C.line}` })}>
      <div style={{ height: 43, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: `1px solid ${C.line}`, color: C.muted }}>
        <Logo id="anthropic" size={13} />
        <span style={ui(13, C.ink, 500)}>Fix the checkout bug</span>
        <div style={{ marginLeft: "auto" }}><I d={ic.dots} size={16} /></div>
      </div>
      <div style={{ padding: "18px 18px 0", display: "flex", justifyContent: "flex-end" }}>
        <div style={{ ...ui(13, C.ink), whiteSpace: "normal", background: "#F0F2F5", borderRadius: 14, padding: "11px 14px", maxWidth: w - 80 }}>{ASK}</div>
      </div>
      <div style={{ padding: "16px 18px 0", ...ui(13.5, C.body), whiteSpace: "normal", lineHeight: 1.6 }}>
        <Stream segs={REPLY_SEGS} n={n} />
        {n < REPLY_LEN && <span style={{ display: "inline-block", width: 7, height: 14, background: C.ink, marginLeft: 2, verticalAlign: "-2px", opacity: 0.7 }} />}
      </div>
      {edited > 0 && (
        <div style={{ margin: "16px 18px 0", borderRadius: 12, border: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", color: C.muted, opacity: edited, transform: `translateY(${(1 - edited) * 12}px)` }}>
          <I d={ic.file} size={14} />
          <span style={ui(13, C.ink, 500)}>Edited 1 file</span>
          <span style={ui(12.5, "#2F9E62", 500)}>+6</span>
          <span style={ui(12.5, C.red, 500)}>−2</span>
        </div>
      )}
      <div style={abs(14, AH - 112, { width: w - 28, height: 96, boxSizing: "border-box", borderRadius: 16, border: `1px solid ${C.line}`, boxShadow: "0 1px 2px rgba(16,20,42,0.04), 0 12px 32px -16px rgba(16,20,42,0.2)", padding: "15px 16px" })}>
        <span style={ui(13, C.faint)}>Describe a task or attach images</span>
      </div>
    </div>
  );
};

// ---- Work: one line and one action per surface. All timing is act-local. ----
export const WORK = 460;
const WIPE_AT = 430;
const PROVIDERS = [
  { id: "anthropic", name: "Claude", at: 0 },
  { id: "openai", name: "ChatGPT", at: 25 },
  { id: "xai", name: "Grok", at: 50 },
  { id: "deepseek", name: "DeepSeek", at: 64 },
  { id: "kimi", name: "Kimi", at: 74 },
  { id: "gemini", name: "Gemini", at: 81 },
  { id: "ollama", name: "Ollama", at: 86 },
];
const WindowFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={abs(AX, AY, { width: AW, height: AH, borderRadius: 14, overflow: "hidden", background: "#fff", boxShadow: "0 0 0 1px rgba(16,20,42,0.08), 0 40px 100px -30px rgba(16,20,42,0.38)" })}>
    {children}<Traffic />
  </div>
);
export const WorkPointer: React.FC<React.ComponentProps<typeof TakePointer>> = ({ cam, keys, clicks = [], ...props }) => {
  const f = useFrame();
  return <>
    {clicks.map(click => {
      if (f < click || f >= click + 10) return null;
      const point = camAt(keys.map(([t, x, y]) => [t, x, y, 1]), click);
      const [x, y] = toScreen(cam, point.cx, point.cy);
      const progress = p01(f, click, click + 10, out);
      const radius = 8 + 10 * progress;
      return <div key={click} style={abs(x - radius, y - radius, { width: radius * 2, height: radius * 2, borderRadius: "50%", background: C.blue, opacity: 0.12 * (1 - progress), pointerEvents: "none" })} />;
    })}
    <TakePointer cam={cam} keys={keys} {...props} />
  </>;
};
const RollingProviders: React.FC<{ f: number }> = ({ f }) => {
  const index = Math.max(0, PROVIDERS.filter(p => f >= p.at).length - 1);
  const roll = index === 0 ? 1 : p01(f, PROVIDERS[index].at, PROVIDERS[index].at + (index > 3 ? 3 : 6), out);
  const offset = index === 0 ? 0 : index - 1 + roll;
  return <div style={abs(470, 470, { display: "flex", alignItems: "center", gap: 32, opacity: p01(f, 0, 8, out) * (1 - p01(f, 90, 100)), fontFamily: line, fontSize: 112, fontWeight: 500, letterSpacing: "-0.035em", color: C.ink })}>
    <span>Use</span>
    <div style={{ width: 680, height: 140, overflow: "hidden", position: "relative" }}>
      {PROVIDERS.map((p, i) => <div key={p.id} style={abs(0, (offset - i) * 140, { height: 140, display: "flex", alignItems: "center", gap: 26, opacity: Math.max(0, 1 - Math.abs(offset - i) * 0.8), filter: `blur(${index > 2 ? Math.sin(roll * Math.PI) * 1.5 : 0}px)` })}><Logo id={p.id} size={88} /><span>{p.name}</span>{i === index && <Block h={94} at={0} color={C.blue} />}</div>)}
    </div>
  </div>;
};
const SurfaceLine: React.FC<{ f: number; at: number; children: React.ReactNode }> = ({ f, at, children }) => {
  const land = p01(f, at, at + 10, out);
  const lift = p01(f, at + 27, at + 39);
  return <div style={abs(960, 530 - 448 * lift + 22 * (1 - land), { transform: `translate(-50%,-50%) scale(${1 - lift * 0.28})`, opacity: land, fontFamily: line, fontSize: 68, fontWeight: 500, letterSpacing: "-0.035em", color: C.ink, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 12 })}>{children}<Block h={58} at={at} color={C.blue} /></div>;
};

export const Work: React.FC = () => {
  const f = useFrame();
  const chatIn = p01(f, 91, 99, out);
  const chatOut = 1 - p01(f, 147, 156);
  const chatCam = camAt([[91, 1066, 781, 1.9]], f);
  const cliIn = p01(f, 190, 202, out);
  const cliOut = 1 - p01(f, 292, 307);
  const cliCam = camAt([[190, 960, 540, 0.98], [250, 960, 540, 1.02]], f);
  const codeIn = p01(f, 334, 346, out);
  const codeExit = p01(f, 430, 454);
  // Follow the pointer through the Workspace tree, then carry it into the
  // editor. The close view holds for a second before the window pulls out.
  const codeCam = camAt([
    [332, 960, 540, 1], [340, 960, 540, 1],
    [358, 610, 355, 2.15], [392, 610, 355, 2.15],
    [404, 860, 380, 1.9], [430, 860, 380, 1.9],
    [454, 960, 500, 0.86],
  ], f);
  const edge = p01(f, 327, 340);
  const codeKeys: Key[] = [
    [342, AX + 160, AY + 180, 1],
    [357, AX + 100, AY + 106, 1], [362, AX + 100, AY + 106, 1],
    [369, AX + 54, AY + 88, 1], [372, AX + 54, AY + 88, 1],
    [379, AX + 68, AY + 114, 1], [382, AX + 68, AY + 114, 1],
    [389, AX + 91, AY + 140, 1], [392, AX + 91, AY + 140, 1],
    [400, AX + 480, AY + 180, 1], [425, AX + 480, AY + 180, 1],
  ];
  return (
    <AbsoluteFill style={{ background: C.canvas, ...{
      // Scoped light-theme provider tokens from styles-foundation.css; do not
      // mutate document theme while neighboring acts are premounted.
      "--gyro-provider-openai-logo": "#000", "--gyro-provider-anthropic": "#b84a27",
      "--gyro-provider-kimi-logo": "#000", "--gyro-provider-ollama": "#1c2027",
      "--gyro-provider-xai": "#1c2027", "--gyro-provider-gemini": "#1e5ed8",
      "--gyro-provider-deepseek": "#205fda",
    } as React.CSSProperties }}>
      <style>{".wk-logo > span{display:block;width:100%;height:100%} .wk-logo svg{display:block;width:100%;height:100%}"}</style>
      {f < 100 && <RollingProviders f={f} />}
      {f >= 91 && f < 156 && <div style={{ opacity: chatIn * chatOut }}>
        <TakeCam cam={chatCam}><WindowFrame><ChatPanel f={20} demo={f} /></WindowFrame></TakeCam>
        <WorkPointer cam={chatCam} keys={[[94, AX + CL + CW - 140, AY + 804], [98, AX + CL + CW - 213, AY + 759], [103, AX + CL + CW - 213, AY + 759], [112, AX + CL + CW - 210, AY + 518], [123, AX + CL + CW - 210, AY + 518], [140, AX + CL + CW - 18, AY + 759]]} clicks={[99, 115, 144]} at={94} until={147} />
      </div>}
      {f >= 150 && f < 307 && <div style={{ opacity: cliOut }}>
        <SurfaceLine f={f} at={150}>Your CLI. Your terminal. Inside Gyro.</SurfaceLine>
        <div style={{ opacity: cliIn, transform: `translateY(${(1 - cliIn) * 60}px)` }}>
          <TakeCam cam={cliCam}><WindowFrame><CliPanel f={Math.min(479, CLI0 + (f - 204) * 0.9)} commandOnly /></WindowFrame></TakeCam>
        </div>
      </div>}
      {f >= 300 && <div style={{ opacity: 1 - p01(f, 444, 458) }}>
        <div style={{ opacity: 1 - p01(f, 328, 334) }}><SurfaceLine f={f} at={300}>Check all the code AI is shipping… <span style={{ position: "relative" }}>in-house.<span style={abs(0, 77, { height: 5, width: `${100 * p01(f, 318, 327, out)}%`, background: C.blue, opacity: 1 - edge })} /></span></SurfaceLine></div>
        <div style={{ opacity: codeIn, transform: `translateY(${(1 - codeIn) * 40 - codeExit * 25}px)` }}>
          <TakeCam cam={codeCam}><WindowFrame><IdePanel f={f >= 390 ? Math.min(690, FILE + 2 + (f - 390) * 7) : 620} walkthrough={f} /></WindowFrame></TakeCam>
          <WorkPointer cam={codeCam} keys={codeKeys.map(([t, x, y]) => [t, x, y])} clicks={[360, 370, 380, 390]} at={346} until={425} />
        </div>
        {f >= 327 && f < 341 && <div style={abs(1280 + (AX + 230 - 1280) * edge, 570 + (AY - 570) * edge, { width: 260 * (1 - p01(f, 327, 332)) + 3 * p01(f, 327, 332), height: 5 + (AH - 5) * p01(f, 332, 340), background: C.blue, opacity: 1 - p01(f, 337, 341) })} />}
      </div>}
      {f >= 179 && f < 430 && <div style={abs(40, 1000, { display: "flex", alignItems: "center", gap: 10, opacity: p01(f, 179, 193) * (1 - p01(f, 420, 430)) })}><Img src={staticFile("gyro-app-icon.png")} style={{ width: 34, height: 34 }} /><span style={ui(18, C.muted, 500)}>Gyro</span></div>}
      <Stripes p={p01(f, WIPE_AT, WORK - 2, (t) => t)} />
    </AbsoluteFill>
  );
};
