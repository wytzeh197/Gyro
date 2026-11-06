// Execute the workflow's source gates against disposable Git history.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  join(repo, ".github/workflows/release.yml"),
  "utf8",
);
function script(name) {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `${name} must exist`);
  const run = workflow.indexOf("run: |\n", start) + "run: |\n".length;
  const end = workflow.indexOf("\n        env:\n", run);
  assert.ok(run > start && end > run);
  return workflow
    .slice(run, end)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}
const request = script("Validate release request");
const source = script("Verify immutable merged release source");
assert.ok(
  workflow.indexOf("Validate release request") <
    workflow.indexOf("Resolve Developer ID or ad-hoc signing"),
);
assert.ok(
  workflow.indexOf("Use TCP for Apple notarization tickets") <
    workflow.indexOf("- name: Build desktop app and sign updater archive"),
);
for (const job of ["macos", "native_intel", "verify", "finalize"]) {
  const match = workflow.match(new RegExp(`\\n  ${job}:([\\s\\S]*?)(?=\\n  [a-z_]+:|$)`));
  assert.ok(match?.[1].includes("ref: ${{ needs.signing.outputs.commit }}"), `${job} must checkout the approved commit`);
}
const root = mkdtempSync(join(tmpdir(), "gyro-release-source-"));
function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
try {
  git("init", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "release-fixture@example.invalid");
  writeFileSync(join(root, "package.json"), '{"version":"0.1.0-preview.3"}\n');
  git("add", "package.json");
  git("commit", "-m", "Approved release fixture");
  const approved = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", approved);
  git("tag", "v0.1.0-preview.3");
  git("tag", "v0.1.0-preview.9");
  git("checkout", "-b", "unmerged");
  writeFileSync(join(root, "package.json"), '{"version":"0.1.0-preview.4"}\n');
  git("commit", "-am", "Unmerged release fixture");
  const unmerged = git("rev-parse", "HEAD");
  git("tag", "v0.1.0-preview.4");
  function run(
    name,
    {
      tag = "v0.1.0-preview.3",
      commit = approved,
      head = approved,
      accepted = false,
    } = {},
  ) {
    git("checkout", "--detach", head);
    const output = join(root, "output.txt");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", request + "\n" + source], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        RELEASE_TAG: tag,
        EXPECTED_COMMIT: commit,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status === 0, accepted, `${name}: ${result.stderr}`);
    assert.equal(
      readFileSync(output, "utf8"),
      accepted ? `commit=${commit}\n` : "",
      `${name}: rejected requests must not expose a signing source`,
    );
  }
  run("approved merged tag", { accepted: true });
  run("wrong commit", { commit: "0".repeat(40) });
  run("wrong checkout", { head: unmerged });
  run("unmerged tag", {
    tag: "v0.1.0-preview.4",
    commit: unmerged,
    head: unmerged,
  });
  run("version mismatch", { tag: "v0.1.0-preview.9" });
  run("missing tag", { tag: "v0.1.0-preview.8" });
  run("invalid tag input", { tag: "v0.1.0;exit 0" });
  run("missing commit input", { commit: "" });
  run("abbreviated commit", { commit: approved.slice(0, 7) });
  git("checkout", "main");
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(repo, "scripts/release-identity.mjs"), join(root, "scripts/release-identity.mjs"));
  writeFileSync(join(root, "package.json"), '{"version":"0.1.0"}\n');
  writeFileSync(join(root, "release-identity.json"), '{"version":"0.1.0","tag":"v0.1.0-launch.20261106"}\n');
  git("add", "package.json", "release-identity.json", "scripts/release-identity.mjs");
  git("commit", "-m", "Approved launch identity fixture");
  const modern = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", modern);
  git("tag", "v0.1.0-launch.20261106");
  git("tag", "v0.1.0-launch.20261107");
  run("approved launch identity", { tag: "v0.1.0-launch.20261106", commit: modern, head: modern, accepted: true });
  run("wrong launch identity", { tag: "v0.1.0-launch.20261107", commit: modern, head: modern });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(
  "Release recovery passed: approved immutable merged source accepted; wrong commits, checkouts, versions, missing or unmerged tags and malformed requests rejected.",
);
