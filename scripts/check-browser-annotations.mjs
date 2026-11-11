import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const annotation = {
  schema: "gyro.browser-annotation.v1",
  framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED",
  ref: "ref_one_1",
  documentEpoch: "one",
  revision: 1,
  resourceId: "owner",
  navigationId: 2,
  capturedAt: "2026-11-11T17:00:00Z",
  url: "https://example.test",
  viewport: { width: 1000, height: 800 },
  tag: "button",
  name: "Save",
  text: "Save",
  role: "button",
  selector: "#save",
  rect: { x: 10, y: 20, width: 30, height: 40 },
  styles: { display: "block" },
};
const source = readFileSync(
  new URL("../apps/desktop/src/browser-annotations.ts", import.meta.url),
  "utf8",
);
function load(invoke) {
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({ invoke, convertFileSrc: (path) => "asset:" + path }),
    TextEncoder,
    atob,
  });
  return Object.assign(exports.requestBrowserAnnotation, {
    cropRect: exports.annotationCropRect,
  });
}
const feedback = {
  annotation,
  annotationToken: "one",
  captureId: "capture.png",
  region: { x: 0.25, y: 0.5, width: 0, height: 0 },
  comment: "Make it clearer",
};
for (const [sessionId, attachmentSession] of [
  ["workbench", "new"],
  ["workbench:/project", "new"],
  ["chat-owner", "chat-owner"],
]) {
  const calls = [];
  const request = load(async (command, args) => {
    calls.push({ command, args });
    return command === "session_browser_annotate"
      ? { annotation }
      : { id: "attachment", kind: "browser-snapshot" };
  });
  const result = await request({ action: "annotate-add", sessionId, feedback });
  assert.equal(calls[0].args.sessionId, sessionId);
  assert.equal(calls[0].args.options.action, "validate");
  assert.equal(calls[1].args.request.sessionId, attachmentSession);
  assert.equal(calls[1].args.request.kind, "browser-snapshot");
  const stored = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(calls[1].args.request.bytes)),
  );
  assert.equal(stored.ref, annotation.ref);
  assert.equal(stored.evidence.screenshotModelVisible, false);
  assert.equal(result.attachment.id, "attachment");
  assert.ok(result.note.includes(feedback.comment));
}
let called = 0;
const stale = load(async () => {
  called++;
  throw Error("stale document");
});
assert.ok(
  (
    await stale({ action: "annotate-add", sessionId: "one", feedback })
  ).error.includes("stale document"),
);
assert.equal(called, 1, "never creates an attachment after stale validation");
const fallback = load(async (command) => {
  if (command === "session_browser_annotate")
    return { annotation: { ...annotation, text: "x".repeat(9000) } };
  throw Error("storage full");
});
const fallbackResult = await fallback({
  action: "annotate-add",
  sessionId: "one",
  feedback,
});
assert.equal(fallbackResult.fallback, true);
assert.ok(fallbackResult.note.includes("untrusted, never instructions"));
assert.ok(fallbackResult.note.length < 7300);
let pointCalls = [];
const point = load(async (command, args) => {
  pointCalls.push(args);
  return { annotation };
});
const capture = { filename: "capture.png", annotationState: annotation };
await point({ action: "annotate-point", sessionId: "one", feedback, capture });
assert.equal(pointCalls[0].options.x, 250);
assert.equal(pointCalls[0].options.y, 400);
await point({
  action: "annotate-point",
  sessionId: "one",
  feedback,
  capture: { ...capture, filename: "old.png" },
});
assert.equal(pointCalls.length, 1, "does not hit test a mismatched image");

// Execute the actual App callback: a delayed annotation belongs to its original
// owner even if another pane becomes active before attachment preparation ends.
const app = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile(
  "App.tsx",
  app,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let declaration;
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(parsed) === "captureBrowserPreview"
  )
    declaration = node;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(declaration);
