#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { pages } from "../site/content/pages.mjs";
import {
  validateSnapshot,
  selectReleaseAssets,
  sha256FromDigest,
  architectureFromHints,
  isPublicRelease,
  parseReleaseNoteBlocks,
  fetchGitHubJson,
} from "../site/release-utils.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const temp = mkdtempSync(resolve(tmpdir(), "gyro-site-check-"));
const files = (path) =>
  readdirSync(path, { withFileTypes: true })
    .flatMap((x) =>
      x.isDirectory()
        ? files(resolve(path, x.name)).map((f) => x.name + "/" + f)
        : [x.name],
    )
    .sort();
try {
  for (const name of ["a", "b"]) {
    const r = spawnSync(
      process.execPath,
      ["scripts/build-download-site.mjs", "--output", resolve(temp, name)],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
  }
  const output = resolve(temp, "a");
  const manifest = files(output);
  assert.deepEqual(manifest, files(resolve(temp, "b")));
  for (const file of manifest)
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(output, file)))
        .digest("hex"),
      createHash("sha256")
        .update(readFileSync(resolve(temp, "b", file)))
        .digest("hex"),
      `Nondeterministic ${file}`,
    );
  assert.equal(pages.length, 16);
  assert.equal(new Set(pages.map((p) => p.path)).size, pages.length);
  assert(
    !manifest.some(
      (x) =>
        /^(content|templates|fixtures|examples|node_modules)\//.test(x) ||
        x.endsWith(".mjs") ||
        x === "package.json",
    ),
    "Non-public source shipped",
  );
  const htmls = new Map(
    pages.map((p) => [
      p.path,
      readFileSync(
        resolve(
          output,
          p.path === "/"
            ? "index.html"
            : p.path.endsWith(".html")
              ? p.path.slice(1)
              : p.path.slice(1) + "index.html",
        ),
        "utf8",
      ),
    ]),
  );
  const titles = new Set();
  const descriptions = new Set();
  for (const [route, html] of htmls) {
    const title = html.match(/<title>(.*?)<\/title>/s)?.[1];
    assert(title, route);
    assert(!titles.has(title), "Duplicate title");
    titles.add(title);
    const description = html.match(/name="description" content="([^"]+)"/)?.[1];
    assert(description);
    assert(!descriptions.has(description), "Duplicate description");
    descriptions.add(description);
    assert.equal(
      (html.match(/<h1[ >]/g) || []).length,
      1,
      `${route} needs one h1`,
    );
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${route} duplicate IDs`);
    for (const text of [
      'lang="en"',
      'name="viewport"',
      'class="skip-link"',
      'id="main"',
      'aria-label="Main navigation"',
      'aria-label="Mobile navigation"',
      "data-theme-toggle",
      "Privacy &amp; Legal",
      "Security",
      "Support",
      "Attributions",
      'rel="canonical"',
      "og:image",
      "twitter:card",
      "Content-Security-Policy",
    ])
      assert(html.includes(text), `${route} missing ${text}`);
    assert(
      html.includes(`href="https://usegyro.io${route}"`),
      "Incorrect canonical",
    );
    assert(
      html.indexOf("/theme.js") < html.indexOf("/styles.css"),
      "Theme must precede stylesheet",
    );
    assert(html.includes('data-theme="light"'), "No-JS default must be light");
    assert(
      !/<[^>]+\s(?:style|onclick|onload)=/i.test(html),
      "CSP-incompatible inline behavior",
    );
    assert(!/<script(?![^>]*src=)[^>]*>\s*[^<]/i.test(html), "Inline script");
    assert(
      !/<(?:script|img|link)[^>]+(?:src|href)="https?:/i.test(
        html.replace(/<link rel="canonical"[^>]*>/g, ""),
      ),
      "Remote resource",
    );
    assert(!/href="#"/.test(html), "Placeholder link");
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(
        match[1].replace(/&amp;/g, "&"),
        "https://usegyro.io" + route,
      );
      if (url.origin !== "https://usegyro.io") continue;
      let path = url.pathname;
      const target = resolve(
        output,
        path.slice(1) + (path.endsWith("/") ? "index.html" : ""),
      );
      assert(existsSync(target), `${route} broken local URL: ${match[1]}`);
      if (url.hash) {
        const text = readFileSync(target, "utf8");
        assert(
          text.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
          `${route} broken anchor ${match[1]}`,
        );
      }
    }
  }
  const sitemap = readFileSync(resolve(output, "sitemap.xml"), "utf8");
  for (const p of pages)
    assert.equal(
      sitemap.includes(`https://usegyro.io${p.path}</loc>`),
      !p.noindex,
    );
  assert(htmls.get("/404.html").includes('content="noindex"'));
  for (const text of [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Permissions-Policy:",
    "Strict-Transport-Security:",
    "Referrer-Policy:",
  ])
    assert(read("site/_headers").includes(text), text);
  const css = read("site/styles.css");
  assert.equal((css.match(/@font-face/g) || []).length, 2);
  assert(css.includes("font-display: swap"));
  assert(css.includes(":focus-visible"));
  assert(css.includes("prefers-reduced-motion"));
  assert(css.includes("prefers-contrast"));
  assert(!/url\(["']?https?:|@import/.test(css));
  assert(
    ![...css.matchAll(/font-size:\s*(\d+)px/g)].some((m) => Number(m[1]) < 13),
  );
  const runtime = read("site/app.js");
  assert(!/navigator\.(?:userAgent(?!Data)|platform)/.test(runtime));
  assert(!/innerHTML|insertAdjacentHTML/.test(runtime));
  assert(!/(?:window\.)?location\s*=/.test(runtime));
  assert(
    !/google-analytics|googletagmanager|plausible.io|posthog/.test(
      [...htmls.values()].join("") + runtime,
    ),
  );
  const jsBytes = [
    "app.js",
    "theme.js",
    "release-utils.js",
    "motion.js",
  ].reduce((n, f) => n + gzipSync(read("site/" + f)).length, 0);
  assert(jsBytes < 100 * 1024, "Route JS exceeds 100 KiB compressed");
  const snapshot = validateSnapshot(
    JSON.parse(read("site/content/releases.json")),
  );
  const release = snapshot.releases[0];
  const assets = selectReleaseAssets(release);
  assert(assets.appleSilicon && assets.intel && assets.checksums);
  for (const tag of [
    "v0.1.0-alpha.21",
    "v0.1.0-alpha.49",
    "v0.2.0-beta.1",
    "v1.0.0-rc.1",
    "v1.0.0",
  ])
    assert(isPublicRelease({ ...release, tag_name: tag }), tag);
  for (const tag of ["v0.1.0-alpha.20", "v1.0.0-nightly.1", "nonsense"])
    assert(!isPublicRelease({ ...release, tag_name: tag }), tag);
  assert(!isPublicRelease({ ...release, draft: true }));
  assert(!isPublicRelease({ ...release, body: "Private developer preview" }));
  assert(!isPublicRelease({ ...release, html_url: "javascript:alert(1)" }));
  assert(
    !isPublicRelease({
      ...release,
      assets: [
        {
          name: "a.dmg",
          size: 1,
          browser_download_url: "https://evil.example/a.dmg",
        },
      ],
    }),
  );
  assert.equal(
    selectReleaseAssets({ ...release, assets: [] }).intel,
    undefined,
  );
  assert.equal(sha256FromDigest(null), null);
  assert.equal(sha256FromDigest("sha256:" + "a".repeat(64)), "a".repeat(64));
  assert.equal(
    architectureFromHints({ platform: "macOS", architecture: "arm" }),
    "apple-silicon",
  );
  assert.equal(
    architectureFromHints({ platform: "macOS", architecture: "x86" }),
    "intel",
  );
  assert.equal(
    architectureFromHints({ platform: "Windows", architecture: "arm" }),
    null,
  );
  assert.throws(() => validateSnapshot({ releases: [] }));
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      releases: [{ ...release, published_at: "bad" }],
    }),
  );
  assert(
    parseReleaseNoteBlocks("## Heading\n\n- one\n- two").some(
      (x) => x.type === "list" && x.items.length === 2,
    ),
  );
  const install = htmls.get("/install/");
  assert(
    install.includes(assets.appleSilicon.browser_download_url) &&
      install.includes(assets.intel.browser_download_url),
  );
  assert(
    install.includes("Open Anyway") &&
      install.includes("not Apple Developer ID signed or notarized"),
  );
  assert(!install.includes("Loading"));
  const privacy = read("site/content/privacy.html");
  assert(
    htmls.get("/privacy/").includes(privacy),
    "Legal text changed during rendering",
  );
  assert(
    htmls.get("/changelog/").includes(release.tag_name) &&
      htmls.get("/changelog/").includes(release.published_at.slice(0, 10)),
  );
  const beforeRefresh = read("site/content/releases.json");
  for (const mock of [
    'throw new Error("Simulated network failure")',
    "return {ok:false,status:429}",
    "return {ok:true,json:async()=>({malformed:true})}",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `globalThis.fetch=async()=>{${mock}}; await import('./scripts/refresh-site-releases.mjs')`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, "Invalid refresh must fail");
    assert.equal(
      read("site/content/releases.json"),
      beforeRefresh,
      "Failed refresh replaced snapshot",
    );
  }
  const originalFetch = globalThis.fetch;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  try {
    for (const status of [403, 429, 500]) {
      globalThis.fetch = async () => ({ ok: false, status });
      await assert.rejects(
        fetchGitHubJson("https://api.github.com/test"),
        new RegExp(String(status)),
      );
    }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Invalid JSON");
      },
    });
    await assert.rejects(
      fetchGitHubJson("https://api.github.com/test"),
      SyntaxError,
    );
    globalThis.setTimeout = (fn) => originalSet(fn, 1);
    globalThis.fetch = (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Aborted"))),
      );
    await assert.rejects(
      fetchGitHubJson("https://api.github.com/test"),
      /Aborted/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
  const sample = spawnSync(
    process.execPath,
    ["--test", "site/examples/retry/sync.test.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(sample.status, 0, sample.stdout + sample.stderr);
  console.log(
    `Site checks passed: ${pages.length} pages, deterministic output, local links/anchors, security, release failures, sample tests. JS: ${jsBytes} gzip bytes.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
