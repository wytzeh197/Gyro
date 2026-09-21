#!/usr/bin/env node
import { writeFileSync, renameSync } from "node:fs";
import { isPublicRelease, validateSnapshot } from "../site/release-utils.js";
const source =
  "https://api.github.com/repos/wytzeh197/Gyro/releases?per_page=30";
const response = await fetch(source, {
  headers: { Accept: "application/vnd.github+json" },
  signal: AbortSignal.timeout(8000),
});
if (!response.ok)
  throw new Error(
    `GitHub returned ${response.status}; previous snapshot preserved`,
  );
const data = await response.json();
if (!Array.isArray(data))
  throw new Error("Malformed release response; previous snapshot preserved");
const releases = data
  .filter(isPublicRelease)
  .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
  .slice(0, 12)
  .map((r) => ({
    tag_name: r.tag_name,
    name: r.name,
    html_url: r.html_url,
    published_at: r.published_at,
    body: r.body,
    draft: false,
    prerelease: r.prerelease,
    assets: r.assets
      .filter((a) => a.name.endsWith(".dmg") || a.name === "SHA256SUMS")
      .map((a) => ({
        name: a.name,
        size: a.size,
        digest: a.digest ?? null,
        browser_download_url: a.browser_download_url,
      })),
  }));
const snapshot = validateSnapshot({
  source,
  retrievedAt: new Date().toISOString().slice(0, 10),
  releases,
});
if (!releases.some((r) => !r.prerelease))
  throw new Error("No default release; previous snapshot preserved");
const target = new URL("../site/content/releases.json", import.meta.url);
const temp = new URL("../site/content/releases.json.tmp", import.meta.url);
writeFileSync(temp, JSON.stringify(snapshot, null, 2) + "\n");
renameSync(temp, target);
console.log(
  `Saved ${releases.length} verified public releases. Rebuild the site to use them.`,
);
