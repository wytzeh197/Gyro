import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  "apps/desktop/src-tauri/src/session_browser.rs",
  "utf8",
);
const start = source.indexOf("  const serializeTree =");
const end = source.indexOf("  const dispatch =", start);
const serializer = source
  .slice(start, end)
  .replaceAll("{{", "{")
  .replaceAll("}}", "}");
const text = (value) => ({ nodeType: 3, textContent: value });
const element = (tag, children, attrs = {}) => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  childNodes: children,
  textContent: children.map((child) => child.textContent).join(" "),
  getAttribute: (name) => attrs[name] ?? null,
});
const run = (code, root, depth = 8) =>
  vm.runInNewContext(`${code}\nserializeTree(root, 0, depth, {left: 20000})`, {
    root,
    depth,
    isVisible: () => true,
    assignRef: () => "ref_1",
    roleOf: (el) => el.tagName.toLowerCase(),
    nameOf: (el) =>
      (el.getAttribute("aria-label") || el.textContent).slice(0, 120),
    isCredentialField: () => false,
  });
const root = element("body", [
  element("main", [
    element("div", [element("button", [text("Open settings")])]),
  ]),
]);
const compact = run(serializer, root);
assert.equal(compact.name, undefined);
assert.equal(compact.children[0].children[0].children[0].name, "Open settings");
assert.equal(compact.children[0].children[0].children[0].children, undefined);
assert.equal(
  run(serializer, root, 1).children[0].name,
  "Open settings",
  "depth-boundary summaries remain available",
);
assert.equal(
  run(
    serializer,
    element("section", [text("Contents")], { "aria-label": "Results" }),
  ).name,
  "Results",
);
const old = serializer.replace(
  /    \/\/ Expanded layout wrappers[\s\S]*?delete node.children;\n/,
  "",
);
const before = JSON.stringify(run(old, root)).length;
const after = JSON.stringify(compact).length;
assert.ok(after < before);
const controls = element("body", Array.from({ length: 35 }, (_, i) =>
  element("div", [element("button", [text(`Action ${i}`)])]),
));
const names = (node) => [
  ...(node.tag === "button" ? [node.name] : []),
  ...(node.children ?? []).flatMap(names),
];
assert.deepEqual(names(run(serializer, controls)), names(run(old, controls)),
  "compaction must preserve the same actionable controls within the traversal budget");
console.log(
  `Browser observation checks passed; fixture JSON ${before} -> ${after} bytes (${Math.round((1 - after / before) * 100)}% smaller).`,
);
