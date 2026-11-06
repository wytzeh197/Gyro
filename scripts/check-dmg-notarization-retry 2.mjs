// Drives the Sign, notarize, and staple step from .github/workflows/release.yml.
// A fake notarytool stands in for Apple so a dropped --wait is re-queried and
// stapler runs only after status is Accepted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  join(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);
const stepStart = workflow.indexOf("- name: Sign, notarize, and staple macOS DMG");
const stepEnd = workflow.indexOf("- name: Verify macOS DMG");
assert.ok(stepStart !== -1 && stepEnd > stepStart, "DMG notarization step exists");
const step = workflow.slice(stepStart, stepEnd);
const runHeader = "run: |\n";
const runAt = step.indexOf(runHeader);
const envAt = step.indexOf("\n        env:\n");
assert.ok(runAt !== -1 && envAt > runAt, "DMG notarization step has a run script");
const script = step
  .slice(runAt + runHeader.length, envAt)
  .split("\n")
  .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
  .join("\n")
  .replaceAll("${{ matrix.target }}", "aarch64-apple-darwin");

const droppedWaitLog =
  'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline." ' +
  "NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/e8dbce3d-86ad-40ec-8d33-9553517736bf?";

const xcrun = `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "stapler" ]; then
  if [ "\${2:-}" != "staple" ]; then
    echo "unexpected stapler invocation: \$*" >&2
    exit 1
  fi
  printf '%s\\n' "$3" >> "$GYRO_FAKE_STAPLED"
  exit 0
fi
if [ "\${1:-}" != "notarytool" ]; then
  echo "unexpected xcrun invocation: \$*" >&2
  exit 1
fi
action="$2"
case "$action" in
  submit)
    if [ -f "$GYRO_FAKE_SUBMIT_STDERR" ]; then
      cat "$GYRO_FAKE_SUBMIT_STDERR" >&2
    fi
    if [ -s "$GYRO_FAKE_SUBMIT_STDOUT" ]; then
      cat "$GYRO_FAKE_SUBMIT_STDOUT"
    fi
    exit "\${GYRO_FAKE_SUBMIT_EXIT:-1}"
    ;;
  info)
    printf '%s\\n' "$3" >> "$GYRO_FAKE_INFO_IDS"
    n=$(wc -l < "$GYRO_FAKE_INFO_IDS" | tr -d ' ')
    response="$GYRO_FAKE_RESPONSES/$n"
    if [ ! -f "$response" ]; then
      echo "no fake notarytool info response for call $n" >&2
      exit 1
    fi
    if [ "$(cat "$response")" = "FAIL" ]; then
      echo "fake notarytool info network failure" >&2
      exit 1
    fi
    cat "$response"
    ;;
  log)
    printf '%s\\n' "$3" >> "$GYRO_FAKE_LOG_IDS"
    ;;
  *)
    echo "unexpected notarytool action: $action" >&2
    exit 1
    ;;
esac
`;

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runCase(name, configure) {
  const root = mkdtempSync(join(tmpdir(), "gyro-dmg-notary-"));
  const bin = join(root, "bin");
  const responses = join(root, "responses");
  mkdirSync(bin);
  mkdirSync(responses);
  mkdirSync(join(root, "target/aarch64-apple-darwin/release/bundle/dmg"), {
    recursive: true,
  });
  const dmg = join(
    root,
    "target/aarch64-apple-darwin/release/bundle/dmg/Gyro_0.1.0-preview_aarch64.dmg",
  );
  writeFileSync(dmg, "not a real dmg");
  writeExecutable(join(bin, "xcrun"), xcrun);
  writeExecutable(join(bin, "codesign"), "#!/bin/bash\nexit 0\n");
  writeExecutable(
    join(bin, "sleep"),
    "#!/bin/bash\nprintf '%s\\n' \"$*\" >> \"$GYRO_FAKE_SLEEPS\"\nexit 0\n",
  );
  const submitStderr = join(root, "submit-stderr.txt");
  const submitStdout = join(root, "submit-stdout.txt");
  const stapled = join(root, "stapled.txt");
  const infoIds = join(root, "info-ids.txt");
  const logIds = join(root, "log-ids.txt");
  const sleeps = join(root, "sleeps.txt");
  writeFileSync(submitStderr, "");
  writeFileSync(submitStdout, "");
  const scriptPath = join(root, "notarize.sh");
  writeFileSync(scriptPath, script);
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: process.env.HOME,
    RUNNER_TEMP: join(root, "runner-temp"),
    GYRO_KEYCHAIN_PATH: join(root, "signing.keychain-db"),
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (TN2974MHRB)",
    GYRO_APPLE_API_KEY_PATH: join(root, "AuthKey.p8"),
    APPLE_API_KEY: "TESTKEY",
    APPLE_API_ISSUER: "test-issuer",
    GYRO_FAKE_STAPLED: stapled,
    GYRO_FAKE_INFO_IDS: infoIds,
    GYRO_FAKE_LOG_IDS: logIds,
    GYRO_FAKE_SLEEPS: sleeps,
    GYRO_FAKE_RESPONSES: responses,
    GYRO_FAKE_SUBMIT_STDERR: submitStderr,
    GYRO_FAKE_SUBMIT_STDOUT: submitStdout,
    GYRO_FAKE_SUBMIT_EXIT: "1",
  };
  mkdirSync(env.RUNNER_TEMP);
  configure({ submitStderr, submitStdout, responses, env });
  const result = spawnSync("bash", [scriptPath], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    name,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
    stapled: existsSync(stapled) ? readFileSync(stapled, "utf8").trim() : "",
    infoIds: existsSync(infoIds) ? readFileSync(infoIds, "utf8").trim() : "",
    logIds: existsSync(logIds) ? readFileSync(logIds, "utf8").trim() : "",
  };
}

