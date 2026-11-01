import assert from "node:assert/strict";
import {
  canonicalFileUri,
  filePathFromUri,
} from "../apps/desktop/src/editor/document-uri.ts";
import { URI } from "../apps/desktop/node_modules/monaco-editor/esm/vs/base/common/uri.js";

for (const path of [
  "/Users/example/project/index.ts",
  "/Users/example/project with spaces/é漢字.ts",
  "/Users/example/a#b?c%20.ts",
  "/Users/example/!'()*[]:@&=+,$;.ts",
  "/Users/example/literal\\backslash.ts",
  "/Users/example/emoji-🎯.tsx",
  "/",
]) {
  const uri = canonicalFileUri(path);
  assert.equal(filePathFromUri(uri), path, `File URI roundtrip: ${path}`);
  assert.equal(URI.file(path).toString(), uri, `Model identity: ${path}`);
  assert.equal(
    URI.parse(uri).toString(),
    uri,
    `Monaco lookup identity: ${path}`,
  );
}
assert.equal(
  canonicalFileUri("/project/a/.././b//file.ts"),
  "file:///project/b/file.ts",
);
assert.equal(
  filePathFromUri("file://localhost/project/name%20with%20spaces.ts"),
  "/project/name with spaces.ts",
);
assert.equal(filePathFromUri("file:/project/file.ts"), "/project/file.ts");
assert.equal(filePathFromUri("file:///project/%2520.ts"), "/project/%20.ts");
for (const resource of [
  "/project/file.ts",
  "https://example.com/project/file.ts",
  "untitled:Untitled-1",
  "file://remote-host/project/file.ts",
  "file://user@localhost/project/file.ts",
  "file:///project/file.ts?query=true",
  "file:///project/file.ts#fragment",
  "file:///project/%00.ts",
  "file:///project/bad%escape.ts",
  "file:///project/%ED%A0%80.ts",
  "file:///project%2foutside/file.ts",
  "file:relative.ts",
])
  assert.equal(
    filePathFromUri(resource),
    undefined,
    `Reject unsupported URI: ${resource}`,
  );
assert.throws(() => canonicalFileUri("relative.ts"));
assert.throws(() => canonicalFileUri("/project/\0.ts"));
console.log(
  "Workspace file URI checks passed: escaped filenames, Monaco model identity and unsupported resources.",
);
