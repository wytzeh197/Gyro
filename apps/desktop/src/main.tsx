import React from "react";
import ReactDOM from "react-dom/client";
import { EarlyShell } from "./early-shell";
import { resolveBootSurface } from "./surface-boundary";
import "./early-shell.css";
import "./theme.css";

const bootSurface = resolveBootSurface({
  browserAgent: "__gyroBrowserAgentInstalled" in window,
  framed: window.self !== window.top,
  surface: new URLSearchParams(window.location.search).get("surface"),
});
const isMenuBarSurface = bootSurface === "menu-bar";
document.documentElement.dataset.surface = bootSurface;

const systemTheme = () =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

const initialTheme = (() => {
  try {
    const preference = localStorage.getItem("gyro.theme");
    return preference === "light" || preference === "dark"
      ? preference
      : systemTheme();
  } catch {
    return systemTheme();
  }
})();

document.documentElement.dataset.theme = initialTheme;
document
  .querySelector('meta[name="theme-color"]')
  ?.setAttribute("content", initialTheme === "light" ? "#f8f9f9" : "#181818");

function AppFailure({ startup = false }: { startup?: boolean }) {
  return (
    <main className="gyro-root-error" role="alert">
      <h1>{startup ? "Gyro couldn’t load." : "Gyro hit a rendering error."}</h1>
      <p>Reload the window to try again.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload Gyro
      </button>
    </main>
  );
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    console.error("Gyro render failed", error);
  }

  override render() {
    if (this.state.failed) return <AppFailure />;
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Gyro root element is missing");
}

const root = ReactDOM.createRoot(rootElement);

// React boundaries do not catch rejected module/CSS imports.
function reportStartupFailure(error: unknown) {
  console.error("Gyro startup failed", error);
  root.render(<AppFailure startup />);
}

// Paint a chat-shaped shell immediately; the full App (and packages/ui)
// arrives asynchronously so cold start never blocks on the big modules.
if (bootSurface === "embedded") {
  document.title = "Gyro · App interface";
  root.render(
    <main className="gyro-embedded-boundary">
      <h1>This address opens Gyro</h1>
      <p>Use the main window for Terminal, Files, Review, and Canvas.</p>
      <p>To preview your project here, enter its web address above.</p>
    </main>,
  );
} else if (isMenuBarSurface) {
  root.render(
    <main className="gyro-root-error" role="status">
      Starting Gyro…
    </main>,
  );
  void Promise.all([
    import("./MenuBarPopover"),
    import("./menu-bar.css"),
    import("@gyro-dev/ui/styles.css"),
  ])
    .then(([{ MenuBarPopover }]) => {
      root.render(
        <React.StrictMode>
          <AppErrorBoundary>
            <MenuBarPopover />
          </AppErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(reportStartupFailure);
} else {
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <EarlyShell />
      </AppErrorBoundary>
    </React.StrictMode>,
  );

  void Promise.all([
    import("./App"),
    import("@gyro-dev/ui/styles.css"),
    import("./menu-bar.css"),
  ])
    .then(([{ App }]) => {
      root.render(
        <React.StrictMode>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(reportStartupFailure);
}
