// Embedded production browser surface/hooks with real Tauri IPC and WebKit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeDebugExecutable } from "./build-native-debug-executable.mjs";

if (process.platform !== "darwin")
  throw new Error("Native browser acceptance requires macOS WebKit");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const geometryInputReview = process.argv.includes("--geometry-input-review");
const geometryOnly = process.argv.includes("--geometry") || geometryInputReview;
const navigationOnly = process.argv.includes("--navigation") || geometryOnly;
const root = await realpath(
  await mkdtemp(join(tmpdir(), "gyro-browser-events-native-")),
);
const data = join(root, "data"),
  frontend = join(root, "frontend");
await mkdir(data);
const manifest = { root, data, frontend, build: "pending", native: "pending" };
const save = () =>
  writeFile(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
await save();
console.log(`Native browser frontend evidence: ${root}`);
const env = {
  ...process.env,
  GYRO_TEST_DATA_DIR: data,
  GYRO_NATIVE_BROWSER_EVENTS_FRONTEND_DIR: frontend,
  GYRO_BROWSER_FRONTEND_SMOKE: "1",
  GYRO_BROWSER_NAVIGATION_SMOKE: navigationOnly ? "1" : "0",
  GYRO_BROWSER_GEOMETRY_SMOKE: geometryOnly ? "1" : "0",
  GYRO_BROWSER_GEOMETRY_INPUT_REVIEW: geometryInputReview ? "1" : "0",
  GYRO_BROWSER_FRONTEND_VISUAL_REVIEW: geometryInputReview
    ? "1"
    : process.env.GYRO_BROWSER_FRONTEND_VISUAL_REVIEW,
  // Use the same private-store asset boundaries with this isolated store's path.
  TAURI_CONFIG: JSON.stringify({
    build: { frontendDist: frontend },
    app: {
      security: {
        assetProtocol: {
          scope: [
            join(data, "browser-captures/**"),
            join(data, "sessions/attachments/**"),
          ],
        },
      },
    },
  }),
};
for (const key of [
  "GYRO_CODE_MODE_SMOKE",
  "GYRO_PERFORMANCE_BENCHMARK",
  "GYRO_BROWSER_SMOKE_URL",
  "GYRO_LSP_SMOKE",
  "GYRO_TEST_PERSIST_UI",
])
  delete env[key];
const run = (program, args, timeout) =>
  new Promise((ok, fail) => {
    const child = spawn(program, args, { cwd: repo, env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      code === 0 && !signal
        ? ok()
        : fail(new Error(`${program} failed (${signal ?? code})`));
    });
  });
await run(
  "pnpm",
  [
    "--filter",
    "@gyro-dev/desktop",
    "exec",
    "vite",
    "build",
    "--mode",
    "native-browser-events-smoke",
    "--emptyOutDir",
    "--logLevel",
    "warn",
  ],
  180000,
);
manifest.binary = await buildNativeDebugExecutable({
  root: repo,
  bin: "gyro-browser-events-smoke",
  features: ["native-browser-events-smoke"],
  env,
});
manifest.build = "passed";
let nativeExecutable = manifest.binary;
if (
  env.GYRO_BROWSER_FRONTEND_VISUAL_REVIEW === "1" ||
  env.GYRO_BROWSER_FRONTEND_BUNDLED === "1"
) {
  // A standalone Mach-O has no distinct app identity for native accessibility.
  // Stage this already-built executable in this run's temporary directory.
  const app = join(root, "Gyro Browser Review.app");
  const contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  nativeExecutable = join(contents, "MacOS", "gyro-browser-events-smoke");
  await copyFile(manifest.binary, nativeExecutable);
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>gyro-browser-events-smoke</string>
<key>CFBundleIdentifier</key><string>dev.gyro.browser-review</string>
<key>CFBundleName</key><string>Gyro Browser Review</string>
<key>CFBundleDisplayName</key><string>Gyro Browser Review</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
  );
  manifest.visualReviewApp = app;
  manifest.nativeExecutable = nativeExecutable;
}
await save();
const fixture = await readFile(
  join(repo, "scripts/fixtures/browser-observation.html"),
  "utf8",
);
let pageRequests = 0;
let heldImageRequests = 0;
let releasedImageRequests = 0;
let releaseImages = false;
const heldImages = new Set();
const heldDocuments = new Set();
let heldDocumentRequests = 0;
let releasedDocumentRequests = 0;
let releaseDocumentsAutomatically = false;
const heldFrames = new Set();
let blockedCredentialRequests = 0;
let failedDocumentRequests = 0;
let queuedCancelledRequests = 0;
const requestsByLabel = new Map();
let allowFailedDocument = false;
const pageNavigationFixture = (html) =>
  !navigationOnly
    ? html
    : html
        .replace(
          "<main>",
          `<main>
    <nav><a id="nav-link" href="?label=Provisional">Open next page</a>
    <form method="get"><input type="hidden" name="label" value="Provisional"><button id="nav-submit">Submit next page</button></form>
    <button id="nav-script" type="button">Script navigation</button>
    <a id="nav-prevent" href="?label=Provisional">Prevented link</a>
    <button id="nav-spa" type="button">Same-document route</button>
    <a id="nav-hash" href="#current">Same-document fragment</a>
    <button id="nav-frame" type="button">Load frame</button>
    <a id="nav-blocked" href="#">Blocked credential URL</a><output id="nav-state">Initial</output></nav>`,
        )
        .replace(
          "</body>",
          `<script>
    document.getElementById('nav-script').onclick=()=>location.assign('?label=Provisional');
    document.getElementById('nav-prevent').onclick=(event)=>{event.preventDefault();document.getElementById('nav-state').textContent='Prevented';};
    document.getElementById('nav-spa').onclick=()=>{history.pushState({},'', '?label=Original&view=spa');};
    document.getElementById('nav-frame').onclick=()=>{const frame=document.createElement('iframe');frame.hidden=true;frame.src='/held-frame.html';document.body.append(frame);};
    const blocked=new URL(location.href);blocked.username='fixture';blocked.password='fixture';blocked.search='?label=BlockedCredentials';document.getElementById('nav-blocked').href=blocked.href;
  </script></body>`,
        );
