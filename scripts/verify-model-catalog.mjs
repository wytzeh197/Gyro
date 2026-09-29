#!/usr/bin/env node

/**
 * Confirms that the catalog the public site serves is the catalog this commit
 * records.
 *
 * Deployment is manual, so nothing else catches a document published from a
 * working tree nobody committed. That gap is not cosmetic: the next
 * `pnpm site:deploy` from a clean checkout republishes the committed document
 * and silently withdraws whatever is live, with no self-healing path back.
 *
 * This needs the network, so it stays out of `pnpm release:check` and is run
 * deliberately after a catalog deploy.
 *
 * `--local` is the pre-deploy gate `pnpm site:deploy` runs: no network, and it
 * also refuses uncommitted changes anywhere under site/, because the deploy
 * uploads the working tree. Both modes parse the document with the app's own
 * parser, so a catalog every client would reject is never published, and warn
 * when origin/main records a different catalog, since the next deploy from a
 * clean main checkout would publish that one instead.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelCatalog } from "../packages/ui/src/remote-model-catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = "site/model-catalog.json";
const liveUrl = "https://usegyro.io/model-catalog.json";
const requestTimeoutMs = 10_000;
const maxBytes = 256 * 1024;

const localOnly = process.argv.includes("--local");
const failures = [];
const warnings = [];
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: maxBytes * 4,
    stdio: ["ignore", "pipe", "pipe"],
  });
const parses = (label, source) => {
  try {
    parseModelCatalog(source);
    return true;
  } catch (error) {
    failures.push(`${label} is rejected by the app's parser: ${error.message}`);
    return false;
  }
};
const revisionOf = (source) => {
  try {
    return JSON.parse(source).revision ?? "(no revision)";
  } catch {
    return "(unparseable)";
  }
};

const disk = readFileSync(resolve(repoRoot, catalogPath), "utf8");
let committed;
try {
  committed = execFileSync("git", ["show", `HEAD:${catalogPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: maxBytes,
  });
} catch (error) {
  failures.push(
    `Could not read HEAD:${catalogPath} (${String(error.message).trim()}); ` +
      "the deployed catalog would have no commit behind it.",
  );
}

if (committed !== undefined) {
  if (committed === disk) {
    console.log(`${catalogPath} matches HEAD (revision ${revisionOf(disk)}).`);
  } else {
    failures.push(
      `${catalogPath} is not what HEAD records: the working tree is revision ` +
        `${revisionOf(disk)} and HEAD is revision ${revisionOf(committed)}. ` +
        "Commit the catalog before it is deployed, or a later deploy from a " +
        "clean checkout withdraws it.",
    );
  }
}

parses(catalogPath, disk);

if (localOnly) {
  let dirty = "";
  try {
    dirty = git("status", "--porcelain", "--untracked-files=all", "--", "site").trim();
  } catch (error) {
    failures.push(`Could not read git status for site/: ${String(error.message).trim()}`);
  }
  if (dirty) {
    failures.push(
      "site/ has uncommitted changes, and the deploy uploads the working tree:\n" +
        dirty
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
    );
  }
}

try {
  git("fetch", "--quiet", "origin", "main");
} catch {
  /* Offline: compare against the last fetched origin/main. */
}
try {
  const onMain = git("show", `origin/main:${catalogPath}`);
  if (onMain !== disk) {
    warnings.push(
      `origin/main records revision ${revisionOf(onMain)}, not ${revisionOf(disk)}. ` +
        "Merge this catalog promptly: a deploy from a clean main checkout would " +
        "publish main's catalog and withdraw this one.",
    );
  }
} catch {
  warnings.push("Could not read origin/main's catalog to compare.");
}

let live;
try {
  if (localOnly) throw new Error("skipped");
  const response = await fetch(liveUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // The desktop client reads any body, but these headers are what keep the
  // one-minute propagation promise and stop a browser sniffing the document.
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    failures.push(`${liveUrl} is served as "${type}", not application/json.`);
  }
  const cache = response.headers.get("cache-control") ?? "";
  if (!/max-age=(\d+)/.test(cache) || Number(cache.match(/max-age=(\d+)/)[1]) > 60) {
    failures.push(`${liveUrl} caches for longer than a minute ("${cache}").`);
  }
  live = await response.text();
  if (Buffer.byteLength(live, "utf8") > maxBytes) {
    throw new Error("response exceeds the catalog size limit");
  }
} catch (error) {
  if (!localOnly) failures.push(`Could not read ${liveUrl}: ${error.message}`);
}

if (live !== undefined && parses(liveUrl, live)) {
  if (live === disk) {
    console.log(
      `${liveUrl} serves this working tree (revision ${revisionOf(disk)}).`,
    );
  } else {
    failures.push(
      `${liveUrl} is revision ${revisionOf(live)}, but this tree is revision ` +
        `${revisionOf(disk)}. Commit the catalog, run \`pnpm site:deploy\`, ` +
        "then verify again.",
    );
  }
}

for (const warning of warnings) console.warn(`Warning: ${warning}`);

if (failures.length > 0) {
  console.error("\nModel catalog is not reproducibly published:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  localOnly
    ? `The catalog is committed and valid (revision ${revisionOf(disk)}); site/ is clean to deploy.`
    : `The live model catalog is the committed catalog, revision ${revisionOf(disk)}.`,
);