const droppedWait = runCase("dropped wait then Accepted", ({ submitStderr, responses }) => {
  writeFileSync(submitStderr, `${droppedWaitLog}\n`);
  writeFileSync(responses + "/1", '{"status":"In Progress","id":"e8dbce3d-86ad-40ec-8d33-9553517736bf"}\n');
  writeFileSync(responses + "/2", '{"status":"Accepted","id":"e8dbce3d-86ad-40ec-8d33-9553517736bf"}\n');
});
assert.equal(droppedWait.status, 0, droppedWait.stderr);
assert.match(droppedWait.stderr, /re-querying/);
assert.match(droppedWait.stderr, /DMG notarization status: Accepted/);
assert.equal(droppedWait.infoIds, "e8dbce3d-86ad-40ec-8d33-9553517736bf\ne8dbce3d-86ad-40ec-8d33-9553517736bf");
assert.match(droppedWait.stapled, /Gyro_0\.1\.0-preview_aarch64\.dmg$/);
assert.equal(droppedWait.logIds, "");
assert.doesNotMatch(droppedWait.stderr, /finished with status 'unknown'/);

const alreadyAccepted = runCase("wait already Accepted", ({ submitStdout, env }) => {
  writeFileSync(
    submitStdout,
    '{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","status":"Accepted"}\n',
  );
  env.GYRO_FAKE_SUBMIT_EXIT = "0";
});
assert.equal(alreadyAccepted.status, 0, alreadyAccepted.stderr);
assert.equal(alreadyAccepted.infoIds, "");
assert.match(alreadyAccepted.stapled, /Gyro_0\.1\.0-preview_aarch64\.dmg$/);
assert.doesNotMatch(alreadyAccepted.stderr, /re-querying/);

const rejected = runCase("re-query returns Invalid", ({ submitStderr, responses }) => {
  writeFileSync(submitStderr, `${droppedWaitLog}\n`);
  writeFileSync(responses + "/1", '{"status":"Invalid","id":"e8dbce3d-86ad-40ec-8d33-9553517736bf"}\n');
});
assert.equal(rejected.status, 1, rejected.stderr);
assert.equal(rejected.stapled, "");
assert.equal(rejected.logIds, "e8dbce3d-86ad-40ec-8d33-9553517736bf");
assert.match(rejected.stderr, /finished with status 'Invalid'/);

const infoRecovers = runCase("info network failure then Accepted", ({ submitStderr, responses }) => {
  writeFileSync(submitStderr, `${droppedWaitLog}\n`);
  writeFileSync(responses + "/1", "FAIL\n");
  writeFileSync(responses + "/2", '{"status":"Accepted","id":"e8dbce3d-86ad-40ec-8d33-9553517736bf"}\n');
});
assert.equal(infoRecovers.status, 0, infoRecovers.stderr);
assert.match(infoRecovers.stderr, /notarytool info failed/);
assert.match(infoRecovers.stderr, /DMG notarization status: Accepted/);
assert.match(infoRecovers.stapled, /Gyro_0\.1\.0-preview_aarch64\.dmg$/);

const noSubmission = runCase("dropped wait with no submission id", ({ submitStderr }) => {
  writeFileSync(submitStderr, "Error: The Internet connection appears to be offline.\n");
});
assert.equal(noSubmission.status, 1, noSubmission.stderr);
assert.equal(noSubmission.stapled, "");
assert.equal(noSubmission.infoIds, "");
assert.match(noSubmission.stderr, /finished with status 'unknown'/);

console.log(
  "DMG notarization retry passed: dropped wait re-queries, Accepted staples, Invalid and a missing id do not.",
);
