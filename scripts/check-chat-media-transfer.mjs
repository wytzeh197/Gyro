import assert from "node:assert/strict";
import {
  chatMediaFiles,
  isMediaDrag,
} from "../packages/ui/src/chat-media-transfer.ts";

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
// A drag is only droppable where the drag-over was cancelled, so the shapes a
// drag source actually advertises decide whether an image can be dropped at
// all. WebKit's DOMStringList has no `includes`; only `length`/`item` count.
const types = (...values) => {
  const list = { length: values.length, item: (index) => values[index] };
  values.forEach((value, index) => {
    list[index] = value;
  });
  return list;
};
const drop = (dragTypes, items = []) => ({ types: dragTypes, items });

assert.equal(isMediaDrag(drop(types("Files"))), true);
// Screenshots dragged out of Preview or Photos, and images dragged out of a
// page, arrive like this. Gating on "Files" alone dropped them silently.
assert.equal(isMediaDrag(drop(types("image/png"))), true);
assert.equal(isMediaDrag(drop(types("text/uri-list", "text/plain"))), true);
assert.equal(isMediaDrag(drop(types("text/plain"))), false);
assert.equal(isMediaDrag(drop(types("application/x-gyro-chat-pane"))), false);
assert.equal(isMediaDrag(drop(types(), [{ kind: "file" }])), true);
assert.equal(isMediaDrag(null), false);

console.log("Chat media transfer: 11 checks passed");
