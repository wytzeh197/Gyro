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
  createLucideIcon,
} from "lucide-react";
import { resolveLanguage } from "./editor/languages/registry";

// Filled letterforms stay crisp at the 14px size used by file rows. These
// glyphs inherit the same theme-aware ink as the other file icons.
const TypeScript = createLucideIcon("TypeScript", [
  [
    "path",
    {
      d: "M1 5h10v3H7.5v11h-3V8H1z M22 6.2l-1.5 2.4c-1.3-.9-2.3-1.3-3.5-1.3-1.2 0-1.8.5-1.8 1.3 0 .8.7 1.2 2.8 1.8 3 .9 4.5 2.1 4.5 4.5 0 2.7-2.1 4.4-5.4 4.4-2.3 0-4.3-.8-5.7-2.1l1.8-2.3c1.3 1.1 2.6 1.7 4 1.7 1.4 0 2.1-.5 2.1-1.4 0-.8-.6-1.2-2.6-1.8-3-.9-4.7-1.9-4.7-4.5 0-2.6 2-4.2 5.1-4.2 1.9 0 3.6.5 4.9 1.5z",
      fill: "currentColor",
      stroke: "none",
      key: "letters",
    },
  ],
]);
const JavaScript = createLucideIcon("JavaScript", [
  [
    "path",
    {
      d: "M7 5h3v9.4c0 3.3-1.8 4.9-4.8 4.9-2.3 0-4-1.1-4.7-3l2.6-1.6c.5 1.1 1.1 1.7 2.1 1.7 1.2 0 1.8-.6 1.8-2z M22 6.2l-1.5 2.4c-1.3-.9-2.3-1.3-3.5-1.3-1.2 0-1.8.5-1.8 1.3 0 .8.7 1.2 2.8 1.8 3 .9 4.5 2.1 4.5 4.5 0 2.7-2.1 4.4-5.4 4.4-2.3 0-4.3-.8-5.7-2.1l1.8-2.3c1.3 1.1 2.6 1.7 4 1.7 1.4 0 2.1-.5 2.1-1.4 0-.8-.6-1.2-2.6-1.8-3-.9-4.7-1.9-4.7-4.5 0-2.6 2-4.2 5.1-4.2 1.9 0 3.6.5 4.9 1.5z",
      fill: "currentColor",
      stroke: "none",
      key: "letters",
    },
  ],
]);
const Shell = createLucideIcon("Shell", [
  ["path", { d: "m4 6 6 6-6 6m9 0h7", key: "prompt" }],
]);
const Markdown = createLucideIcon("Markdown", [
  ["path", { d: "M3 18V6l5 6 5-6v12m4-5 3 4 3-4m-3 4V6", key: "mark" }],
]);
const Vue = createLucideIcon("Vue", [
  [
    "path",
    {
      d: "M2 4h4l6 10 6-10h4L12 21Z",
      fill: "currentColor",
      stroke: "none",
      key: "outer",
    },
  ],
  [
    "path",
    {
      d: "M6 4h4l2 3.5L14 4h4l-6 10Z",
      fill: "currentColor",
      fillOpacity: "0.45",
      stroke: "none",
      key: "inner",
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
