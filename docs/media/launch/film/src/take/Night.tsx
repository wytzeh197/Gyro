// Evening on the desktop. The pointer sets up a nightly automation in a hand-drawn Automations page,
// night falls, the clock rolls to 02:00 and it runs; by morning it has a result. Then the window
// goes into the dock and the camera rises to the mark.
import { useFrame } from "../pace";
import { AbsoluteFill, interpolate } from "remotion";
import { GyroMark } from "../ui/parts";
import { Decode, blurIn, line } from "../ui/skale";
import { C, inOut, out } from "../ui/theme";
import { clockText } from "./Open";
import { Desktop, GYRO_ICON, Key, Stripes, TakeCam, TypeCard, Window, camAt, clamp, p01, winPt } from "./kit";
import { Caption, I, Logo, Row, SIDE, Segmented, Traffic, WorkPointer, abs, ic, ui } from "./Work";

export const NIGHT = 682;
const AW = 1280, AH = 800;

// ---- Beats -----------------------------------------------------------------
const NEW = 56, TITLE = 75, PROMPT = 112, REPEAT = 169, PICK = 188, TIME = 206, CREATE = 244;
const RUN = 300, DONE = 375;
const LINE = 440;
const MIN: [number, number] = [482, 512];
const RISE: [number, number] = [544, 588];
const MARK = 592;
const SKY = -560;

const TITLE_TXT = "Update dependencies nightly";
const PROMPT_TXT = "Bump minor versions, run the full suite, open a PR if green.";
const TZ = "Europe/Amsterdam";

const P = (x: number, y: number): [number, number] => winPt(x, y);
const pt = (f: number, x: number, y: number): [number, number, number] => [f, ...P(x, y)];

const keys: Key[] = [
  [0, 960, 520, 0.98],
  [30, 960, 520, 0.98],
  [52, 880, 260, 1.45],
  [60, 880, 260, 1.45],
  [72, 1200, 300, 1.75],
  [152, 1200, 300, 1.75],
  [166, 1360, 640, 1.6],
  [220, 1360, 640, 1.6],
  [240, 1360, 680, 1.6],
  [252, 1360, 680, 1.6],
  [280, 1180, 420, 1.2],
  [310, 1405, 270, 2.0],
  [400, 1405, 270, 2.0],
  [424, 1100, 400, 1.35],
  [452, 960, 500, 0.86],
  [RISE[0], 960, 500, 0.86],
  [RISE[1], 960, SKY, 1.0],
];

const pointer: [number, number, number][] = [
  pt(24, 980, 520), pt(NEW - 4, 511, 73), pt(NEW + 4, 511, 73), pt(TITLE - 4, 800, 152), pt(TITLE + 8, 820, 160),
  pt(PROMPT - 4, 800, 240), pt(PROMPT + 10, 840, 252), pt(REPEAT - 4, 1172, 611), pt(REPEAT + 4, 1172, 611),
  pt(PICK - 4, 1100, 449), pt(PICK + 4, 1100, 449), pt(TIME - 4, 1214, 645), pt(TIME + 14, 1214, 650), pt(CREATE - 4, 1211, 744),
];
const clicks = [NEW, TITLE, PROMPT, REPEAT, PICK, TIME, CREATE];

