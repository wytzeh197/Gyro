// Compile-only and disposable-home launcher contract checks. Never executes Gyro.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagingAppIsolation } from "./cloud-staging-configuration.mjs";

if (process.platform !== "darwin") {
  console.log(
    "Staging launcher C checks require macOS; no compiler or launcher executed on this platform.",
  );
} else {
  const source = fileURLToPath(
    new URL("cloud-staging-launcher.c", import.meta.url),
  );
  const minimumSystemVersion = JSON.parse(
    readFileSync(
      new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ).bundle.macOS.minimumSystemVersion;
  assert.match(minimumSystemVersion, /^[0-9]+(?:\.[0-9]+){1,2}$/);
  const fixture = mkdtempSync(
    join(tmpdir(), "gyro-staging-launcher-contract-"),
  );
  const compileFlags = [
    "-std=c11",
    "-pedantic",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-mmacosx-version-min=${minimumSystemVersion}`,
  ];
  const project = "tpskieaxnzltdmpebdfz",
    previous = "hqyahsvqjizmsfxclxzd";
  let checks = 0;
  try {
    const compile = (input, output, ref) =>
      spawnSync(
        "/usr/bin/clang",
        [
          ...compileFlags,
          ...(ref === undefined ? [] : [`-DGYRO_STAGING_PROJECT="${ref}"`]),
          input,
          "-o",
          output,
        ],
        { encoding: "utf8" },
      );
    const binary = join(fixture, "compiled-launcher-never-run");
    const actual = compile(source, binary, project);
    assert.equal(actual.status, 0, actual.stderr);
    checks++;
    const metadata = spawnSync("/usr/bin/otool", ["-l", binary], {
      encoding: "utf8",
    });
    assert.equal(metadata.status, 0, metadata.stderr);
    const minos = /\n\s*minos\s+([0-9.]+)/.exec(metadata.stdout)?.[1];
    const versionParts = (value) =>
      value.split(".").map(Number).concat([0, 0]).slice(0, 3);
    assert.ok(
      minos,
      "Compiled staging launcher needs a macOS minimum-version load command.",
    );
    assert.deepEqual(versionParts(minos), versionParts(minimumSystemVersion));
    checks++;
    assert.notEqual(
      compile(source, join(fixture, "missing-define"), undefined).status,
      0,
    );
    assert.notEqual(
      compile(source, join(fixture, "short-define"), "short").status,
      0,
    );
    checks += 2;
    // Run the real launcher main with only passwd/executable lookup/exec replaced.
    // This exercises Finder-style environment construction inside disposable homes.
    const harnessSource = join(fixture, "launcher-contract.c");
    writeFileSync(
      harnessSource,
      `
#include <mach-o/dyld.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <unistd.h>
static const char *fixture_home, *fixture_launcher;
static struct passwd fixture_owner;
static struct passwd *fixture_getpwuid(uid_t uid) { (void)uid; fixture_owner.pw_dir = (char *)fixture_home; return &fixture_owner; }
static int fixture_executable_path(char *output, uint32_t *capacity) {
  size_t length = strlen(fixture_launcher);
  if (length + 1 > *capacity) return -1;
  memcpy(output, fixture_launcher, length + 1); return 0;
}
static int fixture_execve(const char *binary, char *const args[], char *const environment[]);
#define getpwuid fixture_getpwuid
#define _NSGetExecutablePath fixture_executable_path
#define execve fixture_execve
#define main staging_launcher_main
#include ${JSON.stringify(source)}
#undef main
#undef execve
#undef getpwuid
#undef _NSGetExecutablePath
static int fixture_execve(const char *binary, char *const args[], char *const environment[]) {
  char data[PATH_MAX], expected_data[PATH_MAX + 32], expected_home[PATH_MAX + 8], expected_binary[PATH_MAX];
  snprintf(data, sizeof(data), "%s/Library/Application Support/Gyro Cloud Staging/%s", fixture_home, staging_project);
  snprintf(expected_data, sizeof(expected_data), "GYRO_TEST_DATA_DIR=%s", data);
  snprintf(expected_home, sizeof(expected_home), "HOME=%s", fixture_home);
  if (!realpath(fixture_launcher, expected_binary)) _Exit(3);
  char *slash = strrchr(expected_binary, '/'); if (!slash) _Exit(3); *slash = '\\0';
  if (strlen(expected_binary) + strlen("/gyro-desktop") + 1 >= sizeof(expected_binary)) _Exit(3);
  strcat(expected_binary, "/gyro-desktop");
  if (strcmp(binary, expected_binary) || strcmp(args[0], binary) || args[1] ||
      !environment[0] || !environment[1] || !environment[2] || !environment[3] || environment[4] ||
      strcmp(environment[0], expected_home) || strcmp(environment[1], expected_data) ||
      strcmp(environment[2], "GYRO_TEST_PERSIST_UI=1") ||
      strcmp(environment[3], "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")) _Exit(3);
  puts(data); fflush(stdout); _Exit(0);
}
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  fixture_home = argv[1]; fixture_launcher = argv[2];
  return staging_launcher_main();
}
`,
    );
    const harnesses = new Map();
    for (const ref of [
      project,
      previous,
      "TPSKIEAXNZLTD MPEBDFZ".replaceAll(" ", ""),
    ]) {
      const path = join(fixture, `harness-${harnesses.size}`);
      const result = compile(harnessSource, path, ref);
      assert.equal(result.status, 0, result.stderr);
      harnesses.set(ref, path);
    }
    const appExecutable = join(
      fixture,
      "Fixture.app/Contents/MacOS/gyro-staging-launcher",
    );
    mkdirSync(dirname(appExecutable), { recursive: true, mode: 0o700 });
    writeFileSync(
      appExecutable,
      "fixture executable path only; never launched",
    );
    const run = (ref, home, env = {}) =>
      spawnSync(harnesses.get(ref), [home, appExecutable], {
        encoding: "utf8",
        env,
      });
    const home = join(fixture, "home");
    mkdirSync(home, { mode: 0o700 });
    const first = run(previous, home);
    assert.equal(first.status, 0, first.stderr);
    const oldRoot = join(
      home,
      "Library/Application Support/Gyro Cloud Staging",
    );
    writeFileSync(
      join(oldRoot, "retained-unscoped-profile"),
      "legacy staging sentinel",
    );
    writeFileSync(
      join(oldRoot, previous, "retained-project-profile"),
      "old project sentinel",
    );
    const expected = join(oldRoot, project);
    for (const env of [
      {},
      {
        HOME: "/untrusted-home",
        GYRO_TEST_DATA_DIR: "/untrusted-data",
        GYRO_CLOUD_V2_STAGING_AUTH_PROJECT: previous,
        GYRO_CLOUD_ENABLED: "1",
      },
    ]) {
      const result = run(project, home, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected);
      checks++;
    }
    assert.equal(
      readFileSync(join(oldRoot, "retained-unscoped-profile"), "utf8"),
      "legacy staging sentinel",
    );
    assert.equal(
      readFileSync(join(oldRoot, previous, "retained-project-profile"), "utf8"),
      "old project sentinel",
    );
    assert.equal(statSync(expected).mode & 0o777, 0o700);
    assert.notEqual(expected, join(oldRoot, previous));
    assert.equal(
      stagingAppIsolation(project).relativeDataDirectory,
      `Gyro Cloud Staging/${project}`,
    );
    checks++;
    const invalidHome = join(fixture, "invalid-ref-home");
    mkdirSync(invalidHome, { mode: 0o700 });
    assert.equal(
      run("TPSKIEAXNZLTD MPEBDFZ".replaceAll(" ", ""), invalidHome).status,
      2,
    );
    assert.ok(!existsSync(join(invalidHome, "Library")));
    checks++;
    for (const [index, relative] of [
      "Library",
      "Library/Application Support",
      "Library/Application Support/Gyro Cloud Staging",
      `Library/Application Support/Gyro Cloud Staging/${project}`,
    ].entries()) {
      const linkedHome = join(fixture, `linked-home-${index}`),
        outside = join(fixture, `outside-${index}`);
      mkdirSync(linkedHome, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      const linked = join(linkedHome, relative);
      mkdirSync(dirname(linked), { recursive: true, mode: 0o700 });
      symlinkSync(outside, linked);
      assert.equal(run(project, linkedHome).status, 2);
      assert.deepEqual(readdirSync(outside), []);
      checks++;
    }
    const sharedHome = join(fixture, "shared-home");
    mkdirSync(sharedHome, { mode: 0o700 });
    chmodSync(sharedHome, 0o777);
    assert.equal(run(project, sharedHome).status, 2);
    assert.ok(!existsSync(join(sharedHome, "Library")));
    checks++;
    chmodSync(expected, 0o755);
    assert.equal(run(project, home).status, 2);
    assert.equal(statSync(expected).mode & 0o777, 0o755);
    checks++;
    if (process.getuid() !== statSync("/").uid) {
      assert.equal(run(project, "/").status, 2);
      checks++;
    }
    console.log(
      `Staging launcher passed ${checks} compile/disposable-home checks (${process.arch}); no app, Keychain or existing profile was opened.`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
