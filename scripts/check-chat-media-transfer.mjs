import assert from "node:assert/strict";
import { chatMediaFiles } from "../packages/ui/src/chat-media-transfer.ts";

const image = new File(["image"], "Screenshot.PNG");
const video = new File(["video"], "clip.mov", { type: "video/quicktime" });
const text = new File(["text"], "notes.txt", { type: "text/plain" });
const item = (file) => ({ kind: "file", getAsFile: () => file });
assert.deepEqual(chatMediaFiles({ files: [image], items: [item(image)] }), [
  image,
]);
assert.deepEqual(
  chatMediaFiles({ files: [], items: [item(image), item(video)] }),
  [image, video],
);
assert.deepEqual(chatMediaFiles({ files: [text], items: [] }), []);
assert.deepEqual(
  chatMediaFiles({ files: [], items: [item(null), { kind: "string" }] }),
  [],
);
// Unknown image formats still reach attachment validation for a visible error.
const unknown = new File(["image"], "picture.unknown", {
  type: "image/unknown",
});
assert.deepEqual(chatMediaFiles({ files: [unknown], items: [] }), [unknown]);
console.log("Chat media transfer: 5 checks passed");
