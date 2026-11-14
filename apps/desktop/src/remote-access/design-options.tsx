// Design exploration only: static mockups of the remote access screens, three
// options per screen, built from the real settings components and tokens.
import React, { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Eye,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  Laptop,
  Monitor,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  WifiOff,
} from "../../../../packages/ui/node_modules/lucide-react";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
} from "../../../../packages/ui/src/settings-controls";
import {
  SettingsSection,
  SettingsStatus,
} from "../../../../packages/ui/src/settings-presentation";
import "@gyro-dev/ui/styles.css";
import "../theme.css";
import "./design-options.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";
const noop = () => {};
const CODE = "3f9a 21c0 77be 04d1";

function Option({
  letter,
  title,
  why,
  children,
}: {
  letter: string;
  title: string;
  why: string;
  children: ReactNode;
}) {
  return (
    <figure className="ra-opt">
      <figcaption>
        <span className="ra-opt-letter">{letter}</span>
        <div>
          <strong>{title}</strong>
          <p>{why}</p>
        </div>
      </figcaption>
      <div className="ra-opt-window">{children}</div>
    </figure>
  );
}

function Board({
  id,
  title,
  now,
  children,
}: {
  id: string;
  title: string;
  now: string;
  children: ReactNode;
}) {
  return (
    <section className="ra-board" id={id}>
      <header>
        <h1>{title}</h1>
        <p>Today: {now}</p>
      </header>
      <div className="ra-board-grid">{children}</div>
    </section>
  );
}

const Settings = ({ children }: { children: ReactNode }) => (
  <div className="gyro-settings-surface is-minimal-settings ra-settings">
    {children}
  </div>
);

/** A small slice of the workspace chrome: chat list on the left, main area. */
function Workspace({
  sidebar,
  children,
}: {
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ra-ws">
      <aside className="ra-ws-side">
        {sidebar}
        <span className="ra-ws-label">Chats on MacBook Pro</span>
        <span className="ra-ws-chat is-active">Fix login redirect</span>
        <span className="ra-ws-chat">Speed up test suite</span>
        <span className="ra-ws-chat">Release notes v0.1.4</span>
      </aside>
      <main className="ra-ws-main">{children}</main>
    </div>
  );
}

const Dot = ({ tone }: { tone: "success" | "warning" | "running" }) => (
  <i className={`ra-dot is-${tone}`} aria-hidden="true" />
);

function Messages({ dim = false }: { dim?: boolean }) {
  return (
    <div className={`ra-chat${dim ? " is-dim" : ""}`}>
      <p className="ra-bubble">The login page redirects back to itself after sign-in.</p>
      <p className="ra-answer">
        The redirect reads <code>next</code> before the session cookie is set.
        I moved the read after <code>setSession()</code> and added a test.
      </p>
    </div>
  );
}

function Composer({ blocked }: { blocked?: string }) {
  return (
    <div className="ra-composer">
      {blocked ? (
        <span className="ra-muted">{blocked}</span>
      ) : (
        <span className="ra-faint">Ask anything on MacBook Pro…</span>
      )}
      <button
        type="button"
        className="gyro-primary-button ra-icon-button"
        disabled={Boolean(blocked)}
        aria-label="Send"
      >
        <ArrowUp size={14} />
      </button>
    </div>
  );
}

const Tabs = ({ active }: { active: string }) => (
  <span className="ra-tabs" role="tablist">
    {["Chat", "Files", "Source Control", "Terminal"].map((v) => (
      <span key={v} role="tab" aria-selected={v === active} className={v === active ? "is-active" : ""}>
        {v}
      </span>
    ))}
  </span>
);

