import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isComposerCliUpdating } from "../apps/desktop/src/cli-update-scope.ts";

// Bound chats and draft selections override the global provider, including splits.
assert.equal(isComposerCliUpdating(["xai"], { providerId: "openai" }, "xai"), false);
assert.equal(isComposerCliUpdating(["xai"], { providerId: "xai" }, "openai"), true);
assert.equal(isComposerCliUpdating(["openai"], { providerId: "xai" }, "openai"), false);
assert.equal(isComposerCliUpdating(["openai"], { providerId: "openai" }, "xai"), true);
// Unbound new chats follow the current global selection.
assert.equal(isComposerCliUpdating(["xai"], undefined, "xai"), true);
assert.equal(isComposerCliUpdating(["xai"], undefined, "openai"), false);
assert.equal(isComposerCliUpdating(["xai"], { providerId: "" }, "xai"), true);
assert.equal(isComposerCliUpdating(["xai"], undefined, undefined), false);
// Multiple updates, and completion/failure release.
for (const providerId of ["openai", "xai"]) {
  assert.equal(isComposerCliUpdating(["openai", "xai"], { providerId }, undefined), true);
  assert.equal(isComposerCliUpdating([], { providerId }, providerId), false);
}
assert.equal(isComposerCliUpdating(["xai"], { providerId: "anthropic" }, "xai"), false);

const app = readFileSync(new URL("../apps/desktop/src/App.tsx", import.meta.url), "utf8");
assert.equal((app.match(/isCliUpdating=\{paneComposerCliUpdating\}/g) || []).length, 1);
assert.equal((app.match(/isCliUpdating=\{activeComposerCliUpdating\}/g) || []).length, 3);
assert(!app.includes('isCliUpdating={cliUpdatePhase === "updating"}'));
assert(app.includes("finally {\n      cliUpdatingProvidersRef.current = [];\n      setCliUpdatingProviderIds([]);"));
assert(app.includes('setCliUpdatePhase(cliUpdatingProvidersRef.current.length > 0 ? "updating" : "idle")'));
console.log("PASS: provider-scoped updates for bound chats, drafts, defaults and all composer routes; completion/failure release and notice dismissal.");
