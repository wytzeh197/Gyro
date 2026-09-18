// Tauri runs `async fn` commands on the shared async runtime and non-async ones
// on a blocking pool. A command that opens the session store, runs a migration
// or fsyncs a mutation journal directly inside an `async fn` therefore parks a
// runtime worker for the whole disk round trip, and every other IPC call queues
// behind it. `resolve_provider_approval` did exactly that: approving a large
// reviewed file set stalled session lists, event reads and terminal reads until
// the writes landed. Blocking work belongs on `spawn_blocking`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const sources = [
  "apps/desktop/src-tauri/src/lib.rs",
  "apps/desktop/src-tauri/src/session_browser.rs",
  "apps/desktop/src-tauri/src/menu_bar.rs",
];

// Calls that reach the disk or the database and so must not run inline.
const BLOCKING = [
  /\bSessionStore::open\b/,
  /\bopen_store\(\)/,
  /\bopen_automation_store\(\)/,
  /\bAutomationStore::open\b/,
  /\bGyroConfig::(load|update|save)\b/,
  /\bstd::process::Command::new\b/,
  /\bfs::(read|write|copy|rename|remove_file|remove_dir_all|create_dir_all)\b/,
];

// Warm-up runs before any window exists, so nothing is waiting behind it.
const ALLOWED_INLINE = new Set(["warm_desktop_shell"]);

function commandBodies(source) {
  const lines = source.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "#[tauri::command]") continue;
    let start = -1;
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      if (/^\s*(pub )?(async )?fn /.test(lines[j])) {
        start = j;
        break;
      }
    }
    if (start < 0) continue;
    const signature = lines[start].trim();
    let depth = 0;
    let opened = false;
    let end = start;
    for (let k = start; k < lines.length; k++) {
      for (const character of lines[k]) {
        if (character === "{") {
          depth += 1;
          opened = true;
        } else if (character === "}") depth -= 1;
      }
      end = k;
      if (opened && depth <= 0) break;
    }
    found.push({
      line: start + 1,
      name: /fn (\w+)/.exec(signature)?.[1] ?? "?",
      isAsync: signature.includes("async fn"),
      body: lines.slice(start, end + 1).join("\n"),
    });
  }
  return found;
}

let checked = 0;
const offenders = [];
for (const path of sources) {
  const source = await readFile(new URL(path, root), "utf8");
  for (const command of commandBodies(source)) {
    checked += 1;
    if (!command.isAsync) continue;
    if (ALLOWED_INLINE.has(command.name)) continue;
    if (command.body.includes("spawn_blocking")) continue;
    const blocking = BLOCKING.filter((pattern) => pattern.test(command.body));
    if (blocking.length > 0) {
      offenders.push(
        `${path}:${command.line} ${command.name} calls ${blocking
          .map((pattern) => pattern.source)
          .join(", ")} inline`,
      );
    }
  }
}

assert.ok(checked > 100, `expected to scan the command surface, saw ${checked}`);
assert.deepEqual(
  offenders,
  [],
  `async Tauri commands must move disk and database work onto tauri::async_runtime::spawn_blocking:\n  ${offenders.join("\n  ")}`,
);

console.log(`command blocking checks passed (${checked} commands)`);
