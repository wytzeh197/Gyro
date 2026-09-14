import assert from "node:assert/strict";

import {
  decideKeepAlive,
  isKeepAliveCommand,
  keepAliveBackoffMs,
  keepAliveKind,
  keepAliveStatusLabel,
  keepAliveTitle,
  keepAliveWatchesFromPanes,
  KEEP_ALIVE_MAX_RESTARTS,
} from "../packages/ui/src/chat-keep-alive.ts";

assert.equal(isKeepAliveCommand("pnpm --filter @gyro-dev/desktop dev"), true);
assert.equal(isKeepAliveCommand("npm run dev"), true);
assert.equal(isKeepAliveCommand("cargo watch -x run"), true);
assert.equal(isKeepAliveCommand("pnpm test --watch"), true);
assert.equal(isKeepAliveCommand("python app.py"), false);
assert.equal(isKeepAliveCommand("go run ."), false);
assert.equal(isKeepAliveCommand("gh run watch 123 --exit-status"), false);
assert.equal(isKeepAliveCommand("pnpm test"), false);
assert.equal(isKeepAliveCommand("cargo build"), false);
assert.equal(isKeepAliveCommand("pnpm lint"), false);

assert.equal(keepAliveKind("pnpm dev"), "dev-server");
assert.equal(keepAliveKind("cargo watch -x test"), "watcher");
assert.equal(keepAliveKind("python app.py"), "service");
assert.equal(keepAliveTitle({ command: "pnpm dev" }), "Dev server");
assert.equal(keepAliveTitle({ command: "python app.py", title: "API" }), "API");
assert.equal(
  keepAliveTitle({ command: "pnpm dev", taskTitle: "Desktop" }),
  "Desktop",
);

assert.equal(keepAliveBackoffMs(1), 0);
assert.equal(keepAliveBackoffMs(2), 1500);
assert.equal(keepAliveBackoffMs(3), 4000);

const watching = decideKeepAlive({
  command: "pnpm dev",
  paneStatus: "running",
  ownerTurnId: "turn-1",
});
assert.equal(watching.type, "set");
assert.equal(watching.type === "set" && watching.keepAlive.phase, "watching");
assert.equal(watching.type === "set" && watching.keepAlive.turnId, "turn-1");

assert.deepEqual(
  decideKeepAlive({
    command: "pnpm dev",
    paneStatus: "running",
    ownerTurnId: "turn-1",
    keepAlive: {
      turnId: "turn-1",
      restartCount: 0,
      phase: "watching",
    },
  }),
  { type: "noop" },
  "an already-armed running process should not retrigger",
);

const crashed = decideKeepAlive({
  command: "pnpm dev",
  paneStatus: "failed",
  ownerTurnId: "turn-1",
  exitCode: 1,
  keepAlive: { turnId: "turn-1", restartCount: 0, phase: "watching" },
});
assert.equal(crashed.type, "relaunch");
assert.equal(
  crashed.type === "relaunch" && crashed.keepAlive.phase,
  "relaunching",
);
assert.equal(crashed.type === "relaunch" && crashed.keepAlive.restartCount, 1);

const userStop = decideKeepAlive({
  command: "pnpm dev",
  paneStatus: "failed",
  ownerTurnId: "turn-1",
  stopKind: "explicit",
  keepAlive: { turnId: "turn-1", restartCount: 0, phase: "watching" },
});
assert.equal(userStop.type, "set");
assert.equal(userStop.type === "set" && userStop.keepAlive.phase, "stopped");

const ctrlC = decideKeepAlive({
  command: "pnpm dev",
  paneStatus: "failed",
  ownerTurnId: "turn-1",
  exitCode: 130,
  keepAlive: { turnId: "turn-1", restartCount: 0, phase: "watching" },
});
assert.equal(ctrlC.type, "set");
assert.equal(ctrlC.type === "set" && ctrlC.keepAlive.phase, "stopped");

const modelStop = decideKeepAlive({
  command: "python -m http.server",
  paneStatus: "failed",
  ownerTurnId: "turn-1",
  keepAlive: {
    turnId: "turn-1",
    restartCount: 0,
    phase: "watching",
    stopOrigin: "model",
  },
});
assert.equal(modelStop.type === "set" && modelStop.keepAlive.phase, "stopped");

const exhausted = decideKeepAlive({
  command: "pnpm dev",
  paneStatus: "failed",
  ownerTurnId: "turn-1",
  exitCode: 1,
  keepAlive: {
    turnId: "turn-1",
    restartCount: KEEP_ALIVE_MAX_RESTARTS,
    phase: "watching",
  },
});
assert.equal(exhausted.type === "set" && exhausted.keepAlive.phase, "exited");