/* ---------- 1. Remote access settings ---------- */
function SettingsBoard() {
  return (
    <Board
      id="settings"
      title="1 · Remote access settings"
      now="one long page of five groups; pairing, devices and projects compete for attention"
    >
      <Option
        letter="A"
        title="Status first"
        why="A summary card answers “is this Mac reachable, and by whom?” before any setting. Pairing is one clear action."
      >
        <Settings>
          <SettingsSection title="Remote access">
            <div className="ra-hero">
              <span className="ra-hero-icon">
                <Laptop size={18} />
              </span>
              <div className="ra-hero-text">
                <strong>Studio Mac</strong>
                <SettingsStatus status="good">On · Reachable</SettingsStatus>
                <code>{CODE}</code>
              </div>
              <SettingsSwitch checked label="Allow remote access" onChange={noop} />
            </div>
            <div className="ra-hero-meta">
              <span>2 trusted devices</span>
              <span>3 shared projects</span>
              <button type="button" className="gyro-primary-button">
                <Plus size={14} /> Pair a device
              </button>
            </div>
            <SettingsGroup label="Trusted devices">
              <SettingsRow label="MacBook Pro" detail="Can connect to this Mac · a81c 9e02 5d4f 66b3">
                <button type="button" className="gyro-secondary-button">Revoke</button>
              </SettingsRow>
              <SettingsRow label="Office iMac" detail="Host you can open · 0c7d 41ea 92b8 f310">
                <button type="button" className="gyro-secondary-button">Connect</button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="Shared projects" summary="3 of 5">
              <SettingsRow label="gyro" detail="~/Gyro">
                <SettingsSwitch checked label="Share gyro" onChange={noop} />
              </SettingsRow>
              <SettingsRow label="gyro-website" detail="~/Sites/gyro-website">
                <SettingsSwitch checked label="Share gyro-website" onChange={noop} />
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        </Settings>
      </Option>
      <Option
        letter="B"
        title="Three tabs"
        why="Split This Mac, Devices and Projects into tabs. Each tab is short, and the page stops scrolling."
      >
        <Settings>
          <SettingsSection
            title="Remote access"
            actions={<SettingsStatus status="good">On</SettingsStatus>}
          >
            <SettingsSegmented
              label="Remote access section"
              value="devices"
              onChange={noop}
              options={[
                { label: "This Mac", value: "mac" },
                { label: "Devices · 2", value: "devices" },
                { label: "Projects · 3", value: "projects" },
              ]}
            />
            <SettingsGroup
              label="Trusted devices"
              description="Only devices you paired can reach shared projects."
              actions={
                <button type="button" className="gyro-primary-button">
                  Pair a device
                </button>
              }
            >
              <SettingsRow label="MacBook Pro" detail="Can connect to this Mac">
                <SettingsStatus status="info">Open</SettingsStatus>
                <button type="button" className="gyro-secondary-button">Disconnect</button>
              </SettingsRow>
              <SettingsRow label="Office iMac" detail="Host you can open">
                <button type="button" className="gyro-secondary-button">Connect</button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="Connect to another Mac" collapsible summary="Paste an invitation">
              <span />
            </SettingsGroup>
          </SettingsSection>
        </Settings>
      </Option>
      <Option
        letter="C"
        title="One device list"
        why="Every Mac is a row, including this one. Hosting, pairing and connecting all happen in the same list."
      >
        <Settings>
          <SettingsSection title="Remote access">
            <SettingsGroup label="Devices">
              <SettingsRow label="Studio Mac · This Mac" detail="Hosting 3 projects · 3f9a 21c0">
                <SettingsSwitch checked label="Allow remote access" onChange={noop} />
              </SettingsRow>
              <SettingsRow label="MacBook Pro" detail="Can connect to this Mac · a81c 9e02">
                <button type="button" className="gyro-secondary-button">Revoke</button>
              </SettingsRow>
              <SettingsRow label="Office iMac" detail="Host you can open · 0c7d 41ea">
                <SettingsStatus status="info">Open</SettingsStatus>
                <button type="button" className="gyro-secondary-button">Disconnect</button>
              </SettingsRow>
              <div className="ra-row-actions">
                <button type="button" className="gyro-primary-button">
                  <Plus size={14} /> Invite a device
                </button>
                <button type="button" className="gyro-secondary-button">
                  Join with an invitation
                </button>
              </div>
            </SettingsGroup>
            <SettingsGroup label="Shared projects" collapsible summary="gyro, gyro-website, notes">
              <span />
            </SettingsGroup>
          </SettingsSection>
        </Settings>
      </Option>
    </Board>
  );
}

