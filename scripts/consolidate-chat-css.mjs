#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { postcss } from "./css-parser.mjs";
import { readUiStyleSources } from "./ui-style-sources.mjs";
import {
  chatSelectorPattern as prefix,
  chatComponentStyles as wholeFiles,
} from "./chat-style-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "packages/ui/src");
const reportDirectory = resolve(root, "artifacts/chat-consolidation");
const apply = process.argv.includes("--apply");
const inventory = JSON.parse(
  readFileSync(resolve(reportDirectory, "inventory/dev.json")),
);
const normalize = (selector) => selector.replace(/\s+/g, " ").trim();
const sharedMatches = new Set(
  inventory.sheets.flatMap((sheet) =>
    sheet.nonChatMatches.map((rule) => normalize(rule.selector)),
  ),
);
const sources = new Map(
  readUiStyleSources()
    .filter((file) => !file.path.endsWith("/chat.css"))
    .map((file) => {
      const path = resolve(root, file.path);
      return [
        path,
        {
          ...file,
          original: file.source,
          tree: postcss.parse(file.source, { from: path }),
        },
      ];
    }),
);
const sha = (source) => createHash("sha256").update(source).digest("hex");
const seen = new Set();
const order = [];

function addFile(path) {
  if (!sources.has(path) || seen.has(path)) return;
  seen.add(path);
  const file = sources.get(path);
  for (const node of file.tree.nodes)
    if (node.type === "atrule" && node.name === "import") {
      const imported = node.params.match(/^["']([^"']+)["']/)?.[1];
      if (imported?.startsWith(".")) addFile(resolve(dirname(path), imported));
    }
  order.push(path);
}
for (const sheet of inventory.sheets) {
  const path = sheet.id.startsWith(root)
    ? sheet.id
    : resolve(root, sheet.id.replace(/^\//, ""));
  addFile(path);
}
const unvisited = [...sources.entries()]
  .filter(
    ([path, file]) =>
      !seen.has(path) &&
      file.tree.nodes.some(
        (node) => node.type === "rule" && prefix.test(node.selector),
      ),
  )
  .map(([, file]) => file.path);
if (unvisited.length)
  throw new Error(
    `Chat styles absent from the captured load order: ${unvisited.join(", ")}`,
  );

const output = postcss.root();
output.append(
  postcss.comment({
    text: "Chat stylesheet authority. Extracted in measured cascade order; shared product tokens remain in foundation. Edit this file, not a new overlay. See docs/design/chat-consolidation-plan-2026-11-10.md.",
  }),
);
const moved = [];
const split = [];
const collisions = [];
const lastChatProperty = new Map();
let index = 0;

function conditionPath(node) {
  const conditions = [];
  for (
    let parent = node.parent;
    parent && parent.type !== "root";
    parent = parent.parent
  ) {
    if (parent.type === "atrule")
      conditions.unshift(`@${parent.name} ${parent.params}`);
  }
  return conditions.join(" / ");
}

function extract(container, file, whole) {
  const extracted = [];
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === "atrule" && node.name === "import") continue;
    if (whole) {
      extracted.push(node.clone());
      node.remove();
      if (node.type === "rule")
        moved.push({
          file: file.path,
          selector: node.selector,
          conditions: conditionPath(node),
        });
      continue;
    }
    if (
      node.type === "atrule" &&
      /keyframes$/.test(node.name) &&
      /^gyro-(?:chat-|composer-|run|response)/.test(node.params)
    ) {
      extracted.push(node.clone());
      node.remove();
      continue;
    }
    if (node.type === "atrule" && node.nodes && !/keyframes$/.test(node.name)) {
      const children = extract(node, file, false);
      if (children.length) {
        const wrapper = node.clone({ nodes: [] });
        wrapper.append(children);
        extracted.push(wrapper);
      }
      if (!node.nodes.length) node.remove();
      continue;
    }
    if (node.type !== "rule") continue;
    index++;
    const selectors = postcss.list.comma(node.selector);
    const chat = selectors.filter((selector) => prefix.test(selector));
    if (!chat.length) {
      if (sharedMatches.has(normalize(node.selector)))
        for (const declaration of node.nodes.filter(
          (item) => item.type === "decl",
        )) {
          const previous = lastChatProperty.get(declaration.prop);
          if (previous)
            collisions.push({
              file: file.path,
              selector: node.selector,
              property: declaration.prop,
              after: previous,
            });
        }
      continue;
    }
    const other = selectors.filter((selector) => !prefix.test(selector));
    const clone = node.clone({ selector: chat.join(",\n") });
    extracted.push(clone);
    moved.push({
      file: file.path,
      selector: clone.selector,
      conditions: conditionPath(node),
      index,
    });
    for (const declaration of node.nodes.filter((item) => item.type === "decl"))
      lastChatProperty.set(declaration.prop, {
        file: file.path,
        selector: clone.selector,
        index,
      });
    if (other.length) {
      split.push({
        file: file.path,
        original: node.selector,
        chat,
        remaining: other,
      });
      node.selector = other.join(",\n");
    } else node.remove();
  }
  return extracted;
}

