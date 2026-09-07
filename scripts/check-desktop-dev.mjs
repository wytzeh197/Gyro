import assert from "node:assert/strict";
import { createServer } from "node:net";
import { availableDevPort, desktopDevArgs } from "./desktop-dev.mjs";

const occupied = createServer();
await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
try {
  const preferred = occupied.address().port;
  const port = await availableDevPort(preferred);
  assert.ok(port > preferred, "An occupied port must be skipped");
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
  const args = desktopDevArgs(port, ["--no-watch"]);
  const config = JSON.parse(args[args.indexOf("--config") + 1]);
  assert.equal(config.build.devUrl, `http://127.0.0.1:${port}`);
  assert.equal(
    config.build.beforeDevCommand,
    `pnpm exec vite --host 127.0.0.1 --port ${port}`,
  );
  assert.equal(args.at(-1), "--no-watch");
  assert.equal(
    await availableDevPort(port),
    port,
    "A free port should be retained",
  );
} finally {
  await new Promise((resolve) => occupied.close(resolve));
}
console.log(
  "Desktop startup checks passed: occupied ports, available ports, matching Vite/Tauri URLs, argument forwarding.",
);