/* ---------- 2. Pairing ---------- */
function PairingBoard() {
  return (
    <Board
      id="pairing"
      title="2 · Pairing a device"
      now="a raw invitation textarea, a countdown, and an approval row inside settings"
    >
      <Option
        letter="A"
        title="Guided steps"
        why="A three-step sheet tells you where you are and what to do on the other Mac. One action per step."
      >
        <div className="ra-sheet">
          <strong className="ra-sheet-title">Pair a device</strong>
          <ol className="ra-steps">
            <li className="is-done"><Check size={12} /> Create an invitation</li>
            <li className="is-active"><span>2</span> Paste it on your other Mac</li>
            <li><span>3</span> Check the code matches</li>
          </ol>
          <p className="ra-muted">
            On the other Mac, open Remote access › Join with an invitation.
          </p>
          <code className="ra-invite">gyro-pair-v1:Qm9uZ2xl…k3Fx</code>
          <div className="ra-row-between">
            <SettingsStatus status="info">Expires in 4:32</SettingsStatus>
            <button type="button" className="gyro-primary-button">
              <Copy size={14} /> Copy invitation
            </button>
          </div>
        </div>
      </Option>
      <Option
        letter="B"
        title="Compare side by side"
        why="The trust moment gets the space: the code each Mac should show, side by side, before anything is approved."
      >
        <div className="ra-sheet">
          <strong className="ra-sheet-title">MacBook Pro wants to connect</strong>
          <p className="ra-muted">
            Approve only if both Macs show the same code.
          </p>
          <div className="ra-compare">
            <div>
              <Monitor size={16} />
              <span>This Mac</span>
              <code>{CODE}</code>
            </div>
            <div>
              <Laptop size={16} />
              <span>MacBook Pro</span>
              <code>{CODE}</code>
            </div>
          </div>
          <div className="ra-row-end">
            <button type="button" className="gyro-secondary-button">Reject</button>
            <button type="button" className="gyro-primary-button">
              <ShieldCheck size={14} /> Approve
            </button>
          </div>
        </div>
      </Option>
      <Option
        letter="C"
        title="Inline, compact"
        why="Pairing stays in settings, but each state is a single row with its own status. Nothing opens or moves."
      >
        <Settings>
          <SettingsGroup label="Pair a device">
            <SettingsRow label="Invitation" detail="Single use. Paste it on your other Mac.">
              <SettingsStatus status="info">4:32</SettingsStatus>
              <button type="button" className="gyro-secondary-button">
                <Copy size={14} /> Copy
              </button>
            </SettingsRow>
            <SettingsRow label="MacBook Pro wants to connect" detail={`Check both Macs show ${CODE}`}>
              <button type="button" className="gyro-secondary-button">Reject</button>
              <button type="button" className="gyro-primary-button">Approve</button>
            </SettingsRow>
            <SettingsRow label="Join another Mac" detail="Paste the invitation it shows.">
              <input
                className="ra-input ra-mono"
                style={{ textAlign: "left", fontFamily: "var(--gyro-font-mono)", width: 240 }}
                aria-label="Invitation"
                placeholder="gyro-pair-v1:…"
                readOnly
              />
            </SettingsRow>
          </SettingsGroup>
        </Settings>
      </Option>
    </Board>
  );
}

/* ---------- 3. Workspace header & control ---------- */
function HeaderBoard() {
  return (
    <Board
      id="header"
      title="3 · Remote workspace header and control"
      now="three stacked toolbars: host and status, project and model selects, panel buttons and control"
    >
      <Option
        letter="A"
        title="One bar"
        why="Host and project, panel and control fit in one row. The host menu holds Refresh and Back to This Mac."
      >
        <Workspace>
          <header className="ra-bar">
            <button type="button" className="gyro-secondary-button ra-chip">
              <Dot tone="success" /> MacBook Pro <span className="ra-muted">/ gyro</span>{" "}
              <ChevronDown size={12} />
            </button>
            <button type="button" className="gyro-secondary-button ra-chip">
              Chat <ChevronDown size={12} />
            </button>
            <span className="ra-spacer" />
            <span className="ra-muted ra-inline">
              <Eye size={12} /> Watching
            </span>
            <button type="button" className="gyro-primary-button">Take control</button>
          </header>
          <Messages />
          <Composer blocked="Take control to send prompts or approve actions." />
        </Workspace>
      </Option>
      <Option
        letter="B"
        title="Breadcrumb and control banner"
        why="The header reads as a path. Control gets a banner that explains what watching means."
      >
        <Workspace>
          <header className="ra-bar">
            <span className="ra-crumbs">
              <Dot tone="success" />
              <strong>MacBook Pro</strong>
              <span>/</span>
              gyro
              <span>/</span>
              Fix login redirect
            </span>
            <span className="ra-spacer" />
            <span className="ra-muted">Connected · Experimental</span>
          </header>
          <div className="ra-banner">
            <Eye size={14} />
            <span>
              You’re watching. Prompts and approvals are off until you take
              control.
            </span>
            <button type="button" className="gyro-primary-button">Take control</button>
          </div>
          <Messages />
          <Composer blocked="Watching. Take control to send." />
        </Workspace>
      </Option>
      <Option
        letter="C"
        title="Host card in the sidebar"
        why="The connection lives with the chat list, where you switch machines anyway. The main header only shows panels."
      >
        <Workspace
          sidebar={
            <div className="ra-host-card">
              <div>
                <Laptop size={14} />
                <strong>MacBook Pro</strong>
              </div>
              <SettingsStatus status="good">Connected</SettingsStatus>
              <button type="button" className="gyro-secondary-button">
                Use This Mac
              </button>
            </div>
          }
        >
          <header className="ra-bar">
            <Tabs active="Chat" />
            <span className="ra-spacer" />
            <span className="ra-muted">You control this chat</span>
          </header>
          <Messages />
          <Composer />
        </Workspace>
      </Option>
    </Board>
  );
}