for (const path of order) {
  const file = sources.get(path);
  const nodes = extract(
    file.tree,
    file,
    wholeFiles.has(relative(directory, path)),
  );
  if (nodes.length) {
    output.append(postcss.comment({ text: `Source: ${file.path}` }));
    output.append(nodes);
  }
}

const renderedClasses = new Set(inventory.classes);
const remaining = [];
for (const file of sources.values())
  file.tree.walkRules((rule) => {
    const matches = [...rule.selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(
      (match) => match[1],
    );
    if (matches.some((name) => renderedClasses.has(name)))
      remaining.push({ file: file.path, selector: rule.selector });
  });
mkdirSync(reportDirectory, { recursive: true });
writeFileSync(
  resolve(reportDirectory, "extraction-report.json"),
  JSON.stringify(
    {
      order: order.map((path) => relative(root, path)),
      moved,
      split,
      collisions,
      remaining,
    },
    null,
    2,
  ),
);
writeFileSync(
  resolve(reportDirectory, "chat-extracted.css"),
  output.toString(),
);
console.log(
  JSON.stringify({
    moved: moved.length,
    mixedLists: split.length,
    sharedCollisionCandidates: collisions.length,
    remainingMatchingSelectors: remaining.length,
    lines: output.toString().split("\n").length,
  }),
);
if (apply) {
  if (existsSync(resolve(directory, "chat.css")))
    throw new Error("chat.css already exists; refusing to overwrite it.");
  for (const [path, file] of sources)
    if (sha(readFileSync(path, "utf8")) !== sha(file.original))
      throw new Error(`Concurrent edit: ${file.path}`);
  for (const [path, file] of sources)
    if (file.tree.toString() !== file.original)
      writeFileSync(path, file.tree.toString());
  writeFileSync(resolve(directory, "chat.css"), output.toString() + "\n");
  const entry = resolve(directory, "styles-entry.css");
  writeFileSync(
    entry,
    readFileSync(entry, "utf8").trimEnd() + '\n@import "./chat.css";\n',
  );
  for (const name of [
    "chat-run-view.tsx",
    "chat-file-card.tsx",
    "chat-question-popup.tsx",
    "chat-task-suggestions.tsx",
    "surfaces.tsx",
    "workspace-sidebar.tsx",
    "plan-mode.tsx",
    "subagents-view.tsx",
    "code-mode-card.tsx",
  ]) {
    const path = resolve(directory, name);
    const source = readFileSync(path, "utf8");
    writeFileSync(
      path,
      source.replace(/^import "\.\/([^"\n]+\.css)";\n/gm, (line, file) =>
        wholeFiles.has(file) ? "" : line,
      ),
    );
  }
}
