import { readRepoSource } from "./read-repo-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createChatFileActions } from "../apps/desktop/src/chat-file-actions.ts";
import * as picker from "../apps/desktop/src/chat-attachment-picker.ts";
import {
  deliverChatMediaDrop,
  isMediaDrag,
  workspaceDropFromTransfer,
} from "../packages/ui/src/chat-media-transfer.ts";

const calls = [];
let available = false;
let fail = false;
const actions = createChatFileActions({
  invoke: async (command, { request }) => {
    calls.push({ command, request });
    if (fail) throw new Error("temporary read failure");
    return available ? "data:image/png;base64,cHJldmlldw==" : null;
  },
  convertFileSrc: () =>
    assert.fail("image previews must not need asset conversion"),
  open: () => {},
});
const a = { sessionId: "chat-a", workspacePath: "/project-a" };
const b = { sessionId: "chat-b", workspacePath: "/project-b" };
assert.equal(await actions.preview("shots/image.png", "image", a), undefined);
available = true;
assert.match(
  await actions.preview("shots/image.png", "image", a),
  /^data:image\/png/,
);
await actions.preview("shots/image.png", "image", a);
assert.equal(
  calls.length,
  2,
  "successful reads are reused, missing files are retried",
);
await actions.preview("shots/image.png", "image", b);
assert.equal(
  calls.length,
  3,
  "different panes cannot share relative-path previews",
);
assert.deepEqual(calls.at(-1), {
  command: "read_cited_chat_image",
  request: { target: "shots/image.png", ...b },
});
fail = true;
await assert.rejects(actions.preview("retry.png", "image", a));
fail = false;
assert.ok(await actions.preview("retry.png", "image", a));
await actions.preview("draft.png", "image", { workspacePath: "/project-b" });
assert.equal(calls.at(-1).request.sessionId, "new");
available = false;
assert.equal(
  await actions.resolveCitedImage({ target: "later.png", scope: b }),
  undefined,
);
available = true;
assert.ok(await actions.resolveCitedImage({ target: "later.png", scope: b }));

// Execute the actual App callback with a delayed native picker. Focus is still
// on A when B requests the picker; the explicit pane owns its eventual result.
const source = readRepoSource(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const callback = source.slice(
  source.indexOf("  const selectChatAttachment = useCallback("),
  source.indexOf('\n  /* Explorer "Ask Gyro"'),
);
let finishPicker;
let attachments = {};
const stored = [];
const ref = { current: attachments };
const dependencies = {
  ...picker,
  useCallback: (fn) => fn,
  activeDraftKey: "chat-a",
  activeSessionId: "chat-a",
  workspacePath: "/project-a",
  chatAttachments: attachments,
  chatAttachmentsRef: ref,
  isTauriRuntime: () => true,
  open: () =>
    new Promise((resolve) => {
      finishPicker = resolve;
    }),
  notify: (...message) => assert.fail(message.join(" ")),
  MAX_CHAT_IMAGES_PER_MESSAGE: 8,
  MAX_CHAT_VIDEOS_PER_MESSAGE: 2,
  NEW_CHAT_DRAFT_KEY: "new",
  workspaceName: (path) => path.split("/").at(-1),
  convertFileSrc: (path) => "asset:" + path,
  invoke: async (_command, { request }) => {
    stored.push(request);
    return { id: request.path, path: request.path, kind: request.kind };
  },
  setChatAttachments: (update) => {
    attachments = update(attachments);
    ref.current = attachments;
  },
};
const compiled = ts.transpileModule(callback, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const select = new Function(
  ...Object.keys(dependencies),
  compiled + "\nreturn selectChatAttachment;",
)(...Object.values(dependencies));
const selection = select("image", undefined, { draftKey: "chat-b", ...b });
finishPicker(["/Desktop/picture.png"]);
await selection;
assert.equal(stored[0].sessionId, "chat-b");
assert.equal(stored[0].workspacePath, "/project-b");
assert.equal(attachments["chat-a"], undefined);
assert.equal(attachments["chat-b"].length, 1);
await select("media", "/Desktop/draft.png", {
  draftKey: "draft-b",
  workspacePath: "/project-b",
});
assert.equal(
  stored.at(-1).sessionId,
  "new",
  "a draft pane must not inherit A's session",
);
assert.equal(attachments["draft-b"].length, 1);

const delivered = [];
const paths = [];
const transfer = {
  types: ["public.file-url"],
  files: [],
  items: [],
  getData: (type) =>
    type === "public.file-url"
      ? "file:///Users/test/Desktop/image%20one.png"
      : "",
};
assert.equal(isMediaDrag(transfer), true);
assert.equal(
  workspaceDropFromTransfer(transfer),
  undefined,
  "folder drops must not swallow image URLs",
);
assert.deepEqual(
  workspaceDropFromTransfer({
    ...transfer,
    getData: (type) =>
      type === "public.file-url" ? "file:///Users/test/project" : "",
  }),
  { paths: ["/Users/test/project"] },
);
assert.deepEqual(
  workspaceDropFromTransfer({
    ...transfer,
    items: [
      {
        kind: "file",
        getAsFile: () => null,
        webkitGetAsEntry: () => ({ isDirectory: true }),
      },
    ],
  }),
  { paths: ["/Users/test/Desktop/image one.png"] },
  "a real folder with an image-like name is still a folder",
);
deliverChatMediaDrop(
  transfer,
  (files) => delivered.push(...files),
  assert.fail,
  (items) => paths.push(...items),
);
assert.deepEqual(paths, ["/Users/test/Desktop/image one.png"]);
const file = new File(["png"], "image.png", { type: "image/png" });
deliverChatMediaDrop(
  { ...transfer, files: [file] },
  (files) => delivered.push(...files),
  assert.fail,
  () => assert.fail("files and URLs must not be delivered twice"),
);
assert.deepEqual(delivered, [file]);
const csp = JSON.parse(
  readFileSync(
    new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
  ),
).app.security.csp;
assert.match(csp, /img-src[^;]*blob:/);
assert.match(csp, /media-src[^;]*blob:/);
console.log(
  "PASS: pane-owned picker/draft uploads, scoped preview reads, transient preview recovery, Finder file URLs, single delivery, and blob CSP.",
);
