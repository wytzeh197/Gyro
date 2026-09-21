// Optional richer DOM checks. Usage: GYRO_TEST_JSDOM=/absolute/path/to/jsdom/lib/api.js node scripts/site/check-runtime.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as utils from "../../site/release-utils.js";
const { JSDOM } = await import(process.env.GYRO_TEST_JSDOM || "jsdom");
const source = readFileSync(
  new URL("../../site/app.js", import.meta.url),
  "utf8",
).replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/release-utils.js";\s*/, "");
const snapshot = JSON.parse(
  readFileSync(new URL("../../site/content/releases.json", import.meta.url)),
);
const latest = snapshot.releases.find((r) => !r.prerelease);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function page({
  live = latest,
  liveFails = false,
  snapshotFails = false,
  hint = null,
  clipboardFails = false,
  route = "install/index.html",
} = {}) {
  const dom = new JSDOM(
    readFileSync(new URL("../../site/dist/" + route, import.meta.url), "utf8"),
    { url: "https://usegyro.io/", runScripts: "outside-only" },
  );
  const w = dom.window;
  w.fetch = async () => {
    if (snapshotFails) throw new Error("offline");
    return { ok: true, json: async () => snapshot };
  };
  Object.defineProperty(w.navigator, "userAgentData", {
    value: { getHighEntropyValues: async () => hint },
  });
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      writeText: async () => {
        if (clipboardFails) throw new Error("denied");
      },
    },
  });
  Object.assign(w, utils, {
    fetchGitHubJson: async () => {
      if (liveFails) throw new Error("rate limit");
      return live;
    },
  });
  new vm.Script(source).runInContext(dom.getInternalVMContext());
  await tick();
  await tick();
  return { dom, w, q: (selector) => w.document.querySelector(selector) };
}
let count = 0;
async function scenario(name, fn) {
  await fn();
  console.log("PASS " + name);
  count++;
}
await scenario("offline API preserves verified architecture link", async () => {
  const { dom, q } = await page({ liveFails: true });
  assert.match(q('[data-role="download-link"]').href, /_aarch64.dmg$/);
  assert.match(q('[data-role="release-fallback"]').textContent, /snapshot/);
  dom.window.close();
});
await scenario(
  "Intel hint updates snapshot link even when live refresh fails",
  async () => {
    const { dom, q } = await page({
      liveFails: true,
      hint: { platform: "macOS", architecture: "x86" },
    });
    assert(q('input[value="intel"]').checked);
    assert.match(q('[data-role="download-link"]').href, /_x64.dmg$/);
    dom.window.close();
  },
);
await scenario(
  "manual architecture changes update the link and checksum",
  async () => {
    const { dom, w, q } = await page();
    const input = q('input[value="intel"]');
    input.checked = true;
    input.dispatchEvent(new w.Event("change"));
    assert.match(q('[data-role="download-link"]').href, /_x64.dmg$/);
    assert.equal(
      q('[data-role="digest"]').textContent,
      utils.sha256FromDigest(utils.selectReleaseAssets(latest).intel.digest),
    );
    dom.window.close();
  },
);
await scenario(
  "missing Intel asset is never mislabeled as a download",
  async () => {
    const live = {
      ...latest,
      assets: latest.assets.filter((a) => !a.name.endsWith("_x64.dmg")),
    };
    const { dom, w, q } = await page({ live });
    q('input[value="intel"]').checked = true;
    q('input[value="intel"]').dispatchEvent(new w.Event("change"));
    assert.equal(q('[data-role="download-link"]').href, latest.html_url);
    assert.match(q('[data-role="asset-meta"]').textContent, /unavailable/);
    assert(q('[data-role="copy-checksum"]').disabled);
    dom.window.close();
  },
);
await scenario("missing checksum disables copy", async () => {
  const live = {
    ...latest,
    assets: latest.assets.map((a) => ({ ...a, digest: null })),
  };
  const { dom, q } = await page({ live });
  assert(q('[data-role="copy-checksum"]').disabled);
  assert.match(q('[data-role="digest"]').textContent, /SHA256SUMS/);
  dom.window.close();
});
await scenario("clipboard denial exposes selectable hash", async () => {
  const { dom, q } = await page({ clipboardFails: true });
  q('[data-role="copy-checksum"]').click();
  await tick();
  assert.equal(q('[data-role="copy-checksum"]').textContent, "Select the hash");
  assert.equal(dom.window.document.activeElement, q('[data-role="digest"]'));
  dom.window.close();
});
await scenario(
  "malformed and unsafe live releases preserve snapshot",
  async () => {
    for (const live of [
      {},
      { ...latest, html_url: "javascript:alert(1)" },
      { ...latest, prerelease: true },
      { ...latest, draft: true },
    ]) {
      const { dom, q } = await page({ live });
      assert.match(q('[data-role="download-link"]').href, /_aarch64.dmg$/);
      dom.window.close();
    }
  },
);
await scenario("stale response cannot replace newer snapshot", async () => {
  const { dom, q } = await page({
    live: {
      ...latest,
      tag_name: "v0.1.0-alpha.21",
      published_at: "2020-01-01T00:00:00Z",
    },
  });
  assert.match(q('[data-role="release-version"]').textContent, /49/);
  dom.window.close();
});
await scenario("all requests fail: static links remain", async () => {
  const { dom, q } = await page({ snapshotFails: true, liveFails: true });
  assert.equal(q(".static-downloads").hidden, false);
  assert.match(q(".static-downloads").textContent, /Intel/);
  assert.equal(q(".enhanced-download").hidden, true);
  dom.window.close();
});
await scenario(
  "workflow selection exposes exactly one matching panel",
  async () => {
    const { dom, q } = await page({ route: "index.html" });
    q('[data-stage="review"]').click();
    assert.equal(q('[data-panel="review"]').hidden, false);
    assert.equal(q('[data-panel="chat"]').hidden, true);
    assert.equal(
      q('[data-stage="review"]').getAttribute("aria-pressed"),
      "true",
    );
    dom.window.close();
  },
);
await scenario(
  "without scripts, all workflow content and both architecture links are present",
  async () => {
    for (const route of ["index.html", "install/index.html"]) {
      const dom = new JSDOM(
        readFileSync(
          new URL("../../site/dist/" + route, import.meta.url),
          "utf8",
        ),
      );
      if (route === "index.html")
        assert.equal(
          [...dom.window.document.querySelectorAll("[data-panel]")].filter(
            (x) => !x.hidden,
          ).length,
          3,
        );
      else
        assert.equal(
          dom.window.document.querySelectorAll(".static-downloads a").length,
          2,
        );
      dom.window.close();
    }
  },
);
console.log(`${count} DOM scenarios passed.`);
