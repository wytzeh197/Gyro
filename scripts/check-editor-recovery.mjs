import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createInitialWorkbenchState,
  editorBufferRecoveryCapacity,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

// Execute the production module with its workspace package imports bundled.
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const temporary = await mkdtemp(join(tmpdir(), "gyro-edit-recovery-tests-"));
const previousWindow = globalThis.window;
try {
  const output = join(temporary, "recovery.mjs");
  await build({
    entryPoints: [
      new URL("../apps/desktop/src/editor/edit-recovery.ts", import.meta.url)
        .pathname,
    ],
    outfile: output,
    bundle: true,
    loader: { ".png": "dataurl" },
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    EDIT_RECOVERY_KEY,
    writeEditRecovery,
    readEditRecovery,
    recoverWorkspaceBuffers,
    hasEditRecovery,
  } = await import(pathToFileURL(output));
  const values = new Map();
  let writes = 0;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes++;
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  globalThis.window = { localStorage: storage };
  const buffer = (path, content, savedContent) => ({
    path,
    content,
    savedContent,
    contentHash: `hash:${path}`,
    sizeBytes: new TextEncoder().encode(content).length,
    truncated: false,
    status: content === savedContent ? "ready" : "dirty",
    updatedAt: new Date(0).toISOString(),
  });
  const mainPath = "/workspace/main.ts";
  const backgroundPath = "/workspace/side.ts";
  const dirty = {
    [mainPath]: buffer(mainPath, "😀 renamed\r\n", "😀 old\r\n"),
    [backgroundPath]: buffer(backgroundPath, "renamed", "old"),
    "/workspace/clean.ts": buffer("/workspace/clean.ts", "same", "same"),
  };
  const original = structuredClone(dirty);
  assert.deepEqual(readEditRecovery(storage), {});
  assert.equal(hasEditRecovery(), false);
  const noJournalState = createInitialWorkbenchState();
  assert.equal(
    recoverWorkspaceBuffers(noJournalState),
    noJournalState,
    "An absent journal must leave ordinary restoration unchanged.",
  );
  writeEditRecovery(dirty, storage);
  assert.equal(hasEditRecovery(), true);
  assert.deepEqual(dirty, original, "Journaling must not mutate live buffers.");
  const recovered = readEditRecovery(storage);
  assert.deepEqual(
    Object.keys(recovered),
    [mainPath, backgroundPath],
    "Only unsaved drafts should survive; every dirty target must survive.",
  );
  assert.equal(recovered[mainPath].content, dirty[mainPath].content);
  assert.equal(recovered[mainPath].savedContent, dirty[mainPath].savedContent);
  assert.equal(recovered[mainPath].contentHash, dirty[mainPath].contentHash);
  assert.equal(recovered[backgroundPath].content, "renamed");

  const preTransaction = workbenchReducer(createInitialWorkbenchState(), {
    type: "ide-upsert-buffer",
    buffer: buffer(mainPath, "😀 old\r\n", "😀 old\r\n"),
  });
  const restarted = recoverWorkspaceBuffers(preTransaction);
  assert.equal(
    restarted.ide.buffers[mainPath].content,
    dirty[mainPath].content,
  );
  assert.equal(
    restarted.ide.buffers[backgroundPath].content,
    "renamed",
    "Restart must restore a changed file that never had an editor tab.",
  );
  assert.equal(
    restarted.ide.tabs.some((tab) => tab.path === backgroundPath),
    false,
  );
  assert.equal(restarted.ide.activePath, preTransaction.ide.activePath);
  assert.equal(
    restarted.ide.layout.activeGroupId,
    preTransaction.ide.layout.activeGroupId,
  );
  assert.equal(restarted.activeDestination, preTransaction.activeDestination);
  assert.equal(
    restarted.ide.tabs.find((tab) => tab.path === mainPath).dirty,
    true,
    "Recovery must update the existing tab's unsaved indicator.",
  );
  assert.equal(
    restarted.ide.layout.groups[0].tabs.find((tab) => tab.path === mainPath)
      .dirty,
    true,
    "Recovery must update the group tab's unsaved indicator.",
  );

  const priorJournal = storage.getItem(EDIT_RECOVERY_KEY);
  const quotaStorage = {
    ...storage,
    setItem: () => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    },
  };
  assert.throws(
    () =>
      writeEditRecovery(
        { [backgroundPath]: buffer(backgroundPath, "newer", "old") },
        quotaStorage,
      ),
    /quota/i,
  );
  assert.equal(
    storage.getItem(EDIT_RECOVERY_KEY),
    priorJournal,
    "A quota failure must preserve the previous recoverable drafts.",
  );
  assert.throws(
    () =>
      writeEditRecovery(dirty, {
        ...storage,
        setItem: () => {},
        getItem: () => null,
      }),
    /unavailable/i,
    "A storage API that fails to retain writes must abort application.",
  );
  assert.equal(storage.getItem(EDIT_RECOVERY_KEY), priorJournal);

  const tooMany = Object.fromEntries(
    Array.from({ length: 31 }, (_, index) => {
      const path = `/workspace/file-${index}.ts`;
      return [path, buffer(path, "new", "old")];
    }),
  );
  const writesBeforeCapacityFailure = writes;
  assert.equal(editorBufferRecoveryCapacity(tooMany).ok, false);
  assert.throws(() => writeEditRecovery(tooMany, storage), /30/);
  assert.equal(
    writes,
    writesBeforeCapacityFailure,
    "Capacity rejection must occur before writing any journal.",
  );
  assert.equal(storage.getItem(EDIT_RECOVERY_KEY), priorJournal);
  assert.throws(
    () =>
      writeEditRecovery(
        { [mainPath]: buffer(mainPath, "x".repeat(500_001), "") },
        storage,
      ),
    /too large/,
  );
  const totalTooLarge = Object.fromEntries(
    Array.from({ length: 3 }, (_, index) => {
      const path = `/workspace/large-${index}.ts`;
      return [path, buffer(path, "x".repeat(340_000), "")];
    }),
  );
  assert.throws(() => writeEditRecovery(totalTooLarge, storage), /limit/);
  assert.equal(storage.getItem(EDIT_RECOVERY_KEY), priorJournal);

  // JSON escaping inflates storage even when content counts fit; verify the exact round trip.
  const escaped = {
    [backgroundPath]: buffer(backgroundPath, "\u0001".repeat(20_000), "saved"),
  };
  writeEditRecovery(escaped, storage);
  assert.equal(
    readEditRecovery(storage)[backgroundPath].content,
    escaped[backgroundPath].content,
  );
  writeEditRecovery({}, storage);
  assert.deepEqual(
    readEditRecovery(storage),
    {},
    "Saving all targets clears their drafts from future recovery.",
  );
  assert.equal(
    recoverWorkspaceBuffers(createInitialWorkbenchState()).ide.buffers[
      backgroundPath
    ],
    undefined,
  );
  const staleUiState = workbenchReducer(preTransaction, {
    type: "ide-upsert-buffer",
    buffer: dirty[mainPath],
  });
  const afterSavedRestart = recoverWorkspaceBuffers(staleUiState);
  assert.equal(
    afterSavedRestart.ide.buffers[mainPath],
    undefined,
    "An empty authoritative journal must discard old UI drafts already saved before the crash.",
  );
  assert.equal(
    afterSavedRestart.ide.tabs.find((tab) => tab.path === mainPath).dirty,
    false,
  );
  assert.equal(
    afterSavedRestart.ide.layout.groups[0].tabs.find(
      (tab) => tab.path === mainPath,
    ).dirty,
    false,
  );

  // A journal update can fail while the regular UI snapshot still succeeds.
  // Restart should use that newer durable draft instead of an older journal.
  const newerDraft = {
    ...dirty[mainPath],
    content: "typed after the journal",
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  };
  const newerUiState = workbenchReducer(preTransaction, {
    type: "ide-upsert-buffer",
    buffer: newerDraft,
  });
  assert.throws(
    () => writeEditRecovery(newerUiState.ide.buffers, quotaStorage),
    /quota/i,
  );
  assert.equal(
    recoverWorkspaceBuffers(newerUiState).ide.buffers[mainPath]?.content,
    newerDraft.content,
    "An older empty journal must not discard a newer successfully persisted UI draft after a journal write failure.",
  );
  writeEditRecovery(dirty, storage);
  const newerThanNonemptyJournal = {
    ...newerDraft,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  };
  const persistedNewer = workbenchReducer(preTransaction, {
    type: "ide-upsert-buffer",
    buffer: newerThanNonemptyJournal,
  });
  assert.equal(
    recoverWorkspaceBuffers(persistedNewer).ide.buffers[mainPath]?.content,
    newerThanNonemptyJournal.content,
    "An older journal entry must not overwrite a newer successfully persisted UI draft.",
  );

  const missingPath = "/workspace/missing-from-legacy.ts";
  const legacyUiState = workbenchReducer(persistedNewer, {
    type: "ide-upsert-buffer",
    buffer: buffer(missingPath, "unsaved outside the old journal", "saved"),
  });
  storage.setItem(
    EDIT_RECOVERY_KEY,
    JSON.stringify({
      version: 1,
      buffers: {
        [mainPath]: dirty[mainPath],
        [backgroundPath]: dirty[backgroundPath],
      },
    }),
  );
  const legacyRecovered = recoverWorkspaceBuffers(legacyUiState);
  assert.equal(
    legacyRecovered.ide.buffers[mainPath].content,
    newerThanNonemptyJournal.content,
    "A timestamp-less journal must preserve a newer UI draft for the same file.",
  );
  assert.equal(
    legacyRecovered.ide.buffers[missingPath].content,
    "unsaved outside the old journal",
    "A timestamp-less journal cannot clear UI drafts absent from its incomplete history.",
  );
  assert.equal(legacyRecovered.ide.buffers[backgroundPath].content, "renamed");
  assert.equal(legacyRecovered.ide.activePath, legacyUiState.ide.activePath);
  storage.setItem(
    EDIT_RECOVERY_KEY,
    JSON.stringify({ version: 1, buffers: {} }),
  );
  assert.equal(
    recoverWorkspaceBuffers(legacyUiState).ide.buffers[mainPath].content,
    newerThanNonemptyJournal.content,
    "A timestamp-less empty journal cannot prove that a persisted draft was saved.",
  );

  for (const invalid of [
    "not JSON",
    "null",
    JSON.stringify({ version: 2, buffers: {} }),
    JSON.stringify({ version: 1, buffers: [] }),
    JSON.stringify({
      version: 1,
      buffers: { [mainPath]: { ...dirty[mainPath], path: "../outside.ts" } },
    }),
    JSON.stringify({
      version: 1,
      buffers: { [mainPath]: { ...dirty[mainPath], savedContent: undefined } },
    }),
    JSON.stringify({ version: 1, buffers: tooMany }),
    "x".repeat(7_000_001),
  ]) {
    storage.setItem(EDIT_RECOVERY_KEY, invalid);
    assert.throws(
      () => readEditRecovery(storage),
      "Corrupt, unsupported or incomplete recovery must never report a successful partial restoration.",
    );
    assert.equal(
      storage.getItem(EDIT_RECOVERY_KEY),
      invalid,
      "Failed recovery must leave its original journal available.",
    );
    assert.equal(
      recoverWorkspaceBuffers(preTransaction),
      preTransaction,
      "A corrupt journal must preserve the existing state without applying partial recovery.",
    );
  }
  assert.throws(
    () =>
      readEditRecovery({
        ...storage,
        getItem: () => {
          throw new Error("Storage access denied");
        },
      }),
    /denied/,
  );
  console.log(
    "Editor recovery checks passed: journal round trip, background restart, dirty indicators, quota/capacity rejection and corrupt-storage preservation.",
  );
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  await rm(temporary, { recursive: true, force: true });
}
