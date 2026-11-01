// Development-only render of the real loading and failure components.
import { createRoot } from "react-dom/client";
import { EarlyShell } from "./early-shell";
import { AppFailure } from "./app-failure";
import "./early-shell.css";
import "./theme.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";
const state = params.get("state");
createRoot(document.getElementById("root")!).render(
  state === "startup-error" ? (
    <AppFailure startup />
  ) : state === "render-error" ? (
    <AppFailure />
  ) : (
    <EarlyShell />
  ),
);
