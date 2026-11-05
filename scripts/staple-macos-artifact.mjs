import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runStapler } from "./macos-stapler.mjs";
const artifact = process.argv[2];
if (process.argv.length !== 3 || !artifact || !existsSync(artifact))
  throw new Error("Provide exactly one existing notarized artifact");
runStapler("staple", resolve(artifact));
console.log("Notarization ticket stapled.");
