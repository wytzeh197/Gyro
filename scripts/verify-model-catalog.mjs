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
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = "site/model-catalog.json";
const liveUrl = "https://usegyro.io/model-catalog.json";
const requestTimeoutMs = 10_000;
const maxBytes = 256 * 1024;

const failures = [];
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

let live;
try {
  const response = await fetch(liveUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  live = await response.text();
  if (Buffer.byteLength(live, "utf8") > maxBytes) {
    throw new Error("response exceeds the catalog size limit");
  }
} catch (error) {
  failures.push(`Could not read ${liveUrl}: ${error.message}`);
}

if (live !== undefined) {
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

if (failures.length > 0) {
  console.error("\nModel catalog is not reproducibly published:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `The live model catalog is the committed catalog, revision ${revisionOf(disk)}.`,
);
