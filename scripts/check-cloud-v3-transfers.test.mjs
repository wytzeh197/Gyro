import test from "node:test";
import assert from "node:assert/strict";
import {
  completedSave,
  savePresentation,
  saveSize,
} from "../apps/desktop/src/cloud-v3-transfer-state.ts";
const item = {
  requestId: "fixture",
  kind: "chat",
  label: "Selected chat",
  prepared: { size: 42000 },
  uploadId: null,
  localRunning: false,
  cancelRequested: false,
};
test("local preparation never becomes a completed Cloud save", () => {
  assert.equal(savePresentation(item, false).action, "Upload chat");
  assert.equal(
    savePresentation({ ...item, uploadId: "remote" }, false).status,
    "Needs checking",
  );
  assert.equal(
    savePresentation(item, false, "verifying").status,
    "Checking save",
  );
  assert.equal(
    savePresentation(item, false, "unknown-status").status,
    "Needs checking",
  );
});
test("active and cancelled work cannot be resumed or restarted from the dialog", () => {
  for (const [p, running] of [
    [item, true],
    [{ ...item, localRunning: true }, false],
    [{ ...item, cancelRequested: true }, false],
  ]) {
    const view = savePresentation(p, running, "committed");
    assert.equal(view.disabled, true);
    assert.equal(view.restart, false);
  }
});
test("only verified responses can show committed or conflict status", () => {
  assert.equal(
    savePresentation(item, false, "committed").status,
    "Saved to Cloud",
  );
  assert.equal(
    savePresentation(item, false, "conflict").status,
    "Saved as a conflict version",
  );
  assert.equal(savePresentation(item, false, "committed").restart, false);
  assert.equal(savePresentation(item, false, "paused").action, "Try again");
});
test("snapshot size uses supplied decimal bytes, with unavailable for invalid data", () => {
  assert.equal(saveSize(42000), "42 KB");
  assert.equal(saveSize(548000000), "548 MB");
  assert.equal(saveSize(2e9), "2 GB");
  for (const value of [undefined, NaN, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(saveSize(value), "Size unavailable");
});

test("completed retained copies are excluded from pending without assuming unverified preparation is uploaded", () => {
  assert.equal(completedSave(item), false);
  assert.equal(completedSave({...item, uploadId:"remote"}), false);
  assert.equal(completedSave({...item, cloudStatus:"verifying"}), false);
  assert.equal(completedSave({...item, cloudStatus:"committed"}), true);
  assert.equal(completedSave({...item, cloudStatus:"committed"}, "paused"), true);
  assert.equal(savePresentation({...item,cloudStatus:"committed"},false,"paused").status,"Upload completed");
  assert.equal(completedSave({...item, cloudStatus:"conflict"}), true);
  assert.equal(completedSave({...item, localRunning:true, cloudStatus:"committed"}), false);
  assert.equal(savePresentation({...item,cloudStatus:"committed"},false).status,"Upload completed");
  assert.equal(savePresentation({...item,cloudStatus:"committed"},false).restart,false);
});