const geometryFixture = (html) =>
  !geometryOnly
    ? html
    : html.replace(
        "</body>",
        `<button id="geometry-marker" aria-label="Geometry calibration target" data-clicks="0" onclick="this.dataset.clicks=String(Number(this.dataset.clicks)+1);this.style.background='rgb(0,255,0)';this.setAttribute('aria-label','Geometry target clicked; click again to finish');" style="all:unset;position:fixed;left:80px;top:120px;width:12px;height:12px;background:rgb(255,0,255);display:block;z-index:2147483647"></button></body>`,
      );
const releaseImage = (response) => {
  heldImages.delete(response);
  releasedImageRequests++;
  response.writeHead(200, {
    "content-type": "image/gif",
    "cache-control": "no-store",
  });
  response.end(
    Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    ),
  );
};
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (navigationOnly && url.pathname === "/__gyro_navigation_control") {
    const op = url.searchParams.get("op");
    if (op === "arm") {
      releaseImages = false;
      releaseDocumentsAutomatically = false;
    } else if (op === "finish") {
      releaseDocumentsAutomatically = true;
      releaseImages = true;
    } else if (op === "release-images") {
      releaseImages = true;
      for (const held of heldImages) releaseImage(held);
    } else if (op === "allow-failed-document") {
      allowFailedDocument = true;
    } else if (op === "release-document") {
      for (const held of heldDocuments) {
        heldDocuments.delete(held);
        releasedDocumentRequests++;
        const html = fixture
          .replace(
            "Gyro Browser Observation Fixture</title>",
            "Gyro Fixture Provisional</title>",
          )
          .replace(
            "</body>",
            '<img hidden alt="" src="/held-loading-image.gif"></body>',
          );
        held.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        held.end(pageNavigationFixture(html));
      }
    } else if (op === "release-frames") {
      for (const frame of heldFrames) {
        heldFrames.delete(frame);
        frame.writeHead(200, { "content-type": "text/html" });
        frame.end("<!doctype html><html><body>Frame complete</body></html>");
      }
    } else if (op !== "state") {
      response.writeHead(400).end();
      return;
    }
    const body = JSON.stringify({
      heldDocuments: heldDocuments.size,
      heldImages: heldImages.size,
      heldFrames: heldFrames.size,
      failedDocumentRequests,
      queuedCancelledRequests,
      requestsByLabel: Object.fromEntries(requestsByLabel),
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }
  if (navigationOnly && url.pathname === "/held-frame.html") {
    heldFrames.add(response);
    response.once("close", () => heldFrames.delete(response));
    return;
  }
  if (url.pathname === "/held-loading-image.gif") {
    heldImageRequests++;
    heldImages.add(response);
    response.once("close", () => heldImages.delete(response));
    if (releaseImages) releaseImage(response);
    return;
  }
  // A private Check URL cannot contain a query string.
  const label =
    url.searchParams.get("label") ?? (geometryOnly ? "Original" : null);
  if (label) requestsByLabel.set(label, (requestsByLabel.get(label) ?? 0) + 1);
  if (label === "Failure" && !allowFailedDocument) {
    failedDocumentRequests++;
    request.socket.destroy();
    return;
  }
  if (
    navigationOnly &&
    url.pathname === "/browser-observation.html" &&
    label === "Fast"
  ) {
    pageRequests++;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      "<!doctype html><html><head><title>Gyro Fast</title></head><body>Immediate document</body></html>",
    );
    return;
  }
  if (
    navigationOnly &&
    url.pathname === "/browser-observation.html" &&
    label === "Provisional"
  ) {
    pageRequests++;
    if (releaseDocumentsAutomatically) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        pageNavigationFixture(
          fixture.replace(
            "Gyro Browser Observation Fixture</title>",
            "Gyro Fixture Provisional</title>",
          ),
        ),
      );
      return;
    }
    heldDocumentRequests++;
    heldDocuments.add(response);
    response.once("close", () => heldDocuments.delete(response));
    return;
  }
  if (
    url.pathname !== "/browser-observation.html" ||
    ![
      "Original",
      "Replacement",
      "Second",
      "Final",
      "Pending",
      "Release",
      "BlockedCredentials",
      "Failure",
      "RetryRelease",
      "QueuedCancelled",
      "QueuedReopen",
      "QueuedSuperseded",
    ].includes(label)
  ) {
    response.writeHead(404).end();
    return;
  }
  if (label === "BlockedCredentials") blockedCredentialRequests++;
  if (label === "QueuedCancelled") queuedCancelledRequests++;
  if (label === "RetryRelease") allowFailedDocument = true;
  if (label === "Release") {
    releaseImages = true;
    for (const held of heldImages) releaseImage(held);
  }
  pageRequests++;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  let html = fixture.replace(
    "Gyro Browser Observation Fixture</title>",
    `Gyro Fixture ${label}</title>`,
  );
  if (label === "Pending")
    html = html.replace(
      "</body>",
      '<img hidden alt="" src="/held-loading-image.gif"></body>',
    );
  response.end(geometryFixture(pageNavigationFixture(html)));
});
await new Promise((ok, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", ok);
});
env.GYRO_BROWSER_FRONTEND_PAGE_URL = `http://127.0.0.1:${server.address().port}/browser-observation.html`;
try {
  await run(
    nativeExecutable,
    [],
    env.GYRO_BROWSER_FRONTEND_VISUAL_REVIEW === "1" ? 380000 : 110000,
  );
  const report = JSON.parse(
    await readFile(
      join(
        data,
        navigationOnly ? "browser-navigation.json" : "browser-frontend.json",
      ),
      "utf8",
    ),
  );
  assert.equal(report.passed, true, report.error ?? "native fixture failed");
  assert.equal(report.nativeBuild, "debug-embedded-tauri-production-handlers");
  if (geometryOnly) {
    assert.ok(report.checks.length >= 70);
    assert.ok(report.checks.every((check) => check.passed));
    await run(
      "python3",
      [
        join(repo, "scripts/check-native-browser-geometry.py"),
        join(data, "browser-navigation.json"),
      ],
      20000,
    );
  } else if (navigationOnly) {
    assert.ok(report.checks.length >= 83);
    assert.ok(report.checks.every((check) => check.passed));
    assert.equal(heldDocumentRequests, 7);
    assert.equal(releasedDocumentRequests, 5);
    assert.equal(heldImageRequests, 5);
    assert.equal(releasedImageRequests, 5);
    assert.equal(blockedCredentialRequests, 0);
    assert.equal(queuedCancelledRequests, 0);
    assert.equal(requestsByLabel.get("QueuedReopen") ?? 0, 0);
    assert.equal(requestsByLabel.get("QueuedSuperseded") ?? 0, 0);
  } else {
    assert.equal(report.reportTransport, "native-evaluation-callback");
    assert.deepEqual(report.measurements.loadingState, {
      actualCompletionObserved: true,
      pendingObserved: true,
      staleLoadedRejected: true,
    });
    assert.ok(report.href.startsWith("tauri://localhost/"));
    assert.ok(report.userAgent.includes("AppleWebKit"));
    assert.ok(report.nativeCsp.includes("script-src 'self'"));
    assert.ok(report.checks.length >= 30);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.violations, []);
    assert.ok(report.captureAssetScope.length > 0);
    assert.ok(report.captureAssetScope.every((capture) => capture.allowed));
    assert.equal(report.workspaceAssetAllowed, false);
    assert.ok(pageRequests >= 4);
    assert.equal(heldImageRequests, 1);
    assert.equal(releasedImageRequests, 1);
  }
  manifest.native = "passed";
  manifest.checks = report.checks.length;
  manifest.pageRequests = pageRequests;
  manifest.requestsByLabel = Object.fromEntries(requestsByLabel);
  manifest.queuedCancelledRequests = queuedCancelledRequests;
  manifest.heldImageRequests = heldImageRequests;
  manifest.releasedImageRequests = releasedImageRequests;
  manifest.heldDocumentRequests = heldDocumentRequests;
  manifest.releasedDocumentRequests = releasedDocumentRequests;
  manifest.report = join(
    data,
    navigationOnly ? "browser-navigation.json" : "browser-frontend.json",
  );
  await save();
  console.log(
    JSON.stringify({
      passed: true,
      checks: report.checks.length,
      measurements: report.measurements,
      report: manifest.report,
    }),
  );
} catch (error) {
  manifest.native = "failed";
  manifest.error = String(error);
  manifest.pageRequests = pageRequests;
  manifest.requestsByLabel = Object.fromEntries(requestsByLabel);
  manifest.queuedCancelledRequests = queuedCancelledRequests;
  manifest.heldImageRequests = heldImageRequests;
  manifest.releasedImageRequests = releasedImageRequests;
  manifest.heldDocumentRequests = heldDocumentRequests;
  manifest.releasedDocumentRequests = releasedDocumentRequests;
  await save();
  const report = await readFile(
    join(
      data,
      navigationOnly ? "browser-navigation.json" : "browser-frontend.json",
    ),
    "utf8",
  ).catch(() => "no native report");
  console.error(report);
  throw error;
} finally {
  server.close();
  server.closeAllConnections();
}