/* ---------- 4. Remote home ---------- */
function HomeBoard() {
  return (
    <Board
      id="home"
      title="4 · Remote home (no chat open)"
      now="“Code on MacBook Pro” plus a sentence; the real controls are in the toolbars above"
    >
      <Option
        letter="A"
        title="Composer first"
        why="Same as the local home screen: type straight away. Project, model and worktree sit on the composer."
      >
        <Workspace>
          <div className="ra-center">
            <h2>Code on MacBook Pro</h2>
            <div className="ra-composer is-large">
              <span className="ra-faint">Ask anything in gyro…</span>
              <div className="ra-composer-tools">
                <span className="ra-pill"><Folder size={12} /> gyro</span>
                <span className="ra-pill">Claude · Opus</span>
                <span className="ra-pill"><GitBranch size={12} /> New worktree</span>
                <span className="ra-spacer" />
                <button type="button" className="gyro-primary-button ra-icon-button" aria-label="Send">
                  <ArrowUp size={14} />
                </button>
              </div>
            </div>
          </div>
        </Workspace>
      </Option>
      <Option
        letter="B"
        title="Recent work on the host"
        why="Opening another Mac is usually about checking on work. Show what is running or waiting first."
      >
        <Workspace>
          <div className="ra-pad">
            <div className="ra-row-between">
              <h2>MacBook Pro</h2>
              <button type="button" className="gyro-primary-button">
                <Plus size={14} /> New chat
              </button>
            </div>
            <Settings>
              <SettingsGroup label="Recent chats">
                <SettingsRow label="Fix login redirect" detail="gyro · 2 min ago">
                  <SettingsStatus status="warning">Needs approval</SettingsStatus>
                </SettingsRow>
                <SettingsRow label="Speed up test suite" detail="gyro · now">
                  <SettingsStatus status="info">Running</SettingsStatus>
                </SettingsRow>
                <SettingsRow label="Release notes v0.1.4" detail="gyro-website · yesterday">
                  <SettingsStatus status="good">Done</SettingsStatus>
                </SettingsRow>
              </SettingsGroup>
            </Settings>
          </div>
        </Workspace>
      </Option>
      <Option
        letter="C"
        title="Pick a project"
        why="Shared projects as cards. Choosing one starts a chat there, so you never pick from an empty select."
      >
        <Workspace>
          <div className="ra-pad">
            <h2>Shared from MacBook Pro</h2>
            <div className="ra-cards">
              {[
                ["gyro", "~/Gyro", "12 chats"],
                ["gyro-website", "~/Sites/gyro-website", "4 chats"],
                ["notes", "~/Documents/notes", "No chats yet"],
              ].map(([name, path, count]) => (
                <button type="button" className="ra-card" key={name}>
                  <FolderGit2 size={16} />
                  <strong>{name}</strong>
                  <span className="ra-faint">{path}</span>
                  <span className="ra-muted">{count}</span>
                </button>
              ))}
            </div>
            <Settings>
              <SettingsEmptyState
                title="Missing a project?"
                description="Share it from Remote access on MacBook Pro."
              />
            </Settings>
          </div>
        </Workspace>
      </Option>
    </Board>
  );
}

