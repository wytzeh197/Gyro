import { readFileSync } from "node:fs";
import { providers } from "../content/providers.mjs";
import {
  selectReleaseAssets,
  sha256FromDigest,
  formatBytes,
  releaseAnchor,
  parseReleaseNoteBlocks,
  cleanMarkdownText,
  validateSnapshot,
} from "../release-utils.js";
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const snapshot = validateSnapshot(
  JSON.parse(
    readFileSync(new URL("../content/releases.json", import.meta.url)),
  ),
);
export const latest = snapshot.releases.find((r) => !r.prerelease);
export const link = (url, text, cls = "text-link") =>
  `<a class="${cls}" href="${esc(url)}">${text}</a>`;
export const section = (id, title, body) =>
  `<section id="${id}" class="reading-section"><h2>${title}</h2>${body}</section>`;
export const code = (text) =>
  `<pre role="region" tabindex="0" aria-label="Code example"><code>${esc(text)}</code></pre>`;
export const next = (url, title, description) =>
  `<aside class="next-step"><p>${description}</p>${link(url, title)}</aside>`;
export function workflow(selected = null, compact = false) {
  const stages = [
    [
      "chat",
      "Direct the work",
      "Give the agent a bounded task.",
      "Ask for a retry limit and a test before changing anything else.",
      `<div class="demo-prompt">The sync queue keeps retrying on a 503. Stop after five attempts, use exponential backoff, and test recovery and failure.</div><div class="activity"><span class="status-dot"></span> Read sync.mjs and sync.test.mjs</div><p>I’ll cap the attempts at five and preserve the last error. The waits will be 100, 200, 400, and 800 ms.</p><div class="activity"><span class="status-dot"></span> Updated the retry loop and its two tests</div><div class="composer">Describe a task or ask a follow-up…</div>`,
    ],
    [
      "terminal",
      "Run a local check",
      "Check what the change actually does.",
      "Run the sample’s tests locally. A passing test proves these cases, not the whole project.",
      `<div class="terminal"><p>$ node --test sync.test.mjs</p><p class="pass">✔ recovers after a transient failure<br>✔ stops after five failed attempts</p><p>tests 2<br>pass 2<br>fail 0</p><p class="terminal-cursor">$ <span aria-hidden="true">▌</span></p></div>`,
    ],
    [
      "review",
      "Inspect the result",
      "Read the change before keeping it.",
      "The final failure is returned to the caller. Check the diff and decide whether that matches your task.",
      `<div class="diff-title">sync.mjs <span>Retry limit and backoff</span></div><pre class="diff" role="region" tabindex="0" aria-label="Retry code diff"><code><span class="removed">− while (true) {</span><span class="added">+ for (let attempt = 0; attempt &lt; 5; attempt++) {</span><span>    try {</span><span>      return await send();</span><span>    } catch (error) {</span><span class="added">+     if (attempt === 4) throw error;</span><span class="removed">−     await wait(100);</span><span class="added">+     await wait(100 * 2 ** attempt);</span><span>    }</span><span>  }</span></code></pre>`,
    ],
  ];
  const shown = selected ? stages.filter((s) => s[0] === selected) : stages;
  return `<div class="workflow" data-workflow${compact ? ' data-initial-stage="review"' : ""}>${!selected ? `<div class="workflow-controls" hidden>${stages.map((s, i) => `<button type="button" data-stage="${s[0]}" aria-pressed="${i === 0}" aria-controls="stage-${s[0]}"><span>${i + 1}</span>${s[1]}</button>`).join("")}</div>` : ""}${shown.map((s) => `<section class="workflow-panel" id="stage-${s[0]}" data-panel="${s[0]}"><div class="demo-window"><div class="window-bar"><span class="window-dots" aria-hidden="true">● ● ●</span><span>retry-demo</span><span>Gyro / ${s[0] === "chat" ? "Chat" : s[0] === "terminal" ? "Terminal" : "Review"}</span></div><div class="demo-workspace"><aside class="demo-sidebar"><span>Projects</span><strong>retry-demo</strong><span class="demo-selected">Bound the retries</span><span>Files</span><span>sync.mjs</span><span>sync.test.mjs</span></aside><div class="demo-content">${s[4]}</div></div></div><div class="stage-caption"><h2>${s[2]}</h2>${compact ? "" : `<p>${s[3]}</p>`}</div></section>`).join("")}<p class="demo-disclosure">${compact ? "Illustrated example. Tested sample code." : "Illustrative workflow using a tested sample. This is not a live agent session."}</p></div>`;
}
export function providerRows() {
  return `<div class="provider-table">${providers.map((p) => `<article class="provider-row"><div><h3>${p.name}</h3><span class="tag">${p.kind}</span></div><div><p>${p.requires}</p><p class="muted">${p.limits}</p></div><div><span class="support-status">${p.status}</span>${link("/docs/providers/#" + p.id, "Setup guide")}</div></article>`).join("")}</div>`;
}
export function releaseNotes(body) {
  return parseReleaseNoteBlocks(body)
    .map((b) =>
      b.type === "heading"
        ? `<h3>${esc(cleanMarkdownText(b.text))}</h3>`
        : b.type === "list"
          ? `<ul>${b.items.map((x) => `<li>${esc(cleanMarkdownText(x))}</li>`).join("")}</ul>`
          : b.type === "code"
            ? code(b.text)
            : `<p>${esc(cleanMarkdownText(b.text))}</p>`,
    )
    .join("");
}
export function releaseEntries() {
  return snapshot.releases
    .map(
      (r) =>
        `<article class="release-entry" id="${releaseAnchor(r.tag_name)}"><header><time datetime="${r.published_at}">${r.published_at.slice(0, 10)}</time><h2>${esc(r.name || r.tag_name)}</h2>${link(r.html_url, "Release on GitHub")}</header><div class="release-notes-content">${releaseNotes(r.body)}</div></article>`,
    )
    .join("");
}
export function download() {
  const a = selectReleaseAssets(latest);
  const hash = sha256FromDigest(a.appleSilicon?.digest);
  return `<div class="download-box" data-download-surface><p class="release-meta"><strong data-role="release-version">${esc(latest.tag_name)}</strong> <span data-role="release-date">${latest.published_at.slice(0, 10)}</span></p><fieldset class="architecture-selector" hidden><legend>Choose your Mac processor</legend><label><input type="radio" name="architecture" value="apple-silicon" checked> Apple Silicon</label><label><input type="radio" name="architecture" value="intel"> Intel</label></fieldset><p data-role="architecture-status" aria-live="polite">Check Apple menu → About This Mac before choosing.</p><div class="enhanced-download" hidden>${link(a.appleSilicon?.browser_download_url || latest.html_url, '<span data-role="download-label">Download DMG</span>', "button primary").replace("<a ", '<a data-role="download-link" ')}<p data-role="asset-meta">Apple Silicon · ${formatBytes(a.appleSilicon?.size)}</p></div><div class="static-downloads">${link(a.appleSilicon?.browser_download_url || latest.html_url, a.appleSilicon ? "Download for Apple Silicon" : "Find Apple Silicon builds on GitHub", "button primary")}${link(a.intel?.browser_download_url || latest.html_url, a.intel ? "Download for Intel" : "Find Intel builds on GitHub", "button secondary")}</div><p>${link(latest.html_url, "Release notes").replace("<a ", '<a data-role="release-notes-link" ')} · ${link(a.checksums?.browser_download_url || latest.html_url, "SHA256SUMS").replace("<a ", '<a data-role="checksums-link" ')} · ${link("https://github.com/wytzeh197/Gyro/releases", "Previous releases")}</p><details class="checksum-disclosure"><summary>Verify your download</summary><p>Download SHA256SUMS from this release. Run <code>shasum -a 256</code> followed by the path to your DMG. The result must match its exact filename in SHA256SUMS.</p><div class="selected-checksum" hidden><p>SHA-256 for selected DMG</p><code data-role="digest" tabindex="0">${hash || "Checksum unavailable"}</code><button type="button" data-role="copy-checksum" ${hash ? "" : "disabled"} data-hash="${hash || ""}">Copy checksum</button></div></details><p class="muted" data-role="release-fallback">Release snapshot checked ${snapshot.retrievedAt}. ${link("https://github.com/wytzeh197/Gyro/releases/latest", "Check the latest on GitHub")}.</p></div>`;
}

export function interfaceFilm() {
  return `<section class="interface-section"><div class="section-heading"><h2>A look inside the workspace.</h2><p>The conversation sits alongside your project and workspace tools. This interface illustration uses example content; the retry walkthrough above explains the task in detail.</p></div><figure class="product-stage"><div class="film-frame"><img class="film-poster film-light" src="/assets/screenshots/hero-light-1200.webp" width="1200" height="750" loading="lazy" alt="Gyro interface with project navigation, an agent conversation, and workspace tools."><img class="film-poster film-dark" src="/assets/screenshots/hero-1200.webp" width="1200" height="750" loading="lazy" alt="Gyro interface in dark mode with project navigation, an agent conversation, and workspace tools."><video class="workflow-film" muted playsinline loop preload="none" aria-label="Silent example of the Gyro interface"></video></div><figcaption><span>Illustrated interface walkthrough. Example content.</span><button type="button" class="motion-toggle" hidden>Play demo</button></figcaption></figure></section>`;
}
