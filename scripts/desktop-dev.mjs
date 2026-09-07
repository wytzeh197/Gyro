#!/usr/bin/env node

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function availableDevPort(preferred = 1420) {
  for (let port = preferred; port < preferred + 100; port++) {
    const available = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(
    "No available desktop development port. Stop an unused dev server and retry.",
  );
}

export function desktopDevArgs(port, extra = []) {
  return [
    "--filter",
    "@gyro-dev/desktop",
    "tauri",
    "dev",
    "--config",
    JSON.stringify({
      build: {
        devUrl: `http://127.0.0.1:${port}`,
        beforeDevCommand: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
      },
    }),
    ...extra,
  ];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = await availableDevPort();
  console.log(`Gyro desktop development: http://127.0.0.1:${port}`);
  if (port !== 1420)
    console.log("Port 1420 is occupied; using an available port.");
  const child = spawn("pnpm", desktopDevArgs(port, process.argv.slice(2)), {
    stdio: "inherit",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}
