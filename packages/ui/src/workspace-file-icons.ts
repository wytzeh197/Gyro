import {
  Atom,
  Binary,
  Braces,
  CirclePlay,
  Coffee,
  CodeXml,
  Database,
  FileArchive,
  FileCode2,
  FileDiff,
  FileText,
  FileType,
  Gem,
  Hash,
  Images,
  LockKeyhole,
  Settings,
} from "./icons";
import { createGyroIcon as createLucideIcon } from "./gyro-icon";
import { resolveLanguage } from "./editor/languages/registry";

// Filled letterforms stay crisp at the 14px size used by file rows. These
// glyphs inherit the same theme-aware ink as the other file icons.
const TypeScript = /* @__PURE__ */ createLucideIcon("TypeScript", [
  [
    "path",
    {
      d: "M4 7h8v2.9H9.5V18H6.5V9.9H4zm16 1.1-1.4 2c-1.8-1.35-3.9-1.4-3.9-.12 0 .7.8.99 2.2 1.36 2.44.65 3.7 1.55 3.7 3.4 0 2.1-1.63 3.42-4.15 3.42-1.8 0-3.5-.62-4.62-1.76l1.56-1.9c1.02.84 2.05 1.25 3.06 1.25 1.05 0 1.51-.37 1.51-.88 0-.61-.65-.92-2.25-1.33C13.35 13 12 12.14 12 10.11 12 8.14 13.68 7 16.12 7c1.38 0 2.7.39 3.88 1.1Z",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
]);

const JavaScript = /* @__PURE__ */ createLucideIcon("JavaScript", [
  [
    "path",
    {
      d: "M7.4 7h3.15v7.36c0 2.52-1.43 3.89-3.75 3.89-1.74 0-2.89-.75-3.55-2L5.3 14.8c.32.55.72.86 1.22.86.57 0 .88-.35.88-1.24zm12.6 1.1-1.4 2c-1.8-1.35-3.9-1.4-3.9-.12 0 .7.8.99 2.2 1.36 2.44.65 3.7 1.55 3.7 3.4 0 2.1-1.63 3.42-4.15 3.42-1.8 0-3.5-.62-4.62-1.76l1.56-1.9c1.02.84 2.05 1.25 3.06 1.25 1.05 0 1.51-.37 1.51-.88 0-.61-.65-.92-2.25-1.33C13.35 13 12 12.14 12 10.11 12 8.14 13.68 7 16.12 7c1.38 0 2.7.39 3.88 1.1Z",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
]);

const Shell = /* @__PURE__ */ createLucideIcon("Shell", [
  ["path", { d: "m5.5 8 4 4-4 4m7.5 0h5.5", key: "0" }],
]);

const Markdown = /* @__PURE__ */ createLucideIcon("Markdown", [
  [
    "path",
    {
      d: "M3.75 16V8.25l4.45 4.4 4.45-4.4V16M18 8v8m-2.75-2.75L18 16l2.75-2.75",
      key: "0",
    },
  ],
]);

const Vue = /* @__PURE__ */ createLucideIcon("Vue", [
  [
    "path",
    {
      d: "M3 5.5h4.65L12 13l4.35-7.5H21l-9 15Z",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M7.65 5.5h2.4L12 9l1.95-3.5h2.4L12 13Z",
      fill: "currentColor",
      fillOpacity: ".4",
      stroke: "none",
      key: "1",
    },
  ],
]);

const fileIcons: Record<string, typeof FileText> = {
  javascript: JavaScript,
  typescript: TypeScript,
  react: Atom,
  vue: Vue,
  java: Coffee,
  ruby: Gem,
  json: Braces,
  css: Hash,
  html: CodeXml,
  config: Settings,
  default: FileText,
  media: CirclePlay,
  binary: Binary,
  image: Images,
  font: FileType,
  archive: FileArchive,
  data: Database,
  lock: LockKeyhole,
  shell: Shell,
  markdown: Markdown,
  diff: FileDiff,
};

/** One file identity across Explorer, Source Control, search, and editor tabs. */
export function workspaceFileBadge(path: string) {
  const name =
    path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const isLockfile =
    name.endsWith(".lock") ||
    [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "bun.lockb",
      "go.sum",
    ].includes(name);
  const tone = isLockfile
    ? "lock"
    : (resolveLanguage({ path }).icon ?? "default");
  return { icon: fileIcons[tone] ?? FileCode2, tone };
}