const typed = (f: number, s: string, t0: number, cps: number) => s.slice(0, Math.max(0, Math.min(s.length, Math.floor((f - t0) * cps))));
const Caret: React.FC<{ f: number; h?: number }> = ({ f, h = 16 }) => (
  <span style={{ display: "inline-block", width: 1.5, height: h, marginLeft: 1, verticalAlign: "-3px", background: C.blue, opacity: Math.floor(f / 8) % 2 ? 0.15 : 1 }} />
);
const Spinner: React.FC<{ f: number; size?: number; color?: string }> = ({ f, size = 16, color = C.blue }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", flex: "none", transform: `rotate(${f * 14}deg)` }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeOpacity={0.2} strokeWidth={2.4} />
    <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
  </svg>
);
const Mark: React.FC<{ s: "passed" | "running" | "idle"; f: number; pop?: number }> = ({ s, f, pop = 1 }) =>
  s === "running" ? (
    <Spinner f={f} size={18} />
  ) : s === "passed" ? (
    <div style={{ width: 18, height: 18, borderRadius: 9, background: C.green, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", transform: `scale(${pop})` }}>
      <I d="M5 12.5l4.5 4.5L19 7.5" size={12} color="#fff" w={2.6} />
    </div>
  ) : (
    <div style={{ color: C.faint }}><I d={ic.clock} size={18} /></div>
  );

const Btn: React.FC<{ x: number; y: number; w: number; label: string; primary?: boolean; icon?: string; press?: boolean; dim?: boolean }> = ({ x, y, w, label, primary, icon, press, dim }) => (
  <div style={abs(x, y, { width: w, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxSizing: "border-box", background: primary ? C.ink : "#fff", border: `1px solid ${primary ? C.ink : C.line}`, color: primary ? "#fff" : C.ink, opacity: dim ? 0.55 : 1, transform: press ? "scale(0.96)" : undefined })}>
    {icon && <I d={icon} size={13} />}
    <span style={ui(12.5, primary ? "#fff" : C.ink, 600)}>{label}</span>
  </div>
);

const Pill: React.FC<{ state: "Active" | "Running" | "Paused"; f: number }> = ({ state, f }) => {
  const c = state === "Running" ? C.blue : state === "Active" ? C.green : C.faint;
  const bg = state === "Running" ? C.blueSoft : state === "Active" ? C.greenSoft : "rgba(16,20,42,0.05)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: bg, ...ui(11.5, c, 600) }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: c, opacity: state === "Running" ? 0.55 + 0.45 * Math.sin(f / 3) : 1 }} />
      {state}
    </span>
  );
};

// ---- Automation data (wording follows the real Automations page) ----------
type Run = { status: "passed" | "running"; summary: string; when: string };
type Auto = { title: string; schedule: string; next: string; state: "Active" | "Running" | "Paused"; result?: string; resultWhen?: string; mark: "passed" | "running" | "idle"; runs: Run[]; prompt: string };

const triage: Auto = {
  title: "Triage new issues", schedule: "Every hour", next: "00:00", state: "Active", mark: "passed",
  result: "6 issues labelled · 2 replies drafted", resultWhen: "Passed · 48m ago",
  runs: [{ status: "passed", summary: "6 issues labelled", when: "48m ago" }, { status: "passed", summary: "3 issues labelled", when: "2h ago" }],
  prompt: "Label new GitHub issues and draft a first reply.",
};

const nightly = (f: number): Auto => {
  const running = f >= RUN && f < DONE;
  const done = f >= DONE;
  return {
    title: TITLE_TXT, schedule: `Daily at 02:00 · ${TZ}`, next: done ? "Tomorrow 02:00" : "Today 02:00",
    state: running ? "Running" : "Active", mark: running ? "running" : done ? "passed" : "idle",
    result: running ? "Running pnpm test…" : done ? "PR #217 · 14 packages updated · all tests pass" : undefined,
    resultWhen: done ? (f < DONE + 40 ? "Passed · now" : "Passed · 5h ago") : running ? "Running · now" : undefined,
    runs: running ? [{ status: "running", summary: "Running", when: "now" }] : done ? [{ status: "passed", summary: "14 packages updated, PR #217", when: f < DONE + 40 ? "now" : "5h ago" }] : [],
    prompt: PROMPT_TXT,
  };
};

// Steps the run streams while it works.
const RUN_STEPS = ["Created worktree nightly-deps", "pnpm up --latest-minor", "14 packages updated", "pnpm test  ·  212 passed", "Opened PR #217"];

// ---- Detail ----------------------------------------------------------------
const DX = 594, PX = DX + 28, INS = 1030;
const Detail: React.FC<{ a: Auto; f: number }> = ({ a, f }) => {
  const running = a.state === "Running";
  const nStep = running ? Math.min(RUN_STEPS.length, Math.floor((f - RUN) / 14) + 1) : 0;
  const pop = 0.6 + 0.4 * p01(f, DONE, DONE + 10, out) + Math.sin(p01(f, DONE, DONE + 14) * Math.PI) * 0.18;
  return (
    <>
      {/* Header */}
      <div style={abs(PX, 34, { display: "flex", alignItems: "center", gap: 10 })}>
        <span style={ui(20, C.ink, 600)}>{a.title}</span>
        <Pill state={a.state} f={f} />
      </div>
      <div style={abs(PX, 66, ui(12.5, C.muted))}>~/code/aurora</div>
      <Btn x={1046} y={36} w={52} label="Edit" dim={running} />
      <Btn x={1104} y={36} w={74} label="Pause" icon="M9 6v12|M15 6v12" />
      <Btn x={1184} y={36} w={78} label={running ? "Running" : "Run now"} icon="M7 5l12 7-12 7z" primary dim={running} />
      <div style={abs(DX, 100, { width: AW - DX, borderTop: `1px solid ${C.line}` })} />
      {/* Activity */}
      <div style={abs(PX, 120, { display: "flex", gap: 10, alignItems: "flex-start", color: C.muted })}>
        <I d="M4 7h16v13H4z|M4 11h16|M8 4v5|M16 4v5" size={17} />
        <div>
          <div style={ui(13.5, C.ink, 500)}>{a.schedule}</div>
          <div style={{ ...ui(12, C.muted), marginTop: 4 }}>{`Next run · ${a.next}`}</div>
        </div>
      </div>
      <div style={abs(PX, 186, ui(13, C.ink, 600))}>Latest result</div>
      <div style={abs(PX, 210, { width: 388, minHeight: 74, boxSizing: "border-box", padding: "14px 16px", borderRadius: 12, border: `1px solid ${running ? "rgba(66,92,235,0.35)" : C.line}`, background: running ? "rgba(66,92,235,0.035)" : "#fff", display: "flex", gap: 12, alignItems: "flex-start" })}>
        <Mark s={a.mark} f={f} pop={pop} />
        <div style={{ minWidth: 0 }}>
          <div style={{ ...ui(13.5, a.result ? C.ink : C.muted, a.result ? 500 : 400), whiteSpace: "normal" }}>{a.result ?? "No result yet"}</div>
          {a.resultWhen && <div style={{ ...ui(12, C.muted), marginTop: 5 }}>{a.resultWhen}</div>}
          {running && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
              {RUN_STEPS.slice(0, nStep).map((s, i) => {
                const live = i === nStep - 1;
                return (
                  <div key={s} style={{ display: "flex", alignItems: "center", gap: 7, opacity: p01(f, RUN + i * 14, RUN + i * 14 + 6), fontFamily: "'Geist Mono', monospace", fontSize: 11.5, color: live ? C.ink : C.muted, whiteSpace: "pre" }}>
                    {live ? <Spinner f={f} size={11} /> : <I d="M5 12.5l4.5 4.5L19 7.5" size={11} color={C.green} w={2.6} />}
                    {s}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {!running && (
        <div style={abs(PX, 300, { display: "flex", gap: 16 })}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: a.result ? C.blue : C.faint }}><I d={ic.chat} size={14} /><span style={ui(12.5, a.result ? C.blue : C.faint, 600)}>Open chat</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: C.faint }}><I d="M3 7h18v4H3z|M5 11v9h14v-9|M10 15h4" size={14} /><span style={ui(12.5, C.faint, 600)}>Archive</span></div>
        </div>
      )}
      {!running && (
        <>
          <div style={abs(PX, 344, ui(13, C.ink, 600))}>Run history</div>
          {a.runs.length === 0 && <div style={abs(PX, 370, ui(12.5, C.muted))}>No runs recorded yet</div>}
          {a.runs.map((r, i) => (
            <div key={i} style={abs(PX, 368 + i * 46, { width: 388, height: 42, display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.line}` })}>
              <Mark s={r.status} f={f} pop={i === 0 ? pop : 1} />
              <div style={{ flex: 1 }}>
                <div style={ui(13, C.ink)}>{r.summary}</div>
                <div style={ui(11.5, C.muted)}>{r.status === "passed" ? "Passed" : "Running"}</div>
              </div>
              <span style={ui(11.5, C.faint)}>{r.when}</span>
            </div>
          ))}
        </>
      )}
      {/* Inspector */}
      <div style={abs(INS - 14, 100, { height: AH - 100, borderLeft: `1px solid ${C.line}` })} />
      <div style={abs(INS + 4, 120, ui(13, C.ink, 600))}>Automation</div>
      {[
        ["Project", "aurora"],
        ["Schedule", a.schedule.split(" · ")[0]],
        ["Next run", a.next],
        ["Branch", "main"],
        ["Model", "Claude Opus 5"],
      ].map(([k, v], i) => (
        <div key={k} style={abs(INS + 4, 150 + i * 42)}>
          <div style={ui(11, C.faint, 500)}>{k}</div>
          <div style={{ ...ui(13, C.ink), marginTop: 3 }}>{v}</div>
        </div>
      ))}
      <div style={abs(INS + 4, 374, ui(13, C.ink, 600))}>Instructions</div>
      <div style={abs(INS + 4, 398, { ...ui(12.5, C.body), width: 228, whiteSpace: "normal", lineHeight: 1.5 })}>{a.prompt}</div>
    </>
  );
};

// ---- Editor ----------------------------------------------------------------
const EX = DX + 32, EW = AW - DX - 64;
const REPEAT_OPTS = ["Once at a date and time", "Daily at a time", "Weekly on a day", "Manual only", "Every hour", "Every 24 hours"];
const Setting: React.FC<{ y: number; k: string; children: React.ReactNode; last?: boolean; on?: boolean }> = ({ y, k, children, last, on }) => (
  <div style={abs(EX, y, { width: EW, height: 34, boxSizing: "border-box", padding: "0 14px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: last ? undefined : `1px solid ${C.line}`, background: on ? "rgba(66,92,235,0.05)" : undefined })}>
    <span style={ui(12.5, C.body)}>{k}</span>
    <span style={{ display: "flex", alignItems: "center", gap: 6, color: C.muted }}>{children}</span>
  </div>
);
const Choice: React.FC<{ v: string; logo?: string }> = ({ v, logo }) => (
  <>
    {logo && <Logo id={logo} size={13} />}
    <span style={ui(12.5, C.ink, 500)}>{v}</span>
    <I d={ic.down} size={13} />
  </>
);

const Editor: React.FC<{ f: number }> = ({ f }) => {
  const title = typed(f, TITLE_TXT, TITLE + 3, 1.1);
  const prompt = typed(f, PROMPT_TXT, PROMPT + 4, 1.7);
  const focus = f >= TIME ? "time" : f >= REPEAT ? "repeat" : f >= PROMPT ? "prompt" : f >= TITLE ? "title" : "title0";
  const menu = p01(f, REPEAT + 2, REPEAT + 9, out) * (1 - p01(f, PICK + 2, PICK + 7));
  const daily = f >= PICK + 2;
  const grow = p01(f, PICK + 2, PICK + 14, out);
  const hover = Math.max(0, Math.min(5, Math.round(interpolate(f, [REPEAT + 6, PICK - 4], [3, 1], clamp))));
  const tSel = f >= TIME + 2 && f < TIME + 6;
  const tTyped = typed(f, "02:00", TIME + 5, 0.45);
  const time = f < TIME + 5 ? "09:00" : tTyped + "09:00".slice(tTyped.length).replace(/\d/g, "–").replace(":", ":");
  const field = (on: boolean): React.CSSProperties => ({ border: `1px solid ${on ? C.blue : C.line}`, boxShadow: on ? "0 0 0 3px rgba(66,92,235,0.14)" : undefined, borderRadius: 10, background: "#fff", boxSizing: "border-box", padding: "0 12px" });
  const g2 = 594;
  return (
    <>
      <div style={abs(EX, 34, ui(20, C.ink, 600))}>New automation</div>
      <div style={abs(EX, 64, ui(13, C.muted))}>Set the task Gyro will run on your schedule.</div>
      <div style={abs(AW - 52, 36, { color: C.muted })}><I d="M6 6l12 12|M18 6L6 18" size={16} /></div>
      <div style={abs(EX, 110, ui(12, C.body, 500))}>Title</div>
      <div style={abs(EX, 130, { ...field(focus === "title" || focus === "title0"), width: EW, height: 40, display: "flex", alignItems: "center" })}>
        {title ? <span style={ui(13.5, C.ink)}>{title}</span> : <span style={ui(13.5, C.faint)}>e.g. Daily project check</span>}
        {(focus === "title" || focus === "title0") && <Caret f={f} />}
      </div>
      <div style={abs(EX, 186, ui(12, C.body, 500))}>Prompt</div>
      <div style={abs(EX, 206, { ...field(focus === "prompt"), width: EW, height: 76, padding: "11px 12px" })}>
        {prompt ? <span style={{ ...ui(13.5, C.ink), whiteSpace: "normal" }}>{prompt}</span> : <span style={ui(13.5, C.faint)}>Tell Gyro what to do each time this runs…</span>}
        {focus === "prompt" && <Caret f={f} />}
      </div>
      <div style={abs(EX, 288, ui(11.5, C.faint))}>Gyro uses this prompt for every scheduled run.</div>

      <div style={abs(EX, 322, ui(13, C.ink, 600))}>Details</div>
      <div style={abs(EX, 344, { width: EW, height: 34 * 6, borderRadius: 12, border: `1px solid ${C.line}`, background: "#FBFBFC", boxSizing: "border-box" })} />
      <Setting y={344} k="Runs on"><span style={ui(12.5, C.muted)}>This Mac</span></Setting>
      <Setting y={378} k="Runs in"><span style={ui(12.5, C.muted)}>New chat for each run</span></Setting>
      <Setting y={412} k="Project"><I d={ic.folder} size={13} /><span style={ui(12.5, C.ink, 500)}>aurora</span><span style={ui(11, C.faint)}>Change</span></Setting>
      <Setting y={446} k="Workspace"><Choice v="Isolated worktree" /></Setting>
      <Setting y={480} k="Provider"><Choice v="Anthropic" logo="anthropic" /></Setting>
      <Setting y={514} k="Model" last><Choice v="Claude Opus 5" /></Setting>

      <div style={abs(EX, 568, ui(13, C.ink, 600))}>Frequency</div>
      <div style={abs(EX, g2, { width: EW, height: 34 + 68 * grow, borderRadius: 12, border: `1px solid ${C.line}`, background: "#FBFBFC", boxSizing: "border-box" })} />
      <Setting y={g2} k="Repeat" last={grow < 0.05} on={focus === "repeat" && f < PICK + 6}><Choice v={daily ? "Daily at a time" : "Manual only"} /></Setting>
      {grow > 0 && (
        <div style={{ opacity: grow }}>
          <Setting y={g2 + 34} k="Time" on={focus === "time"}>
            <span style={{ ...ui(12.5, C.ink, 500), fontVariantNumeric: "tabular-nums", background: tSel ? "rgba(66,92,235,0.18)" : undefined, borderRadius: 4, padding: "1px 3px" }}>{time}</span>
            <I d={ic.clock} size={13} />
          </Setting>
          <Setting y={g2 + 68} k="Time zone" last><Choice v={TZ} /></Setting>
        </div>
      )}

      <Btn x={AW - 32 - 74 - 8 - 70} y={g2 + 34 + 68 + 30} w={70} label="Cancel" />
      <Btn x={AW - 32 - 74} y={g2 + 34 + 68 + 30} w={74} label="Create" primary press={f >= CREATE && f < CREATE + 5} />

      {/* Repeat menu */}
      {menu > 0 && (
        <div style={abs(AW - 32 - 260, g2 - 4 - (REPEAT_OPTS.length * 30 + 12), { width: 260, padding: 6, boxSizing: "border-box", borderRadius: 12, background: "#fff", boxShadow: "0 0 0 1px rgba(16,20,42,0.08), 0 18px 40px -12px rgba(16,20,42,0.3)", opacity: menu, transform: `translateY(${(1 - menu) * 6}px)` })}>
          {REPEAT_OPTS.map((o, i) => (
            <div key={o} style={{ height: 30, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", background: i === hover ? "rgba(16,20,42,0.06)" : undefined }}>
              <span style={ui(12.5, C.ink)}>{o}</span>
              {o === "Manual only" && <I d="M5 12.5l4.5 4.5L19 7.5" size={13} color={C.blue} w={2.2} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
};

// ---- Page ------------------------------------------------------------------
const ListRow: React.FC<{ y: number; a: Pick<Auto, "title" | "schedule" | "state">; sel?: boolean; f: number; op?: number }> = ({ y, a, sel, f, op = 1 }) => (
  <div style={abs(226, y, { width: 356, height: 58, borderRadius: 10, boxSizing: "border-box", padding: "10px 12px", background: sel ? "rgba(16,20,42,0.055)" : undefined, opacity: op, display: "flex", alignItems: "center", gap: 10 })}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...ui(13.5, C.ink, 500), overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
      <div style={{ ...ui(12, C.muted), marginTop: 4, overflow: "hidden", textOverflow: "ellipsis" }}>{a.schedule}</div>
    </div>
    <span style={{ width: 7, height: 7, borderRadius: 4, flex: "none", background: a.state === "Running" ? C.blue : a.state === "Active" ? C.green : C.faint, opacity: a.state === "Running" ? 0.55 + 0.45 * Math.sin(f / 3) : 1 }} />
  </div>
);

const AutomationsPage: React.FC<{ f: number }> = ({ f }) => {
  const created = f >= CREATE + 2;
  const edIn = p01(f, NEW + 6, NEW + 18, out) * (1 - p01(f, CREATE + 4, CREATE + 14));
  const dOld = 1 - p01(f, NEW + 1, NEW + 6);
  const dNew = p01(f, CREATE + 10, CREATE + 24, out);
  const row = p01(f, CREATE + 6, CREATE + 20, out);
  const a = nightly(f);
  const flaky = { title: "Hunt flaky tests", schedule: `Sunday at 10:00 · ${TZ}`, state: "Paused" as const };
  return (
    <div style={abs(0, 0, { width: AW, height: AH, background: "#fff", overflow: "hidden", borderRadius: 14 })}>
      {/* Sidebar */}
      <div style={abs(0, 0, { width: 214, height: AH, background: SIDE, borderRight: `1px solid ${C.line}` })}>
        <Segmented active="chat" />
        <Row y={56} icon={ic.plus} label="New Session" />
        <Row y={84} icon={ic.search} label="Search" right="⌘K" />
        <Row y={113} icon={ic.clock} label="Automations" on={1} />
        <div style={abs(22, 141, ui(11, C.faint, 500))}>Projects</div>
        <div style={abs(22, 168, { display: "flex", gap: 8, alignItems: "center", color: C.muted })}>
          <I d={ic.folder} size={14} />
          <span style={ui(13, C.ink, 500)}>aurora</span>
        </div>
        {[
          { t: "Fix the checkout bug", id: "anthropic", age: "9h" },
          { t: "Fix flaky editor file tests", id: "anthropic", age: "13h" },
          { t: "Audit provider arguments", id: "openai", age: "20h" },
        ].map((s, i) => (
          <div key={s.t} style={abs(16, 194 + i * 29, { width: 189, height: 28, display: "flex", alignItems: "center", gap: 8, padding: "0 10px 0 22px", boxSizing: "border-box" })}>
            <Logo id={s.id} size={12} />
            <span style={{ ...ui(12.5, C.ink), overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{s.t}</span>
            <span style={ui(11, C.faint)}>{s.age}</span>
          </div>
        ))}
        <div style={abs(0, 753, { width: 214, borderTop: `1px solid ${C.line}` })} />
        <Row y={776} icon={ic.gear} label="Settings" />
      </div>
      {/* Index */}
      <div style={abs(214, 0, { width: DX - 214, height: AH, borderRight: `1px solid ${C.line}` })} />
      <div style={abs(234, 60, ui(17, C.ink, 600))}>Automations</div>
      <Btn x={442} y={58} w={138} label="Create automation" primary press={f >= NEW && f < NEW + 5} />
      <div style={abs(234, 104, { width: 346, height: 32, borderRadius: 9, border: `1px solid ${C.line}`, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8, padding: "0 10px", color: C.faint })}>
        <I d={ic.search} size={14} />
        <span style={ui(12.5, C.faint)}>Search automations</span>
      </div>
      {created && <ListRow y={152} a={a} sel f={f} op={row} />}
      <ListRow y={152 + 62 * row} a={triage} sel={!created && f < NEW + 2} f={f} />
      <ListRow y={214 + 62 * row} a={flaky} f={f} />
      {/* Detail / editor */}
      {dOld > 0 && <div style={{ ...abs(0, 0), opacity: dOld }}><Detail a={triage} f={f} /></div>}
      {edIn > 0 && <div style={{ ...abs(0, 0), opacity: edIn, transform: `translateX(${(1 - edIn) * 30}px)` }}><Editor f={f} /></div>}
      {dNew > 0 && <div style={{ ...abs(0, 0), opacity: dNew, transform: `translateY(${(1 - dNew) * 14}px)` }}><Detail a={a} f={f} /></div>}
      <Traffic />
    </div>
  );
};

// ---- Scene -------------------------------------------------------------------
const clockMin = (f: number) => interpolate(f, [CREATE + 8, RUN, 400], [23 * 60 + 48, 26 * 60, 31 * 60 + 30], { ...clamp, easing: inOut });

export const Night: React.FC = () => {
  const f = useFrame();
  const cam = camAt(keys, f);
  const min = clockMin(f);
  const speed = Math.min(1, Math.abs(clockMin(f + 1) - min) / 6);
  const night = p01(f, CREATE + 8, RUN - 4) * (1 - p01(f, 340, 400));
  const morning = p01(f, 340, 410) * (1 - p01(f, 520, 560) * 0.5);
  // Window minimises into the dock icon.
  const w = 1 - p01(f, MIN[0], MIN[1], (t) => t * t);
  const winC = winPt(640, 400);
  const sc = 0.04 + 0.96 * w;
  const dy = (GYRO_ICON[1] - winC[1]) * (1 - w);
  const clock = <span style={{ display: "inline-block", filter: speed > 0.05 ? `blur(${speed * 1.6}px)` : undefined }}>{clockText(min)}</span>;
  return (
    <AbsoluteFill style={{ background: C.canvas }}>
      <style>{".wk-logo > span{display:block;width:100%;height:100%} .wk-logo svg{display:block;width:100%;height:100%}"}</style>
      <TakeCam cam={cam}>
        {/* Above the desktop: open canvas for the mark. */}
        <div style={{ position: "absolute", left: -400, top: -1400, width: 2720, height: 1400, background: `linear-gradient(180deg, ${C.canvas} 0%, ${C.canvas} 55%, #ECEEF7 100%)` }} />
        <Desktop clock={clock} bounceAt={MIN[1]} gyroRunning night={night} morning={morning}>
          {w > 0 && (
            <div style={{ position: "absolute", inset: 0, transformOrigin: `${winC[0]}px ${winC[1]}px`, transform: `translateY(${dy}px) scale(${sc})`, opacity: Math.min(1, w * 5) }}>
              <Window>
                <AutomationsPage f={f} />
              </Window>
            </div>
          )}
        </Desktop>
        {f >= MARK - 4 && (
          <div style={{ position: "absolute", left: 0, top: SKY - 330, width: 1920, height: 660, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <GyroMark size={200} assembleAt={MARK} color={C.ink} />
            <div style={{ marginTop: 36, fontFamily: line, fontWeight: 500, fontSize: 96, letterSpacing: "-0.03em", color: C.ink, ...blurIn(f, MARK + 22) }}>Gyro</div>
            <div style={{ marginTop: 16, fontFamily: "'Geist Mono', monospace", fontSize: 30, color: C.blue, letterSpacing: "0.06em" }}>
              <Decode text="usegyro.io" at={MARK + 42} />
            </div>
          </div>
        )}
      </TakeCam>
      <WorkPointer cam={cam} keys={pointer} clicks={clicks} at={24} until={CREATE + 8} />
      <Caption t="Set it once." at={90} until={236} />
      <TypeCard text="Automate the rest." at={LINE} cps={0.42} until={MIN[0]} size={56} y={80} />
      <Stripes p={1 - p01(f, 0, 30, out)} dir={-1} />
    </AbsoluteFill>
  );
};
