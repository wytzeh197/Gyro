import assert from "node:assert/strict";
import { RemoteHostClient } from "../apps/desktop/src/remote-access/client.ts";

const calls = [];
let changed = false;
const ports = {
  async invoke(command, args) {
    assert.equal(command, "remote_host_request");
    assert.equal(args.hostId, "media-host");
    const op = args.request.operation;
    calls.push(op);
    assert.equal(op.op, "readImage");
    assert.equal(op.sessionId, "media-session");
    assert.equal(op.path, "/host/attachments/image.png");
    const bytes = op.offset === 0 ? [1, 2] : [3, 4];
    return {
      data: Buffer.from(bytes).toString("base64"),
      total: 4,
      nextOffset: op.offset + 2,
      mimeType: "image/png",
      revision: changed && op.offset ? "changed" : "original",
    };
  },
  async listen() {
    return () => {};
  },
};
const client = new RemoteHostClient("media-host", ports);
const url = await client.previewImage(
  "media-session",
  "/host/attachments/image.png",
);
assert.deepEqual(
  [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
  [1, 2, 3, 4],
);
assert.deepEqual(
  calls.map((op) => op.offset),
  [0, 2],
);
assert.equal(
  await client.previewImage("media-session", "/host/attachments/image.png"),
  url,
);
assert.equal(calls.length, 2, "cached previews do not download again");
client.dispose();
await assert.rejects(fetch(url), "disposing the host releases its preview URL");

changed = true;
const changing = new RemoteHostClient("media-host", ports);
await assert.rejects(
  changing.previewImage("media-session", "/host/attachments/image.png"),
  /changed/,
);
changed = false;
const recovered = await changing.previewImage(
  "media-session",
  "/host/attachments/image.png",
);
assert.ok(recovered, "a failed preview is retryable");
changing.dispose();

const malformed = new RemoteHostClient("media-host", {
  ...ports,
  async invoke() {
    return {
      data: "AQ==",
      total: 4,
      nextOffset: 0,
      revision: "x",
      mimeType: "image/png",
    };
  },
});
await assert.rejects(
  malformed.previewImage("media-session", "/host/attachments/image.png"),
  /changed/,
);
malformed.dispose();
let malformedRequests = 0;
const unbounded = new RemoteHostClient("invalid-image-metadata", {
  async invoke(_command, { request: { operation: op } }) {
    if (++malformedRequests > 6)
      throw Error("Stopped invalid host fixture after six chunks");
    return {
      data: "AQ==",
      total: "unknown",
      nextOffset: op.offset + 1,
      revision: "same",
      mimeType: "image/png",
    };
  },
});
await assert.rejects(unbounded.previewImage("session", "image.png"));
unbounded.dispose();
for (const invalid of [
  { total: "1" },
  { total: -1 },
  { total: 1.5 },
  { total: 10 * 1024 * 1024 + 1 },
  { nextOffset: "1" },
  { nextOffset: 1.5 },
  { nextOffset: Number.MAX_SAFE_INTEGER + 1 },
  { revision: "" },
  { revision: 17 },
  { mimeType: "image/svg+xml" },
  { data: 17 },
]) {
  let count = 0;
  const bad = new RemoteHostClient("invalid-fields", {
    async invoke() {
      count++;
      return {
        data: "AQ==",
        total: 1,
        nextOffset: 1,
        revision: "version",
        mimeType: "image/png",
        ...invalid,
      };
    },
  });
  await assert.rejects(
    bad.previewImage("session", "/image"),
    /invalid|changed/,
  );
  assert.equal(count, 1);
  bad.dispose();
}
for (const changedField of [{ total: 3 }, { mimeType: "image/jpeg" }]) {
  let count = 0;
  const inconsistent = new RemoteHostClient("inconsistent-image", {
    async invoke(_command, { request: { operation: op } }) {
      count++;
      return {
        data: "AQ==",
        total: 2,
        nextOffset: op.offset + 1,
        revision: "version",
        mimeType: "image/png",
        ...(op.offset ? changedField : {}),
      };
    },
  });
  await assert.rejects(
    inconsistent.previewImage("session", "/image"),
    /changed/,
  );
  assert.equal(count, 2);
  inconsistent.dispose();
}
assert.equal(
  malformedRequests,
  1,
  "Invalid total metadata must not bypass the overall image bound",
);
console.log(
  "Remote media checks passed: host and session routing, ordered chunks, cache, URL cleanup, changed-file rejection, metadata bounds and retry.",
);
