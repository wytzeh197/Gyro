// Static button-rhythm audit for Gyro's desktop UI.
//
// The composer is the product's most-used button row, and its geometry is
// declared across several CSS blocks. This report shows the effective geometry
// per button family so drift (28 vs 30 vs 31px, scaled vs unscaled) is visible
// without launching the app.
//
// Usage: node docs/design/button-polish-2026-10-24/audit-buttons.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cssFiles = ["packages/ui/src/styles.css", "packages/ui/src/chat-design.css"];
const FAMILY = /(send-button|composer-tool|composer-chip|icon-?btn)/i;
const PROPS = ["height", "min-height", "width", "min-width", "padding", "border-radius", "gap"];

/** Strip comments while preserving line count so reported lines stay true. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

/** Flatten a stylesheet into { selectors, body, context, line } records. */
function parseRules(css) {
  const source = stripComments(css);
  const rules = [];
  const stack = [];
  let line = 1;
  let buffer = "";

  for (const char of source) {
    if (char === "\n") line += 1;
    if (char === "{") {
      const head = buffer.trim();
      buffer = "";
      if (/^@(-webkit-)?keyframes/.test(head)) stack.push({ kind: "ignore" });
      else if (head.startsWith("@")) stack.push({ kind: "context", head });
      else stack.push({ kind: "rule", head, line, context: stack.filter((e) => e.kind === "context").map((e) => e.head).join(" ") });
      continue;
    }
    if (char === "}") {
      const entry = stack.pop();
      if (entry?.kind === "rule") {
        rules.push({ ...entry, selectors: entry.head.split(",").map((s) => s.trim()).filter(Boolean), body: buffer });
        buffer = "";
      }
      continue;
    }
    if (char === ";") {
      if (stack.at(-1)?.kind === "rule") buffer += char;
      else buffer = "";
      continue;
    }
    buffer += char;
  }
  return rules;
}

function declarations(body) {
  const out = {};
  for (const piece of body.split(";")) {
    const at = piece.indexOf(":");
    if (at > 0) out[piece.slice(0, at).trim().toLowerCase()] = piece.slice(at + 1).trim();
  }
  return out;
}

const rows = [];
for (const file of cssFiles) {
  for (const rule of parseRules(readFileSync(resolve(root, file), "utf8"))) {
    const decls = declarations(rule.body);
    const geometry = Object.fromEntries(PROPS.filter((p) => decls[p]).map((p) => [p, decls[p]]));
    if (!Object.keys(geometry).length) continue;
    const selectors = rule.selectors.filter((s) => FAMILY.test(s));
    if (selectors.length) rows.push({ file, line: rule.line, context: rule.context, selectors, geometry });
  }
}

const family = (s) => (/send-button/.test(s) ? "send" : /composer-tool/.test(s) ? "tool" : /composer-chip/.test(s) ? "chip" : "icon");
const familyOf = (entry) => [...new Set(entry.selectors.map(family))].join("+");

console.log("== Composer action row: declared geometry ==");
for (const entry of rows) {
  const ctx = entry.context ? ` [${entry.context}]` : "";
  console.log(`${entry.file}:${entry.line}${ctx}\n  ${entry.selectors.join(", ")}\n  ${JSON.stringify(entry.geometry)}`);
}

const byFamily = new Map();
for (const entry of rows) {
  const key = familyOf(entry);
  if (!byFamily.has(key)) byFamily.set(key, new Map());
  for (const prop of ["height", "min-height", "width", "border-radius"]) {
    const value = entry.geometry[prop];
    if (!value) continue;
    const label = `${prop}: ${value}`;
    const bucket = byFamily.get(key);
    bucket.set(label, (bucket.get(label) ?? 0) + 1);
  }
}

console.log("\n== Distinct declared values per family ==");
for (const [key, bucket] of [...byFamily].sort()) {
  console.log(`${key}:`);
  for (const [label, count] of bucket) console.log(`  ${label}  x${count}`);
}

const unscaled = rows.filter((entry) =>
  ["height", "min-height", "width", "min-width"].some((prop) => {
    const value = entry.geometry[prop];
    return value && /\d+px/.test(value) && !value.includes("var(");
  }),
);

console.log(`\n== Unscaled px geometry on button selectors: ${unscaled.length} ==`);
for (const entry of unscaled) {
  console.log(`${entry.file}:${entry.line}  ${entry.selectors.join(", ")}  ${JSON.stringify(entry.geometry)}`);
}
