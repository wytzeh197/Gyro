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
      data: Buffer.from(bytes).toString("base64"), total: 4,
      nextOffset: op.offset + 2, mimeType: "image/png",
      revision: changed && op.offset ? "changed" : "original",
    };
  },
  async listen() { return () => {}; },
};
const client = new RemoteHostClient("media-host", ports);
const url = await client.previewImage("media-session", "/host/attachments/image.png");
assert.deepEqual([...new Uint8Array(await (await fetch(url)).arrayBuffer())], [1, 2, 3, 4]);
assert.deepEqual(calls.map((op) => op.offset), [0, 2]);
assert.equal(await client.previewImage("media-session", "/host/attachments/image.png"), url);
assert.equal(calls.length, 2, "cached previews do not download again");
client.dispose();
await assert.rejects(fetch(url), "disposing the host releases its preview URL");

changed = true;
const changing = new RemoteHostClient("media-host", ports);
await assert.rejects(changing.previewImage("media-session", "/host/attachments/image.png"), /changed/);
changed = false;
const recovered = await changing.previewImage("media-session", "/host/attachments/image.png");
assert.ok(recovered, "a failed preview is retryable");
changing.dispose();

const malformed = new RemoteHostClient("media-host", {
  ...ports,
  async invoke() {
    return { data: "AQ==", total: 4, nextOffset: 0, revision: "x", mimeType: "image/png" };
  },
});
await assert.rejects(malformed.previewImage("media-session", "/host/attachments/image.png"), /changed/);
malformed.dispose();
console.log("Remote media checks passed: host and session routing, ordered chunks, cache, URL cleanup, changed-file rejection and retry.");
