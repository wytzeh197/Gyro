import assert from "node:assert/strict";
import {
  automaticBrowserDevice,
  browserViewportGeometry,
} from "../packages/ui/src/browser-viewport.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

for (const url of [
  "http://localhost:1420",
  "http://127.0.0.1:123",
  "http://[::1]:123",
])
  assert.equal(automaticBrowserDevice(url), "desktop");
for (const url of [
  "https://example.com",
  "http://app.localhost:123",
  "ftp://localhost:123",
  "https://localhost.example.com",
  "https://127.0.0.1.example.com",
  "invalid",
])
  assert.equal(automaticBrowserDevice(url), "responsive");
assert.deepEqual(
  browserViewportGeometry("desktop", { width: 480, height: 300 }),
  { width: 1280, height: 800, scale: 0.375, left: 0 },
);
assert.deepEqual(
  browserViewportGeometry("desktop", { width: 800, height: 300 }),
  { width: 1280, height: 800, scale: 0.375, left: 160 },
);
assert.equal(
  browserViewportGeometry("desktop", { width: 2000, height: 1600 }).scale,
  1,
);
assert.equal(
  browserViewportGeometry("responsive", { width: 320, height: 500 }).width,
  320,
);
let state = createInitialWorkbenchState();
const send = (id, action) => {
  state = workbenchReducer(state, {
    type: "browser-session",
    sessionId: id,
    action,
  });
};
send("a", { type: "browser-navigate", url: "http://localhost:1420" });
assert.equal(state.browserPreviewsBySession.a.device, "desktop");
send("b", { type: "browser-navigate", url: "https://example.com" });
assert.equal(state.browserPreviewsBySession.b.device, "responsive");
send("a", { type: "browser-device", device: "mobile" });
send("a", { type: "browser-loaded", url: "https://example.com/redirect" });
assert.equal(state.browserPreviewsBySession.a.device, "mobile");
send("a", { type: "browser-device", device: "auto" });
assert.equal(state.browserPreviewsBySession.a.device, "responsive");
send("a", { type: "browser-loaded", url: "http://localhost:1420/redirect" });
assert.equal(state.browserPreviewsBySession.a.device, "desktop");
send("a", {
  type: "browser-viewport",
  viewport: {
    mode: "desktop",
    device: "desktop",
    width: 1920,
    height: 1080,
    displayScale: 0.25,
  },
});
assert.equal(state.browserPreviewsBySession.a.viewport.width, 1920);
assert.equal(state.browserPreviewsBySession.b.deviceOverride, false);
send("a", { type: "browser-close" });
assert.equal(state.browserPreviewsBySession.a.deviceOverride, false);
console.log(
  "Browser viewport: automatic local defaults, both-axis fit, manual persistence, native state and chat isolation passed",
);
