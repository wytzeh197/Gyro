import assert from "node:assert/strict";
import {
  chatMediaFiles,
  chatMediaFilesFromDrop,
  isMediaDrag,
  chatImageCanvasSize,
  sendableChatImage,
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
// A chat dragged from the sidebar must reach the chat grid even when the
// webview also advertises a URI for the dragged element.
assert.equal(
  isMediaDrag(
    drop(types("application/x-gyro-chat-session", "text/uri-list", "Files")),
  ),
  false,
);
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

// URL metadata and download limits fail visibly; malformed names remain usable.
const originalFetch = globalThis.fetch;
const remoteDrop = {
  types: types("text/uri-list"),
  files: [],
  items: [],
  getData: (type) =>
    type === "text/uri-list"
      ? "# comment\n https://example.test/bad%name.png "
      : "",
};
try {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(new Uint8Array([1, 2]), {
      headers: { "content-type": "image/png" },
    });
  };
  assert.equal(
    (await chatMediaFilesFromDrop(remoteDrop))[0].name,
    "bad_name.png",
  );
  globalThis.fetch = async () =>
    new Response("page", { headers: { "content-type": "text/html" } });
  await assert.rejects(
    chatMediaFilesFromDrop(remoteDrop),
    /did not return an image/,
  );
  globalThis.fetch = async () =>
    new Response("", {
      headers: {
        "content-type": "image/png",
        "content-length": String(32 * 1024 * 1024 + 1),
      },
    });
  await assert.rejects(chatMediaFilesFromDrop(remoteDrop), /too large/);
  globalThis.fetch = async () =>
    new Response("", { headers: { "content-type": "image/png" } });
  await assert.rejects(chatMediaFilesFromDrop(remoteDrop), /empty/);
  await assert.rejects(
    chatMediaFilesFromDrop({
      ...remoteDrop,
      getData: () => "file:///tmp/picture.png",
    }),
    /Save the image/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

// Even identical names, sizes and timestamps do not prove equal bytes.
const aliasA = new File(["a"], "image.png", {
  type: "image/png",
  lastModified: 1,
});
const aliasB = new File(["b"], "image.png", {
  type: "image/png",
  lastModified: 1,
});
assert.deepEqual(chatMediaFiles({ files: [aliasA, aliasB, aliasA] }), [
  aliasA,
  aliasB,
]);

// Same basenames from different folders must not lose a photo.
const photoA = new File(["a"], "photo.png", {
  type: "image/png",
  lastModified: 1,
});
const photoB = new File(["different"], "photo.png", {
  type: "image/png",
  lastModified: 2,
});
assert.deepEqual(chatMediaFiles({ files: [photoA, photoB, photoA] }), [
  photoA,
  photoB,
]);

const {
  pendingMediaAttachment,
  settlePendingMedia,
  trackPendingMedia,
  withMediaUploadTimeout,
  queueMediaUpload,
} = await import("../apps/desktop/src/pending-media-attachments.ts");
const timers = new Map();
let timerId = 0;
globalThis.window = {
  setTimeout: (callback) => {
    timers.set(++timerId, callback);
    return timerId;
  },
  clearTimeout: (id) => timers.delete(id),
};
try {
  const pending = pendingMediaAttachment(photoA, "image");
  const stored = { ...pending, pending: false, path: "/stored/photo.png" };
  await trackPendingMedia(pending, Promise.resolve(stored));
  assert.deepEqual(await settlePendingMedia([pending, stored]), [stored]);
  const rejected = pendingMediaAttachment(photoB, "image");
  await trackPendingMedia(rejected, Promise.resolve(undefined));
  await assert.rejects(settlePendingMedia([rejected]), /could not be uploaded/);
  await assert.rejects(
    settlePendingMedia([{ ...pending, id: "missing-upload" }]),
    /could not be uploaded/,
  );
  const starts = [];
  let finishFirst;
  const firstUpload = queueMediaUpload(() => {
    starts.push("first");
    return new Promise((resolve) => {
      finishFirst = resolve;
    });
  });
  const failedUpload = queueMediaUpload(async () => {
    starts.push("failed");
    throw new Error("upload rejected");
  });
  const failedCheck = assert.rejects(failedUpload, /upload rejected/);
  const lastUpload = queueMediaUpload(async () => {
    starts.push("last");
    return "last";
  });
  await Promise.resolve();
  assert.deepEqual(
    starts,
    ["first"],
    "only one upload may decode or invoke native IPC at once",
  );
  finishFirst("first");
  assert.equal(await firstUpload, "first");
  await failedCheck;
  assert.equal(await lastUpload, "last");
  assert.deepEqual(starts, ["first", "failed", "last"]);
  let finishNative;
  const activeAbort = new AbortController();
  const stuck = queueMediaUpload(
    () =>
      new Promise((resolve) => {
        finishNative = resolve;
      }),
    activeAbort.signal,
  );
  const stuckFailure = assert.rejects(stuck, /cancelled/);
  await Promise.resolve();
  await Promise.resolve();
  activeAbort.abort();
  await stuckFailure;
  const queuedAbort = new AbortController();
  let cancelledStarted = false;
  const cancelled = queueMediaUpload(async () => {
    cancelledStarted = true;
  }, queuedAbort.signal);
  const cancelledFailure = assert.rejects(cancelled, /cancelled/);
  queuedAbort.abort();
  await cancelledFailure;
  let retryStarted = false;
  const retry = queueMediaUpload(async () => {
    retryStarted = true;
    return "retry";
  });
  await Promise.resolve();
  assert.equal(
    retryStarted,
    false,
    "timed-out native work retains its worker slot",
  );
  finishNative("late native result");
  assert.equal(await retry, "retry");
  assert.equal(cancelledStarted, false, "cancelled queued uploads never start");
  timers.clear();
  assert.equal(await withMediaUploadTimeout(Promise.resolve("done")), "done");
  assert.equal(timers.size, 0);
  let finish;
  const timed = withMediaUploadTimeout(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const failure = assert.rejects(timed, /timed out/);
  [...timers.values()][0]();
  await failure;
  finish("late");
  await Promise.resolve();
  assert.equal(timers.size, 0);
} finally {
  delete globalThis.window;
}

assert.deepEqual(chatImageCanvasSize(1920, 1080), {
  width: 1920,
  height: 1080,
});
for (const [width, height] of [
  [20000, 16000],
  [1000, 30000],
  [8000, 8000],
]) {
  const size = chatImageCanvasSize(width, height);
  assert.ok(size.width <= 4096 && size.height <= 4096);
  assert.ok(size.width * size.height <= 12_000_000);
}
assert.throws(() => chatImageCanvasSize(0, 10), /invalid dimensions/);
const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "source.png", {
  type: "image/png",
});
assert.equal(
  await sendableChatImage(png, 100),
  png,
  "valid images remain byte-for-byte unchanged",
);
let painted;
const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({
    drawImage: (...args) => {
      painted = args.slice(1);
    },
  }),
  toBlob: (done, type) => done(new Blob(["converted"], { type })),
};
globalThis.Image = class {
  naturalWidth = 20000;
  naturalHeight = 16000;
  decode = async () => {};
};
globalThis.document = { createElement: () => canvas };
try {
  const converted = await sendableChatImage(
    new File(["GIF89a"], "source.gif"),
    100,
  );
  assert.equal(converted.type, "image/png");
  assert.deepEqual(painted.slice(0, 2), [0, 0]);
  assert.ok(painted[2] * painted[3] <= 12_000_000);
  assert.equal(canvas.width, 0, "conversion releases its backing buffer");
  assert.equal(canvas.height, 0);
} finally {
  delete globalThis.Image;
  delete globalThis.document;
}

console.log(
  "Chat media transfer, queued uploads, failure preservation and bounded conversion checks passed",
);
