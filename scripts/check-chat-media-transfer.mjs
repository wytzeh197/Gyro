import assert from "node:assert/strict";
import {
  chatMediaFiles,
  chatMediaFilesFromDrop,
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
// A copied screenshot arrives as PNG and TIFF of the same picture; attaching
// both put the image in the draft twice. One copy survives, the sendable one.
const clipPng = new File(["png"], "image.png", { type: "image/png" });
const clipTiff = new File(["tiff"], "image.tiff", { type: "image/tiff" });
assert.deepEqual(chatMediaFiles({ files: [clipTiff, clipPng], items: [] }), [
  clipPng,
]);
assert.deepEqual(
  chatMediaFiles({ files: [], items: [item(clipPng), item(clipPng)] }),
  [clipPng],
);
const other = new File(["other"], "diagram.png", { type: "image/png" });
assert.deepEqual(chatMediaFiles({ files: [clipPng, other], items: [] }), [
  clipPng,
  other,
]);
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

// A browser image drag may expose a URL but no FileList. Resolve it while
// the drop still owns its data store, then hand the composer a real File.
const urlDrop = {
  types: types("text/uri-list"),
  files: [],
  items: [],
  getData: (type) =>
    type === "text/uri-list" ? "data:image/png;base64,iVBORw0KGgo=" : "",
};
const [urlImage] = await chatMediaFilesFromDrop(urlDrop);
assert.equal(urlImage.name, "image.png");
assert.equal(urlImage.type, "image/png");
assert.ok(urlImage.size > 0);
assert.deepEqual(await chatMediaFilesFromDrop({ files: [image], items: [] }), [
  image,
]);
await assert.rejects(
  chatMediaFilesFromDrop({
    types: types("text/uri-list"),
    files: [],
    items: [],
    getData: () => "",
  }),
  /readable file or URL/,
);

console.log("Chat media transfer checks passed");