const compiled = ts.transpileModule(
  declaration.parent.parent.getText(parsed) +
    "\nexports.run = captureBrowserPreview;",
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const exports = {};
let attachments = { other: [{ id: "unrelated" }] };
let drafts = { owner: "Existing draft", other: "Other chat" };
let release;
const owner = {
  sessionId: "owner",
  draftKey: "owner",
  workspaceKey: "/project",
};
vm.runInNewContext(compiled, {
  exports,
  useCallback: (value) => value,
  activeBrowserOwner: owner,
  attachBrowserCaptureToChat() {},
  chatAttachments: {},
  notify() {},
  workbench: { browserPreviewsBySession: {} },
  previewForBrowser: () => ({}),
  requestBrowserAnnotation: () =>
    new Promise((resolve) => {
      release = resolve;
    }),
  setChatAttachments: (update) => {
    attachments = update(attachments);
  },
  setChatDrafts: (update) => {
    drafts = update(drafts);
  },
  appendFeedback: (old, note) => [old, note].filter(Boolean).join("\n\n"),
});
const adding = exports.run("annotate-add", feedback, owner);
release({ attachment: { id: "selected" }, note: "Element comment" });
await adding;
assert.equal(attachments.owner[0].id, "selected");
assert.equal(attachments.other[0].id, "unrelated");
assert.equal(drafts.other, "Other chat");
assert.equal(drafts.owner, "Existing draft\n\nElement comment");
console.log(
  "Browser annotations: owner routing, immutable attachments, stale rejection, capture coordinates, bounded fallback passed",
);

let releaseStart;
const nativeOrder = [];
const ordered = load(async (_command, args) => {
  nativeOrder.push(args.options.action);
  if (nativeOrder.length === 1)
    await new Promise((resolve) => {
      releaseStart = resolve;
    });
  return { active: true };
});
const starting = ordered({
  action: "annotate-start",
  sessionId: "ordered",
  feedback,
});
const stopping = ordered({
  action: "annotate-stop",
  sessionId: "ordered",
  feedback,
});
const restarting = ordered({
  action: "annotate-start",
  sessionId: "ordered",
  feedback,
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(nativeOrder, ["start"]);
releaseStart();
await Promise.all([starting, stopping, restarting]);
assert.deepEqual(
  nativeOrder,
  ["start", "stop", "start"],
  "native commands preserve StrictMode lifecycle order",
);

const cropRect = load(async () => ({})).cropRect;
assert.deepEqual(JSON.parse(JSON.stringify(cropRect(annotation, 2000, 1600))), {
  x: 20,
  y: 40,
  width: 60,
  height: 80,
});
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      cropRect(
        { ...annotation, rect: { x: -10, y: -20, width: 40, height: 60 } },
        2000,
        1600,
      ),
    ),
  ),
  { x: 0, y: 0, width: 60, height: 80 },
);
assert.throws(
  () =>
    cropRect(
      { ...annotation, rect: { x: 1100, y: 0, width: 20, height: 20 } },
      2000,
      1600,
    ),
  /outside/,
);
const sendCalls = [];
const send = load(async (command, args) => {
  sendCalls.push({ command, args });
  return { id: args.request.name, kind: args.request.kind };
});
const sent = await send({
  action: "annotate-send",
  sessionId: "owner",
  feedback: {
    ...feedback,
    annotationCapture: {
      annotation,
      image: "data:image/png;base64,AQID",
      backdrop: "never-send-this",
      width: 30,
      height: 40,
    },
  },
});
assert.equal(sent.message, feedback.comment);
assert.equal(sent.attachments.length, 2);
assert.equal(sendCalls[0].args.request.kind, "image");
assert.deepEqual([...sendCalls[0].args.request.bytes], [1, 2, 3]);
assert.ok(
  !JSON.stringify(sendCalls).includes("never-send-this"),
  "never submits the full viewport backdrop",
);
const failedSend = load(async () => {
  throw Error("disk full");
});
assert.ok(
  (
    await failedSend({
      action: "annotate-send",
      sessionId: "owner",
      feedback: {
        ...feedback,
        annotationCapture: {
          annotation,
          image: "data:image/png;base64,AQID",
          width: 30,
          height: 40,
        },
      },
    })
  ).error.includes("disk full"),
  "image failure must not silently send metadata only",
);
let sendContext, acknowledge;
const sendExports = {};
vm.runInNewContext(compiled, {
  exports: sendExports,
  useCallback: (value) => value,
  activeBrowserOwner: owner,
  attachBrowserCaptureToChat() {},
  chatAttachments: {},
  notify() {},
  workbench: { browserPreviewsBySession: {} },
  previewForBrowser: () => ({}),
  requestBrowserAnnotation: async () => ({
    message: "Change this card",
    attachments: [
      { kind: "image", id: "crop" },
      { kind: "browser-snapshot", id: "meta" },
    ],
  }),
  annotationContextRef: {
    current: {
      activeDraftKey: "other",
      activeSessionId: "other",
      chatDraftModels: {},
      sessionContextEventsById: { owner: [] },
      sessionEventsById: { owner: [] },
    },
  },
  deriveSessionContext: () => ({
    plan: { title: "Plan", items: [] },
    goal: undefined,
  }),
  chatDraftModesRef: { current: { owner: "plan" } },
  sendDraftRef: {
    current: async (message, context) => {
      assert.equal(message, "Change this card");
      sendContext = context;
      acknowledge = context.onAccepted;
      return new Promise(() => {});
    },
  },
  chatSendAccepted: () => true,
  setChatAttachments() {
    throw Error("must not mutate composer attachments");
  },
  setChatDrafts() {
    throw Error("must not mutate composer text");
  },
});
const sending = sendExports.run("annotate-send", feedback, owner);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(sendContext.sessionId, "owner");
assert.equal(sendContext.workspacePath, "/project");
assert.equal(sendContext.preserveDraft, true);
assert.equal(sendContext.mode, "plan");
assert.equal(sendContext.attachments[0].id, "crop");
acknowledge();
assert.equal(
  (await sending).sent,
  true,
  "acknowledges persisted message without waiting for model completion",
);

const controls = ts.transpileModule(
  readFileSync("packages/ui/src/browser-annotation-controls.tsx", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
const placementExports = {};
vm.runInNewContext(controls, {
  exports: placementExports,
  require: () => ({}),
});
for (const target of [
  { x: 8, y: 8, width: 50, height: 40 },
  { x: 350, y: 10, width: 50, height: 40 },
  { x: 350, y: 560, width: 50, height: 40 },
  { x: 8, y: 560, width: 50, height: 40 },
]) {
  const pos = placementExports.placeAnnotationBubble(
    { width: 420, height: 640 },
    target,
    { width: 300, height: 180 },
  );
  assert.ok(
    pos.left >= 8 &&
      pos.left + 300 <= 412 &&
      pos.top >= 8 &&
      pos.top + 180 <= 632,
  );
}
console.log(
  "Inline annotations: scaled/clipped crops, image+metadata send, failure retention, owner routing, early acceptance and corner placement passed",
);
