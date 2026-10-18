/**
 * Settings spacing fixture.
 *
 * Renders the General settings page markup with the production class names and
 * the real stylesheets (styles.css plus the settings-design.css layer the
 * settings components import), so spacing can be inspected without booting
 * Tauri IPC. Fixture data mirrors the real General page labels; nothing here is
 * wired up.
 */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@gyro-dev/ui/styles.css";
// Side-effect import: the settings modules pull in settings-design.css, the
// layer that actually styles the rows and groups shown below.
import "@gyro-dev/ui";

function Switch({ on = true }: { on?: boolean }) {
  return (
    <button
      aria-checked={on}
      className={`gyro-settings-switch${on ? " is-on" : ""}`}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

function Select({ value }: { value: string }) {
  return (
    <span className="gyro-settings-select-field">
      <select className="gyro-settings-select" defaultValue={value}>
        <option>{value}</option>
      </select>
      <svg
        aria-hidden="true"
        fill="none"
        height="13"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width="13"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}

function Segmented() {
  return (
    <div className="gyro-settings-segmented" role="group">
      <button aria-pressed="false" type="button">
        Off
      </button>
      <button aria-pressed="true" className="is-active" type="button">
        Peek
      </button>
      <button aria-pressed="false" type="button">
        Follow
      </button>
    </div>
  );
}

function Row({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="gyro-settings-row">
      <div>
        <strong>{label}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <div className="gyro-settings-control-column">{children}</div>
    </div>
  );
}

function Group({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="gyro-settings-group">
      <h2>{label}</h2>
      {description ? (
        <p className="gyro-settings-group-description">{description}</p>
      ) : null}
      <div className="gyro-settings-group-rows">{children}</div>
    </section>
  );
}

const sections = [
  "General",
  "Appearance",
  "Keyboard Shortcuts",
  "Models, Accounts & Limits",
  "Efficiency",
  "CLI Profiles",
  "Permissions",
  "Workspace",
  "Tools",
  "Import projects",
  "Updates",
  "Advanced",
  "Help",
];

function Fixture() {
  return (
    <div className="preview-shell">
      <style>{`
        html, body, #root { height: 100%; margin: 0; }
        body { background: var(--gyro-app); color: var(--gyro-text); font-family: var(--gyro-font-sans); }
        .preview-shell { height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
        .preview-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 16px;
          border-bottom: 1px solid var(--gyro-border); font-size: 12px; color: var(--gyro-muted); }
        .preview-bar b { color: var(--gyro-text); font-weight: 600; }
        .preview-frame { min-height: 0; display: grid; }
        .preview-frame .gyro-settings-surface { height: 100%; align-content: start; }
      `}</style>
      <div className="preview-bar">
        <b>Settings spacing fixture</b>
        <span>Production markup and stylesheets · fixture data only</span>
      </div>
      <div className="preview-frame">
        <div className="gyro-settings-surface">
          <nav aria-label="Settings sections" className="gyro-settings-nav">
            {sections.map((section) => (
              <button
                className={section === "General" ? "is-active" : ""}
                key={section}
                type="button"
              >
                {section}
              </button>
            ))}
          </nav>
          <section
            aria-label="Settings"
            className="gyro-settings-content"
            data-settings-page="general"
          >
            <section className="gyro-settings-section">
              <header>
                <div>
                  <h1>General</h1>
                  <span>
                    Choose how Gyro stays available and responds to model
                    activity.
                  </span>
                </div>
              </header>
              <div className="gyro-settings-section-body">
                <Group label="App behavior">
                  <Row
                    detail="Choose what Gyro shows when it starts. Applies the next time Gyro opens."
                    label="Open on launch"
                  >
                    <Select value="Where you left off" />
                  </Row>
                  <Row
                    detail="Show Gyro in the macOS menu bar for quick access to running work."
                    label="Menu bar"
                  >
                    <Switch />
                  </Row>
                </Group>

                <Group
                  description="Choose what needs your attention while work runs in the background."
                  label="macOS notifications"
                >
                  <Row
                    detail="macOS permission is needed. Send a test to request access."
                    label="Notifications"
                  >
                    <Switch />
                  </Row>
                  <Row
                    detail="When a model needs your approval. Click the notification to open its chat."
                    label="Approval requests"
                  >
                    <Switch />
                  </Row>
                  <Row
                    detail="When a chat or automation completes."
                    label="Finished work"
                  >
                    <Switch />
                  </Row>
                  <Row
                    detail="When a chat or automation stops with an error."
                    label="Failures"
                  >
                    <Switch />
                  </Row>
                  <Row
                    detail="Sends a sample so you can check how Gyro's notifications look."
                    label="Test notification"
                  >
                    <button className="gyro-secondary-button" type="button">
                      Send test
                    </button>
                  </Row>
                </Group>

                <Group label="Model activity">
                  <Row
                    detail="Preview model activity above the composer and keep your current view."
                    label="Model activity previews"
                  >
                    <Segmented />
                  </Row>
                  <Row
                    detail="Use one extra provider call after an edited turn to describe each changed file."
                    label="Post-edit summaries"
                  >
                    <Switch on={false} />
                  </Row>
                </Group>
              </div>
            </section>
          </section>
        </div>
      </div>
    </div>
  );
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
