/** Development tools on the actual production React app. Fixture data only. */
import { writeTourRecord } from "../../../packages/ui/src/first-run-tour";
import reviewCss from "../../../mockups/chat-thread/styles.css?inline";

const query = new URLSearchParams(location.search);
writeTourRecord(localStorage, "dismissed");
const root = document.documentElement;
root.id = "gyro-chat-design-preview";
root.dataset.chatDesign = "applied";
const scenes = [
  ["finished", "Finished · code & files", "active-chat", "code-block"],
  ["lists", "Lists · wrapped & numbered", "active-chat", "markdown-lists"],
  ["streaming", "Live run", "active-chat", "streaming"],
  ["split", "Two real panes", "active-chat", "split"],
  ["stacked", "Stacked panes", "active-chat", "stacked"],
  ["three", "Three real panes", "active-chat", "three"],
  ["start", "Empty composer", "welcome", ""],
  ["approval", "Approval request", "active-chat", "inline-approval"],
  ["question", "Agent question", "active-chat", "question"],
] as const;

if (query.get("review") !== "0") {
  const style = document.createElement("style");
  style.textContent = reviewCss;
  document.head.append(style);
  const tools = document.createElement("details");
  tools.className = "chat-design-review";
  tools.setAttribute("aria-label", "Design review tools");
  tools.innerHTML = `<summary>Design preview <span>Applied</span></summary>
    <div class="chat-design-review-body">
      <header><strong>Production Gyro design</strong><span>Real components · fixture data</span></header>
      <label>State<select data-preview-scene>${scenes.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
      <label>Theme<select data-preview-theme><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label>Interface size<select data-preview-size><option value="small">Small</option><option value="default">Default</option><option value="large">Large</option></select></label>
      <p>This is the shipped stylesheet on the actual React app. Resize the window for narrow layouts.</p>
      <p>Repository and provider responses are fixtures.</p>
      <footer><button type="button" data-hide-review>Hide tools</button><span>⌥D show / hide</span></footer>
    </div>`;
  document.body.append(tools);
  const state = tools.querySelector<HTMLSelectElement>("[data-preview-scene]")!;
  state.value =
    scenes.find(
      ([, , scene, edge]) =>
        scene === query.get("scene") && edge === (query.get("edge") ?? ""),
    )?.[0] ?? "finished";
  state.addEventListener("change", () => {
    const selected = scenes.find(([id]) => id === state.value)!;
    const url = new URL(location.href);
    url.searchParams.set("scene", selected[2]);
    url.searchParams.set("edge", selected[3]);
    url.searchParams.set("reset", "1");
    location.assign(url);
  });
  for (const name of ["theme", "size"] as const) {
    const select = tools.querySelector<HTMLSelectElement>(
      `[data-preview-${name}]`,
    )!;
    select.value = query.get(name) ?? (name === "theme" ? "dark" : "default");
    select.addEventListener("change", () => {
      const url = new URL(location.href);
      url.searchParams.set(name, select.value);
      url.searchParams.set("reset", "1");
      location.assign(url);
    });
  }
  tools.querySelector("[data-hide-review]")!.addEventListener("click", () => {
    tools.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.code === "KeyD") {
      event.preventDefault();
      tools.hidden = !tools.hidden;
    }
  });
}

// Auto-start the live fixture through the actual React textarea/Send handler.
// No DOM is added or replaced within #root. React owns all subsequent state.
const prompt =
  "The sync queue retries forever when the server returns 503. Add a bounded retry with backoff, and cover it with a test.";
const deadline = performance.now() + 30_000;
let started = false;
let mountedAt: number | undefined;
const ready = window.setInterval(() => {
  if (performance.now() > deadline) {
    window.clearInterval(ready);
    root.dataset.chatPreviewReady = "timeout";
    return;
  }
  if (
    !document.querySelector(".gyro-app-shell") ||
    document.querySelector(".gyro-early-shell")
  )
    return;
  const skipTour = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.trim() === "Skip tour");
  if (skipTour) {
    skipTour.click();
    return;
  }
  if (query.get("environment") === "closed")
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close environment"]')
      ?.click();
  if (
    query.get("scene") === "active-chat" &&
    !document.querySelector(".gyro-chat-surface.is-thread") &&
    query.get("edge") !== "streaming"
  ) {
    const session = [
      ...document.querySelectorAll<HTMLButtonElement>(".gyro-sidebar button"),
    ].find((button) =>
      button.textContent?.trim().startsWith("Bound the sync queue retries"),
    );
    if (session) {
      session.click();
      return;
    }
  }
  if (query.get("edge") === "streaming") {
    if (document.querySelector(".gyro-run.is-live")) {
      root.dataset.chatPreviewReady = "true";
      window.clearInterval(ready);
      return;
    }
    const input = document.querySelector<HTMLTextAreaElement>(
      ".gyro-composer-shell textarea",
    );
    const send = document.querySelector<HTMLButtonElement>(".gyro-send-button");
    if (!input || !send) return;
    if (!started) {
      started = true;
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, prompt);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (!send.disabled && !send.classList.contains("is-stop")) send.click();
    return;
  }
  if (document.querySelector(".gyro-composer-shell")) {
    mountedAt ??= performance.now();
    // Tour and saved panel state mount after the composer. Let those React
    // effects settle before declaring the preview ready.
    if (performance.now() - mountedAt < 1500) return;
    root.dataset.chatPreviewReady = "true";
    window.clearInterval(ready);
  }
}, 100);

// Inline review CSS is a module dependency, not a production stylesheet. A
// clean reload prevents stale tools/timers during edits without re-executing
// main.tsx as an imported dependency and mounting a second React root.
import.meta.hot?.accept(() => location.reload());