/* ---------- 5. Connection lost ---------- */
function OfflineBoard() {
  return (
    <Board
      id="offline"
      title="5 · Connection lost"
      now="the status text changes to “Unavailable · Last known content”; everything else looks the same"
    >
      <Option
        letter="A"
        title="Warning banner"
        why="A banner over the chat says what happened and what still works. Reconnect is the only primary action."
      >
        <Workspace>
          <div className="ra-banner is-warning">
            <WifiOff size={14} />
            <span>
              Can’t reach MacBook Pro. Showing the last content it sent.
            </span>
            <button type="button" className="gyro-primary-button">
              <RefreshCw size={14} /> Reconnect
            </button>
          </div>
          <Messages />
          <Composer blocked="Host unavailable. Reconnect to continue." />
        </Workspace>
      </Option>
      <Option
        letter="B"
        title="Read-only mode"
        why="Content stays readable but dims. The composer turns into a clear read-only notice, so nobody types into a dead chat."
      >
        <Workspace>
          <header className="ra-bar">
            <span className="ra-crumbs">
              <Dot tone="warning" />
              <strong>MacBook Pro</strong>
              <span>/</span>
              Fix login redirect
            </span>
            <span className="ra-spacer" />
            <SettingsStatus status="warning">Unavailable</SettingsStatus>
          </header>
          <Messages dim />
          <div className="ra-readonly">
            <span>Read only until MacBook Pro is back.</span>
            <button type="button" className="gyro-primary-button">Reconnect</button>
          </div>
        </Workspace>
      </Option>
      <Option
        letter="C"
        title="Blocking card"
        why="When the host is gone, stop and help: likely causes, Reconnect, and a way back to this Mac."
      >
        <Workspace>
          <div className="ra-overlay">
            <Messages dim />
            <div className="ra-sheet ra-floating">
              <WifiOff size={18} />
              <strong className="ra-sheet-title">MacBook Pro is offline</strong>
              <ul className="ra-muted ra-list">
                <li>Gyro is open on MacBook Pro</li>
                <li>Remote access is on there</li>
                <li>Both Macs are online</li>
              </ul>
              <div className="ra-row-end">
                <button type="button" className="gyro-secondary-button">Back to This Mac</button>
                <button type="button" className="gyro-primary-button">Reconnect</button>
              </div>
            </div>
          </div>
        </Workspace>
      </Option>
    </Board>
  );
}

/* ---------- 6. Approvals ---------- */
function ApprovalBoard() {
  return (
    <Board
      id="approval"
      title="6 · Approving an action on the host"
      now="a card below the chat with the raw request JSON and two buttons"
    >
      <Option
        letter="A"
        title="Card in the chat"
        why="The request appears where it happened, in plain words: what will run, where, on which Mac."
      >
        <Workspace>
          <Messages />
          <div className="ra-approval">
            <div className="ra-row-between">
              <strong>Run a command on MacBook Pro</strong>
              <SettingsStatus status="warning">Needs approval</SettingsStatus>
            </div>
            <code className="ra-invite">pnpm test --filter @gyro-dev/ui</code>
            <span className="ra-faint">in ~/Gyro · worktree remote/fix-login</span>
            <div className="ra-row-end">
              <button type="button" className="gyro-secondary-button">Reject</button>
              <button type="button" className="gyro-primary-button">Approve once</button>
            </div>
          </div>
        </Workspace>
      </Option>
      <Option
        letter="B"
        title="Bar above the composer"
        why="Approval stays in reach while you scroll. Details open on demand instead of filling the chat."
      >
        <Workspace>
          <Messages />
          <div className="ra-approval-bar">
            <SettingsStatus status="warning">Needs approval</SettingsStatus>
            <button type="button" className="ra-link ra-nowrap" aria-expanded="false">
              Run <code>pnpm test</code> <ChevronDown size={12} />
            </button>
            <span className="ra-spacer" />
            <button type="button" className="gyro-secondary-button">Reject</button>
            <button type="button" className="gyro-primary-button">Approve once</button>
          </div>
          <Composer blocked="Waiting for your approval." />
        </Workspace>
      </Option>
      <Option
        letter="C"
        title="Review panel"
        why="For file edits, show the change itself. A side panel holds the diff, so you can approve from the evidence."
      >
        <div className="ra-split">
          <div className="ra-split-main">
            <Messages />
          </div>
          <aside className="ra-split-side">
            <div className="ra-row-between">
              <strong>Edit 1 file</strong>
              <SettingsStatus status="warning">Needs approval</SettingsStatus>
            </div>
            <span className="ra-faint">src/auth/redirect.ts</span>
            <pre className="ra-diff">
              <span className="is-del">-  const next = readNext(request);</span>
              {"\n"}
              <span>   await setSession(response, user);</span>
              {"\n"}
              <span className="is-add">+  const next = readNext(request);</span>
              {"\n"}
              <span>   return redirect(next ?? "/");</span>
            </pre>
            <div className="ra-row-end">
              <button type="button" className="gyro-secondary-button">Reject</button>
              <button type="button" className="gyro-primary-button">Approve edit</button>
            </div>
          </aside>
        </div>
      </Option>
    </Board>
  );
}

