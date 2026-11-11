#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postcss } from "./css-parser.mjs";

const path = fileURLToPath(
  new URL("../packages/ui/src/chat.css", import.meta.url),
);
const source = readFileSync(path, "utf8");
const tree = postcss.parse(source, { from: path });
const normalize = (value) => value.replace(/\s+/g, " ").trim();
const selectorKey = (rule) =>
  postcss.list.comma(rule.selector).map(normalize).sort().join(",");
const keyFor = (rule) => {
  const parents = [];
  for (
    let parent = rule.parent;
    parent && parent.type !== "root";
    parent = parent.parent
  ) {
    if (parent.type === "atrule") {
      if (/keyframes$/.test(parent.name)) return null;
      parents.unshift(`${parent.name}:${normalize(parent.params)}`);
    } else if (parent.type === "rule") return null;
  }
  return parents.join("/") + "|" + selectorKey(rule);
};
const winners = new Map();
let removed = 0;
tree.walkRules((rule) => {
  const key = keyFor(rule);
  if (!key) return;
  for (const declaration of [...rule.nodes].filter(
    (node) => node.type === "decl",
  )) {
    const property = declaration.prop.startsWith("--")
      ? declaration.prop
      : declaration.prop.toLowerCase();
    const id = `${key}|${property}`;
    const previous = winners.get(id);
    if (previous) {
      if (previous.important && !declaration.important) {
        declaration.remove();
        removed++;
        continue;
      }
      // Preserve explicit unsupported-feature fallback chains. Current chat
      // uses no layers; all other exact-selector declarations obey source order.
      if (/anchor(?:-size)?\(|light-dark\(/.test(declaration.value)) continue;
      previous.remove();
      removed++;
    }
    winners.set(id, declaration);
  }
});
let merged = 0;
function compact(container) {
  for (const node of [...(container.nodes ?? [])])
    if (node.nodes) compact(node);
  for (const node of [...(container.nodes ?? [])]) {
    if (
      (node.type === "rule" || (node.type === "atrule" && node.nodes)) &&
      !node.nodes.some((item) => item.type !== "comment")
    )
      node.remove();
  }
  let previous;
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === "comment") continue;
    if (node.type === "rule" && previous?.type === "rule") {
      if (selectorKey(node) === selectorKey(previous)) {
        previous.append(node.nodes);
        node.remove();
        merged++;
        continue;
      }
      const body = (rule) =>
        rule.nodes
          .filter((n) => n.type !== "comment")
          .map((n) => n.toString())
          .join(";");
      if (body(node) === body(previous)) {
        previous.selector += ",\n" + node.selector;
        node.remove();
        merged++;
        continue;
      }
    }
    previous = node;
  }
}
compact(tree);
let rules = 0,
  declarations = 0;
tree.walkRules(() => rules++);
tree.walkDecls(() => declarations++);
const report = {
  removedDeclarations: removed,
  adjacentMerges: merged,
  remainingRules: rules,
  remainingDeclarations: declarations,
};
writeFileSync(
  fileURLToPath(
    new URL(
      "../artifacts/chat-consolidation/collapse-report.json",
      import.meta.url,
    ),
  ),
  JSON.stringify(report, null, 2),
);
if (process.argv.includes("--apply"))
  writeFileSync(path, tree.toString() + "\n");
else
  writeFileSync(
    fileURLToPath(
      new URL(
        "../artifacts/chat-consolidation/chat-collapsed.css",
        import.meta.url,
      ),
    ),
    tree.toString(),
  );
console.log(JSON.stringify(report));
