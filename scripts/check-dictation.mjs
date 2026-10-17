import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  browserDictation,
  createBrowserDictation,
  dictationAccessError,
  dictationDraft,
  setDictationAccessRequest,
  setSharedDictation,
} from "../packages/ui/src/dictation.ts";

assert.deepEqual(dictationDraft("", 0, "Hello"), {
  draft: "Hello",
  caret: 5,
});

assert.deepEqual(dictationDraft("Please", 6, "Add a microphone"), {
  draft: "Please Add a microphone",
  caret: 23,
});

assert.deepEqual(dictationDraft("Please ", 7, "Add"), {
  draft: "Please Add",
  caret: 10,
});

assert.deepEqual(dictationDraft("Say .", 4, "hello"), {
  draft: "Say hello.",
  caret: 9,
});

const base = "Please";
const first = dictationDraft(base, base.length, "Add");
const second = dictationDraft(base, base.length, "Add a microphone next to send");
assert.equal(first.draft, "Please Add");
assert.equal(second.draft, "Please Add a microphone next to send");
assert.equal(second.draft.includes("Please Add Add"), false);

assert.deepEqual(dictationDraft("Please", 6, "   "), {
  draft: "Please",
  caret: 6,
});

assert.deepEqual(dictationDraft("Hello", 99, "there"), {
  draft: "Hello there",
  caret: 11,
});

assert.deepEqual(dictationDraft("Hello", -4, "there"), {
  draft: "thereHello",
  caret: 5,
});

const limited = dictationDraft("Hello", 5, "there friend", 8);
assert.equal(limited.draft, "Hello th");
assert.equal(limited.draft.length, 8);
assert.equal(limited.caret, 8);

assert.deepEqual(dictationDraft("Hello!!", 7, "more", 7), {
  draft: "Hello!!",
  caret: 7,
});

console.log("dictation draft insertion passed");

function listen() {
  const events = [];
  return {
    events,
    signal: new AbortController().signal,
    onPartial: (text) => events.push(["partial", text]),
    onFinal: (text) => events.push(["final", text]),
    onError: (message) => events.push(["error", message]),
  };
}

class FakeRecognition {
  static constructed = 0;
  constructor() {
    FakeRecognition.constructed += 1;
    this.continuous = false;
    this.interimResults = false;
    this.lang = "";
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.started = false;
    this.aborted = false;
    FakeRecognition.latest = this;
  }
  start() {
    this.started = true;
  }
  abort() {
    this.aborted = true;
  }
  emit(text, isFinal) {
    this.onresult?.({
      results: [{ isFinal, 0: { transcript: text }, length: 1 }],
    });
  }
}

const missing = listen();
createBrowserDictation(null).start(missing);
assert.deepEqual(missing.events, [
  ["error", "Dictation is not available in this window."],
]);
createBrowserDictation(null).stop();
assert.equal(missing.events.length, 1);

const live = listen();
const controller = createBrowserDictation(FakeRecognition);
controller.start(live);
const recognition = FakeRecognition.latest;
assert.equal(recognition.started, true);
assert.equal(recognition.continuous, false);
assert.equal(recognition.interimResults, true);
assert.equal(recognition.lang, "en-US");
recognition.emit("Add", false);
assert.deepEqual(live.events, [["partial", "Add"]]);
recognition.emit("Add a microphone", true);
assert.deepEqual(live.events, [
  ["partial", "Add"],
  ["final", "Add a microphone"],
]);
recognition.onend?.();
assert.equal(live.events.length, 2);

const quiet = listen();
createBrowserDictation(FakeRecognition).start(quiet);
const quietRecognition = FakeRecognition.latest;
quietRecognition.emit("Please add", false);
quietRecognition.onend?.();
assert.deepEqual(quiet.events, [
  ["partial", "Please add"],
  ["final", "Please add"],
]);

const denied = listen();
createBrowserDictation(FakeRecognition).start(denied);
const deniedRecognition = FakeRecognition.latest;
deniedRecognition.onerror?.({ error: "not-allowed" });
deniedRecognition.onend?.();
assert.deepEqual(denied.events, [
  ["error", "Allow the microphone to dictate."],
]);

const cancelled = listen();
const cancelling = createBrowserDictation(FakeRecognition);
cancelling.start(cancelled);
const cancelledRecognition = FakeRecognition.latest;
cancelledRecognition.emit("Add", false);
cancelling.stop();
assert.equal(cancelledRecognition.aborted, true);
cancelledRecognition.emit("Add a microphone", true);
cancelledRecognition.onerror?.({ error: "aborted" });
cancelledRecognition.onend?.();
assert.deepEqual(cancelled.events, [["partial", "Add"]]);

const replaced = listen();
const replacement = listen();
const shared = createBrowserDictation(FakeRecognition);
shared.start(replaced);
const firstRecognition = FakeRecognition.latest;
shared.start(replacement);
assert.equal(firstRecognition.aborted, true);
FakeRecognition.latest.emit("next", true);
firstRecognition.emit("old", true);
assert.deepEqual(replaced.events, []);
assert.deepEqual(replacement.events, [["final", "next"]]);

assert.equal(browserDictation(), browserDictation());

const surfaces = readFileSync(
  new URL("../packages/ui/src/surfaces.tsx", import.meta.url),
  "utf8",
);
const composerStart = surfaces.indexOf("function Composer({");
const composerEnd = surfaces.indexOf("function ComposerMediaPreview");
const composer = surfaces.slice(composerStart, composerEnd);
assert.ok(composerStart >= 0 && composerEnd > composerStart);
assert.match(composer, /dictation = browserDictation\(\)/);
assert.match(composer, /<Mic /);
assert.equal(composer.includes('aria-label="Dictate message"'), false);

