import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repo, "apps/desktop/src/editor/textmate");
const manifest = JSON.parse(
  readFileSync(resolve(root, "manifest.json"), "utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function asset(path) {
  const absolute = resolve(root, path);
  assert(absolute.startsWith(root + sep), `Asset must remain local: ${path}`);
  return readFileSync(absolute);
}
function includes(value, output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => includes(item, output));
  else if (value && typeof value === "object") {
    if (
      typeof value.include === "string" &&
      !value.include.startsWith("#") &&
      !value.include.startsWith("$")
    )
      output.add(value.include);
    Object.values(value).forEach((item) => includes(item, output));
  }
  return [...output].sort();
}
function canonical(scope) {
  const visited = new Set();
  while (manifest.scopeAliases[scope]) {
    assert(!visited.has(scope), `Cyclic grammar alias: ${scope}`);
    visited.add(scope);
    scope = manifest.scopeAliases[scope];
  }
  return scope;
}

assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(manifest.roots, {
  vue: "text.html.vue",
  svelte: "source.svelte",
  astro: "source.astro",
  sass: "source.sass",
});
const grammarByScope = new Map();
for (const entry of manifest.grammars) {
  const bytes = asset(entry.file);
  const grammar = JSON.parse(bytes);
  assert.equal(grammar.scopeName, entry.scopeName);
  assert.equal(manifest.scopes[entry.scopeName], entry.file);
  assert(
    !grammarByScope.has(entry.scopeName),
    `Duplicate grammar scope: ${entry.scopeName}`,
  );
  grammarByScope.set(entry.scopeName, grammar);
  assert.equal(
    hash(bytes),
    entry.provenance.bundledSha256,
    `Unexpected asset change: ${entry.file}`,
  );
  assert.match(entry.provenance.commit, /^[a-f\d]{40}$/);
  assert.match(entry.provenance.sourceSha256, /^[a-f\d]{64}$/);
  assert.equal(
    entry.provenance.url,
    `${entry.provenance.repository}/blob/${entry.provenance.commit}/${entry.provenance.path}`,
  );
  if (entry.provenance.conversion) {
    assert.equal(
      hash(asset(entry.provenance.sourceFile)),
      entry.provenance.sourceSha256,
      `Original conversion source changed: ${entry.provenance.sourceFile}`,
    );
    assert(
      ["js-yaml", "cson-parser"].includes(entry.provenance.conversion.tool),
    );
    assert(entry.provenance.conversion.version);
  } else
    assert.equal(
      entry.provenance.sourceSha256,
      entry.provenance.bundledSha256,
      "Direct JSON copies must remain byte-for-byte upstream assets.",
    );
  assert.equal(entry.license.spdx, "MIT");
  const license = asset(entry.license.file).toString("utf8");
  assert.match(license, /Permission is hereby granted/i);
  assert.match(license, /THE SOFTWARE IS PROVIDED/i);
  for (const notice of entry.license.additionalNotices ?? [])
    assert(asset(notice).length > 0);
  assert.deepEqual(
    entry.includes,
    includes(grammar),
    `Dependency manifest is stale: ${entry.scopeName}`,
  );
}
assert.deepEqual(
  Object.keys(manifest.scopes).sort(),
  [...grammarByScope.keys()].sort(),
);
for (const target of Object.values(manifest.roots))
  assert(grammarByScope.has(target));
for (const required of manifest.requiredScopes)
  assert(
    grammarByScope.has(canonical(required)),
    `Required embedded language is missing: ${required}`,
  );
for (const alias of Object.keys(manifest.scopeAliases))
  assert(
    grammarByScope.has(canonical(alias)),
    `Alias has no bundled target: ${alias}`,
  );

const optional = new Set(manifest.optionalMissingScopes);
const observedMissing = new Set();
let resolved = 0;
for (const entry of manifest.grammars) {
  for (const include of entry.includes) {
    const [scope, fragment] = include.split("#");
    const dependency = grammarByScope.get(canonical(scope));
    if (!dependency) {
      assert(
        optional.has(scope),
        `Undocumented missing dependency: ${entry.scopeName} -> ${include}`,
      );
      assert(
        !manifest.requiredScopes.includes(scope),
        `Required scope incorrectly declared optional: ${scope}`,
      );
      observedMissing.add(scope);
      continue;
    }
    if (fragment)
      assert(
        dependency.repository?.[fragment],
        `Missing repository fragment: ${entry.scopeName} -> ${include}`,
      );
    resolved++;
  }
  for (const injectionTarget of entry.injectTo)
    assert(
      grammarByScope.has(canonical(injectionTarget)),
      `Injection has no bundled target: ${entry.scopeName} -> ${injectionTarget}`,
    );
}
assert.deepEqual(
  [...observedMissing].sort(),
  [...optional].sort(),
  "Optional dependency list must exactly describe unresolved external branches.",
);
for (const runtime of manifest.runtimeLicenses) {
  const installed = JSON.parse(
    readFileSync(
      resolve(
        repo,
        "apps/desktop/node_modules",
        runtime.package,
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    installed.version,
    runtime.version,
    `Runtime license pin is stale: ${runtime.package}`,
  );
  assert.equal(hash(asset(runtime.license.file)), runtime.license.sha256);
  for (const notice of runtime.notices)
    assert.equal(hash(asset(notice.file)), notice.sha256);
}
const sassLicense = asset(
  manifest.grammars.find((entry) => entry.id === "sass").license.file,
).toString();
assert.match(sassLicense, /2014 GitHub Inc/);
assert.match(sassLicense, /2012 Alex Sancho/);
console.log(
  `TextMate assets passed: ${grammarByScope.size} pinned grammars, ${resolved} resolved includes, ${optional.size} documented optional scopes, original-source hashes and licenses.`,
);
