import { readFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
export const releaseIdentity = JSON.parse(
  readFileSync(new URL("release-identity.json", root), "utf8"),
);
const version = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
).version;
if (
  releaseIdentity.version !== version ||
  !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseIdentity.tag)
)
  throw new Error("Release identity does not match the app version.");
if (
  releaseIdentity.tag !== `v${version}` &&
  !new RegExp(`^v${version.replaceAll(".", "\\.")}-launch\\.\\d{8}$`).test(
    releaseIdentity.tag,
  )
)
  throw new Error("Release tag must identify this app version.");
export function requireReleaseTag(tag) {
  if (tag !== releaseIdentity.tag)
    throw new Error(
      `Expected immutable release tag ${releaseIdentity.tag}, got ${tag}.`,
    );
  return releaseIdentity;
}
