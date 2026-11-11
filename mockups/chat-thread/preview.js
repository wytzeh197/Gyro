// The original mockup URL now opens the actual React app.
const source = new URLSearchParams(location.search);
const url = new URL("/chat-design-preview.html", location.origin);
for (const [name, value] of source) url.searchParams.set(name, value);
const state = source.get("scene");
url.searchParams.set("scene", state === "start" ? "welcome" : "active-chat");
url.searchParams.set(
  "edge",
  state === "live" ? "streaming" : state === "split" ? "split" : "code-block",
);
url.searchParams.delete("design");
url.searchParams.delete("text");
url.searchParams.set("environment", "closed");
url.searchParams.set("reset", "1");
location.replace(url);