/* ---------- 7. Files, Source Control, Terminal ---------- */
function ToolsBoard() {
  return (
    <Board
      id="tools"
      title="7 · Files, Source Control and Terminal"
      now="each replaces the chat as a full page, with plain buttons and a path list"
    >
      <Option
        letter="A"
        title="Full-page tabs, IDE layout"
        why="Keep the tabs but give Files a real tree and editor. The save state is always next to the file name."
      >
        <Workspace>
          <header className="ra-bar">
            <Tabs active="Files" />
          </header>
          <div className="ra-ide">
            <div className="ra-tree">
              <span><Folder size={12} /> src</span>
              <span className="is-nested"><Folder size={12} /> auth</span>
              <span className="is-nested2 is-active"><FileText size={12} /> redirect.ts</span>
              <span className="is-nested2"><FileText size={12} /> session.ts</span>
              <span><FileText size={12} /> package.json</span>
            </div>
            <div className="ra-editor">
              <div className="ra-row-between ra-editor-head">
                <span>redirect.ts · Edited</span>
                <button type="button" className="gyro-primary-button">Save to host</button>
              </div>
              <pre className="ra-diff">
                {"export async function finish(request, user) {\n  await setSession(response, user);\n  const next = readNext(request);\n  return redirect(next ?? \"/\");\n}"}
              </pre>
            </div>
          </div>
        </Workspace>
      </Option>
      <Option
        letter="B"
        title="Side panel next to the chat"
        why="Tools open beside the chat, as they do locally. You can review changes while the agent keeps working."
      >
        <div className="ra-split">
          <div className="ra-split-main">
            <Messages />
            <Composer />
          </div>
          <aside className="ra-split-side">
            <div className="ra-row-between">
              <strong><GitBranch size={12} /> remote/fix-login</strong>
              <span className="ra-faint">2 changes</span>
            </div>
            <span className="ra-scm"><b className="is-mod">M</b> src/auth/redirect.ts</span>
            <span className="ra-scm"><b className="is-add">A</b> src/auth/redirect.test.ts</span>
            <input className="ra-input" aria-label="Commit message" placeholder="Commit message" readOnly />
            <button type="button" className="gyro-primary-button">Commit on MacBook Pro</button>
          </aside>
        </div>
      </Option>
      <Option
        letter="C"
        title="Terminal drawer"
        why="The terminal slides up under the chat, so you can watch a command run on the host without losing the thread."
      >
        <Workspace>
          <Messages />
          <div className="ra-drawer">
            <div className="ra-row-between">
              <span className="ra-inline">
                <SquareTerminal size={12} /> zsh · MacBook Pro
              </span>
              <SettingsStatus status="info">Running</SettingsStatus>
            </div>
            <pre className="ra-term">
              {"$ pnpm test --filter @gyro-dev/ui\n ✓ redirect.test.ts (3)\n ✓ session.test.ts (5)\n Test Files  2 passed"}
            </pre>
          </div>
          <Composer />
        </Workspace>
      </Option>
    </Board>
  );
}

const boards: Record<string, () => React.JSX.Element> = {
  settings: SettingsBoard,
  pairing: PairingBoard,
  header: HeaderBoard,
  home: HomeBoard,
  offline: OfflineBoard,
  approval: ApprovalBoard,
  tools: ToolsBoard,
};
const only = params.get("board");
createRoot(document.getElementById("root")!).render(
  <div className="ra-page">
    {Object.entries(boards)
      .filter(([key]) => !only || key === only)
      .map(([key, B]) => (
        <B key={key} />
      ))}
  </div>,
);
