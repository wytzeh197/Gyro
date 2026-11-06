import React, { useState, useRef, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../../packages/ui/src/styles.css";
import { Window } from "./kit/window";
import { Stage } from "./kit/stage";
import { Avatar } from "./kit/parts/Avatar";
import { Icon } from "./kit/parts/Icon";
import StaticCard from "./examples/static-card";
import "./review.css";

function PreviewFrame({
  children,
  dark = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 320, height: 800 });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (host.current && content.current) {
        const width = host.current.clientWidth;
        const height = content.current.offsetHeight;
        setSize((previous) =>
          previous.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      }
    });
    observer.observe(host.current!);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="preview-frame">
      <Stage
        width={size.width}
        height={size.height}
        theme={dark ? "dark" : "light"}
        fidelity="realistic"
        tokens={{
          "--ss-font": "var(--gyro-font-sans)",
          "--ss-text-strong": "var(--gyro-text)",
          "--ss-surface": "var(--gyro-pane)",
        }}
      >
        {() => <div ref={content}>{children}</div>}
      </Stage>
    </div>
  );
}

const groups = {
  App: ["General", "Appearance", "Keyboard Shortcuts"],
  Workflow: ["Workspace", "Import Projects", "Tools"],
  Agents: ["Models & Providers", "CLI Profiles", "Efficiency", "Permissions"],
  Support: ["Updates", "Advanced", "Help"],
};
type State = "out" | "off" | "ready" | "locked";
function Sidebar({
  state,
  name = "Wytze",
  selected = "General",
  email = "wytze@example.com",
  plan = "Pro",
  choose = () => {},
}: {
  state: State;
  name?: string;
  email?: string;
  plan?: string | null;
  selected?: string;
  choose?: (page: string) => void;
}) {
  return (
    <aside className="review-sidebar">
      <div className="settings-title">Settings</div>
      <button
        className={"identity " + (selected === "Account" ? "active" : "")}
        onClick={() => choose("Account")}
      >
        {state === "out" ? (
          <span className="account-icon">
            <Icon name="user" size={18} />
          </span>
        ) : (
          <Avatar name={name || email} size={34} />
        )}
        <span className="identity-text">
          <strong>{state === "out" ? "Gyro Account" : name || email}</strong>
          {(state === "out" || !name || plan) && (
            <small>
              {state === "out" ? "Sign in" : name ? plan : "Add your name"}
            </small>
          )}
        </span>
      </button>
      {state !== "out" && (
        <button
          className={"cloud-link " + (selected === "Cloud" ? "active" : "")}
          onClick={() => choose("Cloud")}
        >
          <strong>Cloud</strong>
          <small>
            {state === "ready"
              ? "Backup ready"
              : state === "locked"
                ? "Unlock backup"
                : "Set up backup"}
          </small>
        </button>
      )}
      {Object.entries(groups).map(([group, pages]) => (
        <section key={group}>
          <div className="nav-label">{group}</div>
          {pages.map((page) => (
            <button
              key={page}
              className={selected === page ? "active" : ""}
              onClick={() => choose(page)}
            >
              {page}
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
function Account({
  signedIn = true,
  initialEdit = false,
  onName = () => {},
  onSign = () => {},
}: {
  signedIn?: boolean;
  initialEdit?: boolean;
  onName?: (name: string) => void;
  onSign?: (signed: boolean) => void;
}) {
  const [name, setName] = useState("Wytze");
  const [draft, setDraft] = useState(name);
  const [editing, edit] = useState(initialEdit);
  const [error, setError] = useState("");
  const [fail, setFail] = useState(false);
  const [signed, sign] = useState(signedIn);
  const [emailStep, step] = useState(false);
  return (
    <>
      <div className="page-title">Account</div>
      <p className="intro">
        {signed
          ? "Manage your Gyro profile and sign-in."
          : "You can use Gyro without an account. Sign in to back up and restore selected chats with Gyro Cloud."}
      </p>
      {!signed ? (
        <>
          {emailStep && (
            <div className="field">
              <label>
                Email
                <input type="email" placeholder="you@example.com" />
              </label>
              <label>
                Sign-in link or code
                <input placeholder="Paste your link or enter your code" />
              </label>
              <p className="muted">Preview only · no email is sent.</p>
            </div>
          )}
          <button
            className="primary"
            onClick={() =>
              emailStep ? (sign(true), onSign(true)) : step(true)
            }
          >
            {emailStep ? "Continue preview" : "Sign in"}
          </button>
        </>
      ) : (
        <>
          <div className="section-label">Profile</div>
          <div className="person">
            <Avatar name={name || "Wytze"} size={34} />
            <div>
              <strong>{name || "Add your name"}</strong>
              <small>wytze@example.com</small>
            </div>
          </div>
          <div className="field">
            <label>Display name</label>
            {editing ? (
              <>
                <input
                  aria-label="Display name"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <p className="muted">Your name appears in your Gyro profile.</p>
                {error && (
                  <p role="alert" className="error">
                    {error}
                  </p>
                )}
                <div className="actions">
                  <button
                    onClick={() => {
                      edit(false);
                      setError("");
                      setDraft(name);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      if (fail) {
                        setError("Your name couldn’t be saved. Try again.");
                        return;
                      }
                      setName(draft.trim());
                      onName(draft.trim());
                      edit(false);
                      setError("");
                    }}
                  >
                    Save
                  </button>
                </div>
              </>
            ) : (
              <div className="setting-row">
                <span>{name || "Add your name"}</span>
                <button onClick={() => edit(true)}>Edit</button>
              </div>
            )}
          </div>
          <div className="setting-row">
            <div>
              Sign-in email<small>wytze@example.com</small>
            </div>
          </div>
          <div className="section-label">Plan</div>
          <div className="setting-row">Gyro Pro</div>
          <div className="section-label">Sign-in</div>
          <div className="setting-row">
            <span>Signed in on this device</span>
            <button
              onClick={() => {
                sign(false);
                onSign(false);
              }}
            >
              Sign out
            </button>
          </div>
          <div className="preview-options">
            <label>
              <input
                type="checkbox"
                checked={fail}
                onChange={(e) => setFail(e.target.checked)}
              />{" "}
              Simulate a failed name save
            </label>
          </div>
        </>
      )}
    </>
  );
}
function Cloud({
  initial = "ready",
  initialLibrary = false,
}: {
  initial?: State;
  initialLibrary?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [setup, setSetup] = useState(false);
  const [library, showLibrary] = useState(initialLibrary);
  const [items, setItems] = useState([
    "Homepage feedback",
    "Release notes",
    "Onboarding ideas",
  ]);
  const [restored, restore] = useState<string[]>([]);
  const [remove, setRemove] = useState("");
  const [menu, setMenu] = useState("");
  if (library)
    return (
      <>
        <button className="back" onClick={() => showLibrary(false)}>
          ← Cloud
        </button>
        <div className="page-title">Cloud Chats</div>
        <p className="intro">Restore an encrypted backup to this device.</p>
        {items.length ? (
          items.map((title, i) => (
            <div className="setting-row" key={title}>
              <div>
                <strong>{title}</strong>
                <small>Last backed up · {i ? "Yesterday" : "Today"}</small>
              </div>
              <button onClick={() => restore([...restored, title])}>
                {restored.includes(title) ? "Restored" : "Restore"}
              </button>
              <div className="chat-menu">
                <button
                  aria-label={"More actions for " + title}
                  aria-expanded={menu === title}
                  onClick={() => setMenu(menu === title ? "" : title)}
                >
                  <Icon name="more" size={16} />
                </button>
                {menu === title && (
                  <button
                    onClick={() => {
                      setRemove(title);
                      setMenu("");
                    }}
                  >
                    Delete cloud copy
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p>
            No cloud chats yet. Choose “Back up to Cloud” from a chat’s menu.
          </p>
        )}
        {remove && (
          <div className="confirmation">
            <strong>Delete cloud copy of “{remove}”?</strong>
            <p>Your downloaded chat stays on this device.</p>
            <div className="actions">
              <button onClick={() => setRemove("")}>Cancel</button>
              <button
                onClick={() => {
                  setItems(items.filter((item) => item !== remove));
                  setRemove("");
                }}
              >
                Delete cloud copy
              </button>
            </div>
          </div>
        )}
      </>
    );
  return (
    <>
      <div className="page-title">Cloud</div>
      <p className="intro">
        Back up selected chats and restore them on another device.
      </p>
      <div className="section-label">Chat backup</div>
      <strong>
        {state === "ready"
          ? "Ready on this device"
          : state === "locked"
            ? "Unlock your backups"
            : "Set up encrypted backup"}
      </strong>
      <p>
        {state === "ready"
          ? "Choose “Back up to Cloud” from a chat’s menu to save an encrypted copy."
          : state === "locked"
            ? "Enter your recovery code to access your existing backups."
            : "Save your recovery code to get started."}
      </p>
      {state === "locked" && (
        <label>
          Recovery code
          <input placeholder="Enter your recovery code" />
        </label>
      )}
      {setup && (
        <div className="confirmation">
          <code>DEMO-CODE · PREVIEW ONLY</code>
          <p>Save your recovery code somewhere safe.</p>
          <button
            onClick={() =>
              navigator.clipboard.writeText("DEMO-CODE · PREVIEW ONLY")
            }
          >
            Copy code
          </button>
        </div>
      )}
      <button
        className="primary"
        onClick={() => {
          if (state === "ready") showLibrary(true);
          else if (state === "locked" || setup) setState("ready");
          else setSetup(true);
        }}
      >
        {state === "ready"
          ? "Open Cloud Chats"
          : state === "locked"
            ? "Unlock backup"
            : setup
              ? "I saved the code"
              : "Set up backup"}
      </button>
      <div className="section-label">Recovery</div>
      <strong>Keep your recovery code safe</strong>
      <p>
        You’ll need it to unlock backups on another device, even after signing
        in.
      </p>
    </>
  );
}
function ResponsiveAccountFrame({ children }: { children: React.ReactNode }) {
  const [wide, setWide] = useState(window.innerWidth > 900);
  useLayoutEffect(() => {
    const resize = () => setWide(window.innerWidth > 900);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return wide ? (
    <Window title="Gyro Settings">{children}</Window>
  ) : (
    <>{children}</>
  );
}
function App() {
  const [profileName, setProfileName] = useState("Wytze");
  const [profileSigned, setProfileSigned] = useState(true);
  const [dark, theme] = useState(
    new URLSearchParams(location.search).get("theme") === "dark",
  );
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return (
    <main className="review">
      <header>
        <div>
          <div className="eyebrow">GYRO / DESIGN REVIEW</div>
          <h1>Account & Cloud</h1>
          <p>A personal profile. Optional backup. A quieter Settings.</p>
        </div>
        <button onClick={() => theme(!dark)}>
          {dark ? "Light" : "Dark"} mode
        </button>
      </header>
      <h2>One familiar sidebar, three states</h2>
      <div className="comparison">
        {(["out", "off", "ready"] as State[]).map((state, i) => (
          <figure key={state}>
            <figcaption>
              {
                [
                  "No account",
                  "Signed in · Cloud off",
                  "Signed in · Cloud ready",
                ][i]
              }
            </figcaption>
            <PreviewFrame dark={dark}>
              <Sidebar state={state} />
            </PreviewFrame>
          </figure>
        ))}
      </div>
      <h2>A place for your profile</h2>
      <PreviewFrame dark={dark}>
        <ResponsiveAccountFrame>
          <div className="window">
            <Sidebar
              state={profileSigned ? "ready" : "out"}
              name={profileName}
              selected="Account"
            />
            <article>
              <Account
                initialEdit
                onName={setProfileName}
                onSign={setProfileSigned}
              />
            </article>
          </div>
        </ResponsiveAccountFrame>
      </PreviewFrame>
      <h2>Backup, when you need it</h2>
      <PreviewFrame dark={dark}>
        <article className="cloud-detail">
          <Cloud />
        </article>
      </PreviewFrame>
      <h2>Your backed-up chats</h2>
      <PreviewFrame dark={dark}>
        <div className="library-preview">
          <article>
            <Cloud initialLibrary />
          </article>
        </div>
      </PreviewFrame>
      <h2>Getting started & recovery</h2>
      <div className="state-grid">
        <article>
          <Account signedIn={false} />
        </article>
        <article>
          <Cloud initial="locked" />
        </article>
        <article>
          <Cloud initial="off" />
        </article>
      </div>
      <h2>Profile edge cases</h2>
      <div className="comparison edge-cases">
        <PreviewFrame dark={dark}>
          <Sidebar
            state="off"
            name=""
            email="wytze.hemrica.long.account.name@example.com"
          />
        </PreviewFrame>
        <PreviewFrame dark={dark}>
          <Sidebar state="off" plan={null} />
        </PreviewFrame>
        <PreviewFrame dark={dark}>
          <Sidebar state="locked" />
        </PreviewFrame>
      </div>
      <footer>
        Interactive design fixture · sample account, plan, and chats · changes
        stay in this preview
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("gold") ? <StaticCard /> : <App />,
);
