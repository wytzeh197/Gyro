// Every regression guard must be reachable from something that actually runs:
// a package.json script, a CI workflow, or another guard that is itself
// reachable. Seven guards shipped in the 49.x line and sat in scripts/ with no
// runner wired to them; this check makes that state uncommittable. It also
// requires scripts/verification-map.json to classify every guard, so a
// source-text guard is a recorded decision with a reason, never an accident.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const guards = (await readdir(new URL("scripts/", root)))
  .filter((name) => /^check-.+\.mjs$/.test(name))
  .sort();

const entryTexts = [await readFile(new URL("package.json", root), "utf8")];
for (const name of await readdir(new URL(".github/workflows/", root))) {
  if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
  entryTexts.push(
    await readFile(new URL(`.github/workflows/${name}`, root), "utf8"),
  );
}
const entryText = entryTexts.join("\n");

// Reachability closure over every script in scripts/: entry points first, then
// whatever a reached script references (run-canvas-preview-browser starts its
// guard; check-download-site runs its build/runtime halves).
const scripts = (await readdir(new URL("scripts/", root))).filter((name) =>
  name.endsWith(".mjs"),
);
const reachable = new Set(scripts.filter((name) => entryText.includes(name)));
const pending = [...reachable];
while (pending.length > 0) {
  const script = pending.pop();
  const source = await readFile(new URL(`scripts/${script}`, root), "utf8");
  for (const candidate of scripts) {
    if (reachable.has(candidate) || !source.includes(candidate)) continue;
    reachable.add(candidate);
    pending.push(candidate);
  }
}
const orphans = guards.filter((name) => !reachable.has(name));
assert.deepEqual(
  orphans,
  [],
  `guards exist with no runner: ${orphans.join(", ")} - wire each one into a package.json script, a CI workflow, or another guard that runs`,
);

const map = JSON.parse(
  await readFile(new URL("scripts/verification-map.json", root), "utf8"),
);
assert.deepEqual(
  Object.keys(map).sort(),
  guards,
  "scripts/verification-map.json must classify exactly the guard scripts in scripts/",
);
for (const [name, entry] of Object.entries(map)) {
  assert.ok(
    entry.kind === "behavioral" || entry.kind === "source-text",
    `${name}: kind must be "behavioral" or "source-text"`,
  );
  if (entry.kind === "source-text") {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.length > 0,
      `${name}: source-text guards must record a reason`,
    );
  }
}
const behavioral = guards.filter((name) => map[name].kind === "behavioral");
console.log(
  `guard registry checks passed (${guards.length} guards reachable; ${behavioral.length} behavioral, ${guards.length - behavioral.length} source-text)`,
);
