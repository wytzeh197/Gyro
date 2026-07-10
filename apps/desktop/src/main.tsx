import "@gyro-dev/ui/styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./theme.css";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
