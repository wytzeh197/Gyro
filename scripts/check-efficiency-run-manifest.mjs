import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureRunSources, assertSameSources, captureRunManifest, sha256,
} from "./efficiency-run-manifest.mjs";

test("provenance detects tracked, untracked and deleted source inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "gyro-run-manifest-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "-q");
    await mkdir(join(root, "crates/demo/src"), { recursive: true });
    await writeFile(join(root, "Cargo.toml"), "[workspace]\n");
    const source = join(root, "crates/demo/src/lib.rs");
    await writeFile(source, "pub fn answer() -> u8 { 1 }\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-qm", "fixture");
    const baseline = await captureRunSources(root);
    assertSameSources(baseline, await captureRunSources(root));
    await writeFile(source, "pub fn answer() -> u8 { 2 }\n");
    const changed = await captureRunSources(root);
    assert.throws(() => assertSameSources(baseline, changed), /changed/);
    assert.notEqual(changed.sourceSnapshot, baseline.sourceSnapshot);
    await writeFile(join(root, "crates/demo/src/new.rs"), "// untracked\n");
    const added = await captureRunSources(root);
    assert.notEqual(added.sourceSnapshot, changed.sourceSnapshot);
    await rm(source);
    const deleted = await captureRunSources(root);
    assert.ok(deleted.files.find((file) => file.path.endsWith("/lib.rs")).deleted);
    assert.notEqual(deleted.sourceSnapshot, added.sourceSnapshot);
    await writeFile(join(root, "binary"), "fixture executable");
    const manifest = await captureRunManifest(
      deleted, join(root, "binary"), { variants: ["baseline"] }, false,
    );
    assert.equal(manifest.buildCoverage, "unverified-skip-build");
    assert.equal(manifest.binarySha256, sha256("fixture executable"));
    assert.equal(manifest.sourceSnapshot, deleted.sourceSnapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
