import React from "react";
import ReactDOM from "react-dom/client";
import { EarlyShell } from "./early-shell";
import "./early-shell.css";
import "./theme.css";

const isMenuBarSurface =
  new URLSearchParams(window.location.search).get("surface") === "menu-bar";
document.documentElement.dataset.surface = isMenuBarSurface
  ? "menu-bar"
  : "main";

const initialTheme = (() => {
  try {
    return localStorage.getItem("gyro.theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
})();

document.documentElement.dataset.theme = initialTheme;
document
  .querySelector('meta[name="theme-color"]')
  ?.setAttribute("content", initialTheme === "light" ? "#f6f7f8" : "#101010");

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("Gyro render failed", error);
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="gyro-root-error" role="alert">
          <strong>Gyro hit a rendering error.</strong>
          <span>{this.state.error.message}</span>
        </main>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Gyro root element is missing");
}

const root = ReactDOM.createRoot(rootElement);

// Paint a chat-shaped shell immediately; the full App (and packages/ui)
// arrives asynchronously so cold start never blocks on the big modules.
if (isMenuBarSurface) {
  void Promise.all([
    import("./MenuBarPopover"),
    import("./menu-bar.css"),
    import("@gyro-dev/ui/styles.css"),
  ]).then(([{ MenuBarPopover }]) => {
    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <MenuBarPopover />
        </AppErrorBoundary>
      </React.StrictMode>,
    );
  });
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
  ]).then(([{ App }]) => {
    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>,
    );
  });
}
