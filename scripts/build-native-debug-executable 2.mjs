// Resolve the executable from this Cargo invocation, including target overrides.
// Packaging callers never guess a target/debug path or run the built binary.
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

export function buildNativeDebugExecutable({
  root,
  bin,
  features = [],
  env = process.env,
  timeout = 600000,
}) {
  return new Promise((resolveExecutable, reject) => {
    const args = [
      "build",
      "--offline",
      "-p",
      "gyro-desktop",
      "--bin",
      bin,
      "--profile",
      "dev",
      "--message-format=json-render-diagnostics",
    ];
    if (features.length) args.push("--features", features.join(","));
    const child = spawn("cargo", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...env, CARGO_PROFILE_DEV_DEBUG_ASSERTIONS: "true" },
    });
    const executables = new Set();
    let pending = "";
    let buildFinished = false;
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        Error(`Cargo build for ${bin} exceeded its acceptance timeout.`),
        true,
      );
    }, timeout);

    function fail(error, stop = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stop) child.kill("SIGTERM");
      reject(error);
    }

    function receive(line) {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw Error(`Cargo emitted invalid JSON while building ${bin}.`);
      }
      if (message.reason === "build-finished") {
        if (message.success !== true)
          throw Error(`Cargo reported an unsuccessful build for ${bin}.`);
        buildFinished = true;
      }
      if (
        message.reason === "compiler-artifact" &&
        message.target?.name === bin &&
        message.target?.kind?.includes("bin") &&
        typeof message.executable === "string"
      ) {
        if (message.profile?.debug_assertions !== true)
          throw Error(
            `Native acceptance binary ${bin} must enable debug assertions.`,
          );
        executables.add(resolve(root, message.executable));
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.once("error", (error) => fail(error, true));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      pending += chunk;
      try {
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          receive(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      } catch (error) {
        fail(error, true);
      }
    });
    child.once("error", (error) => fail(error));
    // close drains stdout before validating the emitted path, unlike exit.
    child.once("close", async (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      try {
        receive(pending);
        if (code !== 0 || signal)
          throw Error(`Cargo build for ${bin} failed (${signal ?? code}).`);
        if (!buildFinished || executables.size !== 1)
          throw Error(
            `Cargo did not report exactly one successful executable for ${bin}.`,
          );
        const [executable] = executables;
        if (!(await stat(executable)).isFile())
          throw Error(`Cargo executable for ${bin} is not a regular file.`);
        await access(executable, constants.X_OK);
        settled = true;
        resolveExecutable(executable);
      } catch (error) {
        fail(error);
      }
    });
  });
}