assert.equal(
  dictationAccessError({ microphone: "unsupported", speech: "unsupported" }),
  null,
);
assert.equal(
  dictationAccessError({ microphone: "authorized", speech: "authorized" }),
  null,
);
assert.equal(
  dictationAccessError({ microphone: "authorized", speech: "unsupported" }),
  null,
);
assert.equal(
  dictationAccessError({ microphone: "denied", speech: "unsupported" }),
  "Allow the microphone to dictate.",
);
assert.equal(
  dictationAccessError(null),
  "Allow the microphone to dictate.",
);
assert.equal(
  dictationAccessError({ microphone: "authorized", speech: "denied" }),
  "Allow Speech Recognition to dictate.",
);
assert.equal(
  dictationAccessError({ microphone: "authorized", speech: "restricted" }),
  "Allow Speech Recognition to dictate.",
);

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

setDictationAccessRequest(async () => "Allow the microphone to dictate.");
const blocked = listen();
const blockedBefore = FakeRecognition.constructed;
createBrowserDictation(FakeRecognition).start(blocked);
assert.equal(blocked.events.length, 0);
await tick();
assert.equal(FakeRecognition.constructed, blockedBefore);
assert.deepEqual(blocked.events, [["error", "Allow the microphone to dictate."]]);

let asked = false;
setDictationAccessRequest(async () => {
  asked = true;
  return null;
});
const released = listen();
const releasing = createBrowserDictation(FakeRecognition);
const releasedBefore = FakeRecognition.constructed;
releasing.start(released);
releasing.stop();
await tick();
assert.equal(asked, false);
assert.equal(FakeRecognition.constructed, releasedBefore);
assert.deepEqual(released.events, []);

let finishAccess;
setDictationAccessRequest(
  () =>
    new Promise((resolve) => {
      finishAccess = () => resolve(null);
    }),
);
const pending = listen();
const pendingController = createBrowserDictation(FakeRecognition);
pendingController.start(pending);
await tick();
const pendingBefore = FakeRecognition.constructed;
pendingController.stop();
finishAccess();
await tick();
assert.equal(FakeRecognition.constructed, pendingBefore);
assert.deepEqual(pending.events, []);

setDictationAccessRequest(async () => null);
const allowed = listen();
createBrowserDictation(FakeRecognition).start(allowed);
await tick();
assert.equal(FakeRecognition.latest.started, true);

setDictationAccessRequest(async () => {
  throw new Error("permission bridge unavailable");
});
const failed = listen();
const failedBefore = FakeRecognition.constructed;
createBrowserDictation(FakeRecognition).start(failed);
await tick();
assert.equal(FakeRecognition.constructed, failedBefore);
assert.deepEqual(failed.events, [["error", "Allow the microphone to dictate."]]);

setDictationAccessRequest(async () => "Allow the microphone to dictate.");
const sharedListener = listen();
browserDictation().start(sharedListener);
await tick();
assert.deepEqual(sharedListener.events, [
  ["error", "Allow the microphone to dictate."],
]);

setDictationAccessRequest(null);
const plain = listen();
createBrowserDictation(FakeRecognition).start(plain);
assert.equal(FakeRecognition.latest.started, true);

const desktopHook = readFileSync(
  new URL("../apps/desktop/src/dictation-access.ts", import.meta.url),
  "utf8",
);
const accessCommand = readFileSync(
  new URL("../apps/desktop/src-tauri/src/dictation_access.rs", import.meta.url),
  "utf8",
);
const plist = readFileSync(
  new URL("../apps/desktop/src-tauri/Info.plist", import.meta.url),
  "utf8",
);
const desktopLib = readFileSync(
  new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const accessState = readFileSync(
  new URL("../apps/desktop/src/system-access-state.ts", import.meta.url),
  "utf8",
);
assert.match(desktopHook, /request_dictation_access/);
assert.match(desktopHook, /start_dictation/);
assert.match(desktopHook, /stop_dictation/);
assert.match(desktopHook, /dictation-update/);
assert.match(desktopHook, /setSharedDictation/);
assert.match(accessState, /import "\.\/dictation-access"/);
assert.match(accessCommand, /requestAccessForMediaType/);
assert.match(accessCommand, /requestAuthorization/);
assert.match(accessCommand, /AVMediaTypeAudio/);
assert.match(accessCommand, /appendAudioPCMBuffer/);
assert.match(desktopLib, /dictation_access::request_dictation_access/);
assert.match(desktopLib, /dictation_access::start_dictation/);
assert.match(desktopLib, /dictation_access::stop_dictation/);
assert.match(plist, /NSMicrophoneUsageDescription/);
assert.match(plist, /NSSpeechRecognitionUsageDescription/);
const uiIndex = readFileSync(
  new URL("../packages/ui/src/index.ts", import.meta.url),
  "utf8",
);
assert.match(uiIndex, /setSharedDictation/);

let nativeStarts = 0;
let nativeStops = 0;
setSharedDictation(() => ({
  start(listener) {
    nativeStarts += 1;
    listener.onPartial("from the desktop microphone");
  },
  stop() {
    nativeStops += 1;
  },
}));
const installed = browserDictation();
assert.equal(installed, browserDictation());
const native = listen();
installed.start(native);
assert.equal(nativeStarts, 1);
assert.deepEqual(native.events, [["partial", "from the desktop microphone"]]);
installed.stop();
assert.equal(nativeStops, 1);
setSharedDictation(null);
const restored = browserDictation();
assert.notEqual(restored, installed);
assert.equal(restored, browserDictation());
const restoredListener = listen();
restored.start(restoredListener);
assert.deepEqual(restoredListener.events, [
  ["error", "Dictation is not available in this window."],
]);

console.log("dictation microphone passed");
