// Tauri runs `async fn` commands on the shared async runtime; synchronous
// command wrappers call their functions inline. Disk and database work can
// therefore block either the command handler or an async runtime worker.
// `resolve_provider_approval` did exactly that: approving a large
// reviewed file set stalled session lists, event reads and terminal reads until
// the writes landed. Blocking work belongs on `spawn_blocking`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const commandRoot = "apps/desktop/src-tauri/src/";
const sources = (await readdir(new URL(commandRoot, root), { recursive: true }))
  .filter((path) => path.endsWith(".rs"))
  .map((path) => commandRoot + path);

// Calls that reach the disk or the database and so must not run inline.
const BLOCKING = [
  /\bSessionStore::open\b/,
  /\bopen_store\(\)/,
  /\bopen_automation_store\(\)/,
  /\bAutomationStore::open\b/,
  /\bGyroConfig::(load|update|save)\b/,
  /\b(?:std::process::)?Command::new\b/,
  /\bfs::(read|write|copy|rename|remove_file|remove_dir_all|create_dir_all)\b/,
  /\bresolve_pane_governance\(/,
  /\bresolve_login_data_home\(/,
  /\bcreate_terminal_pane_blocking\(/,
  /\blist_active_capability_resources_blocking\(/,
  /\btiming::record_(?:frontend|surface)\(/,
];

// Warm-up runs before any window exists, so nothing is waiting behind it.
const ALLOWED_INLINE = new Set(["warm_desktop_shell"]);

function commandBodies(source, path = "fixture") {
  const lines = source.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "#[tauri::command]") continue;
    let start = -1;
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+/.test(lines[j])) {
        start = j;
        break;
      }
    }
    assert.ok(start >= 0, `unparsed Tauri command in ${path}:${i + 1}`);
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

// Scope-limited visibility must not hide commands from this guard. A parser
// failure is a failed check rather than an invitation to skip a command.
const scopedFixture = commandBodies(`
#[tauri::command]
pub(crate) async fn inspect() { open_store(); }
#[tauri::command]
pub(super) fn update() {}
`);
assert.deepEqual(
  scopedFixture.map(({ name, isAsync }) => ({ name, isAsync })),
  [
    { name: "inspect", isAsync: true },
    { name: "update", isAsync: false },
  ],
);
assert.match(scopedFixture[0].body, /open_store/);
assert.throws(
  () => commandBodies("#[tauri::command]\nunknown declaration"),
  /unparsed Tauri command/,
);

let checked = 0;
const offenders = [];
for (const path of sources) {
  const source = await readFile(new URL(path, root), "utf8");
  for (const command of commandBodies(source, path)) {
    checked += 1;
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

assert.ok(
  checked > 100,
  `expected to scan the command surface, saw ${checked}`,
);
assert.deepEqual(
  offenders,
  [],
  `Tauri commands must move disk and database work onto tauri::async_runtime::spawn_blocking:\n  ${offenders.join("\n  ")}`,
);

console.log(`command blocking checks passed (${checked} commands)`);