const finite = decideKeepAlive({
  command: "pnpm test",
  paneStatus: "running",
  ownerTurnId: "turn-1",
});
assert.equal(finite.type, "noop");

const recovered = decideKeepAlive({
  command: "pnpm dev",
  paneStatus: "running",
  ownerTurnId: "turn-1",
  now: "2026-09-14T12:00:00.000Z",
  keepAlive: { turnId: "turn-1", restartCount: 1, phase: "relaunching" },
});
assert.equal(recovered.type === "set" && recovered.keepAlive.phase, "watching");
assert.equal(
  recovered.type === "set" && recovered.keepAlive.lastRelaunchedAt,
  "2026-09-14T12:00:00.000Z",
);

const watches = keepAliveWatchesFromPanes([
  {
    id: "model:ses_1",
    title: "Desktop",
    command: "pnpm --filter @gyro-dev/desktop dev",
    owner: {
      kind: "model",
      sessionId: "ses_1",
      turnId: "turn-1",
      callId: "c1",
    },
    keepAlive: { turnId: "turn-1", restartCount: 0, phase: "watching" },
  },
  {
    id: "user-shell",
    title: "Shell",
    command: "zsh",
  },
]);
assert.equal(watches.length, 1);
assert.equal(watches[0]?.title, "Dev server");
assert.equal(keepAliveStatusLabel(watches[0]), "Watching");
assert.equal(
  keepAliveStatusLabel({ phase: "watching", restartCount: 1 }),
  "Relaunched · watching",
);

console.log("chat keep-alive checks passed");

// Real failures: package names and test paths must never turn checks into servers.
const finiteCommands = [
  "/bin/zsh -lc CI=1 pnpm --filter @gyro-dev/ui typecheck && node scripts/check-workbench-ui.mjs && node --experimental-strip-types scripts/check-composer-context-usage.mjs",
  "/bin/zsh -lc set -e; export CI=1; pnpm doctor; pnpm check; pnpm test; pnpm smoke:workbench; pnpm site:check; pnpm --filter @gyro-dev/desktop build; cargo fmt --all -- --check; cargo test --workspace; cargo run -p gyro-cli -- --version; pnpm release:cli:check",
  "pnpm --filter @gyro-dev/desktop build",
  "pnpm exec vite build",
  "node scripts/dev-server-check.mjs",
  "rg 'pnpm dev; npm start' packages/ui/src",
  "echo 'vite --watch'",
  "gh run watch 123 --exit-status",
  "git status",
  "python app.py",
  "go run .",
  "npm install",
  "pnpm dev --help",
  "pnpm exec vite --version",
  "pnpm build && pnpm dev",
  "pnpm dev | tee log",
  "unknown-service",
  "pnpm 'dev",
  "",
];
for (const command of finiteCommands) {
  assert.equal(isKeepAliveCommand(command), false, command);
  assert.deepEqual(
    decideKeepAlive({
      command,
      paneStatus: "done",
      ownerTurnId: "old",
      exitCode: 0,
      keepAlive: { turnId: "old", restartCount: 1, phase: "watching" },
    }),
    { type: "noop" },
    `must not restart stale false match: ${command}`,
  );
  assert.deepEqual(
    keepAliveWatchesFromPanes([
      {
        id: "stale",
        title: "Dev server",
        command,
        owner: { kind: "model", sessionId: "s", turnId: "old", callId: "c" },
        keepAlive: { turnId: "old", restartCount: 3, phase: "exited" },
      },
    ]),
    [],
    `must hide stale false match: ${command}`,
  );
}
for (const [command, kind] of [
  ["pnpm --filter @gyro-dev/desktop dev", "dev-server"],
  ["pnpm --filter=@gyro-dev/desktop run dev", "dev-server"],
  ['/bin/zsh -lc "cd /tmp; pnpm dev"', "dev-server"],
  ["/bin/zsh -lc set -e; export CI=1; pnpm dev", "dev-server"],
  ["env PORT=3000 npm run start", "dev-server"],
  ["pnpm exec vite --host 127.0.0.1", "dev-server"],
  ["python3 -m http.server 8000", "dev-server"],
  ["uvicorn app:app --reload", "dev-server"],
  ["cargo watch -x test", "watcher"],
  ["pnpm --filter @gyro-dev/ui test --watch", "watcher"],
  ["npx tsc --watch", "watcher"],
  ["npm run test:watch", "watcher"],
]) {
  assert.equal(isKeepAliveCommand(command), true, command);
  assert.equal(keepAliveKind(command), kind, command);
}
console.log(
  "conservative process classification and stale-card regressions passed",
);
