/**
 * Turn raw terminal output into chat context a model can act on.
 *
 * A failing command prints colour codes, progress redraws and hundreds of lines
 * of build noise around the few lines that say what broke. Sending all of it
 * spends the context window on noise; sending only the tail loses the first
 * error, which is usually the real one. This keeps both: every error region,
 * plus the end of the run.
 */

export type TerminalFailureSource = {
  /** Task or terminal tab name, e.g. "lint" or "pnpm desktop:dev". */
  label: string;
  command?: string;
  workingDirectory?: string;
  exitCode?: number | null;
  /** Pane or task status, e.g. "failed" or "running". */
  status?: string;
  branch?: string;
  output: string;
  /** Text the person selected: sent as chosen rather than trimmed to errors. */
  isSelection?: boolean;
  /** Workspace root, used to turn absolute file references into relative ones. */
  workspaceRoot?: string;
  capturedAt?: string;
};

export type TerminalFileReference = {
  path: string;
  line: number;
  column?: number;
};

export type TerminalFailureContext = {
  /** Safe single-component attachment file name. */
  name: string;
  text: string;
  referencedFiles: TerminalFileReference[];
  /** Output lines left out of the excerpt. */
  omittedLines: number;
};

const MAX_CONTEXT_CHARS = 16_000;
const TAIL_LINES = 60;
const LINES_BEFORE_ERROR = 2;
const LINES_AFTER_ERROR = 10;
const MAX_REFERENCED_FILES = 5;

/* eslint-disable no-control-regex */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\u001b[@-Z\\-_]/g;
const OTHER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/* eslint-enable no-control-regex */

/**
 * Remove colour and cursor control, and resolve carriage-return redraws to
 * the text that was left on screen.
 */
export function stripTerminalControl(text: string) {
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      // A bare CR returns to column 0: progress bars redraw in place, and only
      // the final frame was ever visible.
      const frames = line.split("\r").filter((frame) => frame.length > 0);
      return (frames[frames.length - 1] ?? "")
        .replace(OTHER_CONTROL, "")
        .trimEnd();
    })
    .join("\n");
}

const ERROR_LINE_PATTERNS = [
  // rustc `error[E0425]:`, tsc `error TS2304:`, generic `error:` / `ERROR:`.
  /\berror(?:\[[A-Z]+\d+\])?:/i,
  /\berror TS\d+\b/,
  /^\s*(?:Uncaught )?(?:[A-Z][A-Za-z]*)?Error\b(?::|$)/,
  /\bpanicked at\b/,
  /^\s*(?:FAIL|FAILED)\b/,
  /\bnpm ERR!/,
  /\bERR_PNPM_\w+/,
  /\bELIFECYCLE\b/,
  /\bCommand failed with exit code\b/,
  /^Traceback \(most recent call last\)/,
  /^\s*[✗✘×]\s/,
  /\btest result: FAILED\b/,
  /\bcould not compile\b/,
];

/** Whether a line reads as an error rather than a warning or progress. */
export function isTerminalErrorLine(line: string) {
  return ERROR_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

/** Whether recent output shows an error, for commands that keep running. */
export function terminalOutputHasError(output: string) {
  // Only the recent end matters, and panes keep a long history.
  return stripTerminalControl(output.slice(-64_000))
    .split("\n")
    .slice(-400)
    .some(isTerminalErrorLine);
}

const FILE_REFERENCE =
  /(?:^|[\s("'`[<])((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}):(\d+)(?::(\d+))?/g;

/**
 * Workspace files the output points at, in first-seen order.
 *
 * Absolute paths are kept only when they sit inside the workspace; dependency
 * and build-output paths are skipped because the fix never lives there.
 */
export function extractTerminalFileReferences(
  output: string,
  workspaceRoot?: string,
): TerminalFileReference[] {
  const root = workspaceRoot?.replace(/\/+$/, "");
  const seen = new Set<string>();
  const references: TerminalFileReference[] = [];
  for (const match of output.matchAll(FILE_REFERENCE)) {
    let path = match[1] ?? "";
    if (path.startsWith("/")) {
      if (!root || !path.startsWith(`${root}/`)) continue;
      path = path.slice(root.length + 1);
    }
    path = path.replace(/^\.\//, "");
    if (
      !path ||
      path.startsWith("../") ||
      /(?:^|\/)(?:node_modules|target|dist|\.git)\//.test(path)
    ) {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    references.push({
      path,
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : undefined,
    });
    if (references.length >= MAX_REFERENCED_FILES) break;
  }
  return references;
}

/** Lines worth sending: every error region plus the end of the run. */
function excerptLines(lines: string[]) {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (!isTerminalErrorLine(line)) return;
    const start = Math.max(0, index - LINES_BEFORE_ERROR);
    const end = Math.min(lines.length - 1, index + LINES_AFTER_ERROR);
    for (let cursor = start; cursor <= end; cursor += 1) keep[cursor] = true;
  });
  for (
    let index = Math.max(0, lines.length - TAIL_LINES);
    index < lines.length;
    index += 1
  ) {
    keep[index] = true;
  }
  const excerpt: string[] = [];
  let omitted = 0;
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (gap > 0) {
        excerpt.push(`… ${gap} line${gap === 1 ? "" : "s"} omitted`);
        omitted += gap;
        gap = 0;
      }
      excerpt.push(line);
    } else {
      gap += 1;
    }
  });
  return { excerpt, omitted };
}

/** Keep the first error and the end of the run when the excerpt is still too long. */
function capExcerpt(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, omittedLines: 0 };
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget;
  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  const headEnd = head.lastIndexOf("\n");
  const tailStart = tail.indexOf("\n");
  const keptHead = headEnd > 0 ? head.slice(0, headEnd) : head;
  const keptTail = tailStart >= 0 ? tail.slice(tailStart + 1) : tail;
  const dropped = text.slice(keptHead.length, text.length - keptTail.length);
  const omittedLines = Math.max(1, dropped.split("\n").length - 2);
  return {
    text: `${keptHead}\n… ${omittedLines} lines omitted to fit the attachment\n${keptTail}`,
    omittedLines,
  };
}

function attachmentName(label: string, isSelection: boolean) {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "terminal";
  return `${slug}${isSelection ? "-selection" : "-output"}.txt`;
}

function exitLine(source: TerminalFailureSource) {
  if (typeof source.exitCode === "number") {
    return `Exit code: ${source.exitCode}${source.status ? ` (${source.status})` : ""}`;
  }
  return source.status ? `Status: ${source.status}` : undefined;
}

function shellQuote(value: string) {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildTerminalFailureContext(
  source: TerminalFailureSource,
  options: { maxChars?: number } = {},
): TerminalFailureContext {
  const clean = stripTerminalControl(source.output).replace(/\n+$/, "");
  const lines = clean.split("\n");
  const { excerpt, omitted } = source.isSelection
    ? { excerpt: lines, omitted: 0 }
    : excerptLines(lines);
  const referencedFiles = extractTerminalFileReferences(
    excerpt.join("\n"),
    source.workspaceRoot,
  );
  const command = source.command?.trim();
  const header = [
    `Terminal ${source.isSelection ? "selection" : "output"} from ${source.label}`,
    command ? `Command: ${command}` : undefined,
    source.workingDirectory
      ? `Working directory: ${source.workingDirectory}`
      : undefined,
    exitLine(source),
    source.branch ? `Branch: ${source.branch}` : undefined,
    `Captured: ${source.capturedAt ?? new Date().toISOString()}`,
    referencedFiles.length
      ? `Referenced files: ${referencedFiles
          .map((file) => `${file.path}:${file.line}`)
          .join(", ")}`
      : undefined,
    command
      ? `After fixing, re-run \`${command}\`${
          source.workingDirectory
            ? ` from ${shellQuote(source.workingDirectory)}`
            : ""
        } with the terminal tool and report whether it passes.`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  const budget = Math.max(
    1_000,
    (options.maxChars ?? MAX_CONTEXT_CHARS) - header.join("\n").length - 80,
  );
  const capped = capExcerpt(excerpt.join("\n"), budget);
  const scope = source.isSelection
    ? "selected text; colour codes removed"
    : "error lines and the last lines of the run; colour codes removed";
  return {
    name: attachmentName(source.label, Boolean(source.isSelection)),
    text: `${header.join("\n")}\n\n--- output (${scope}) ---\n${capped.text}\n`,
    referencedFiles,
    omittedLines: omitted + capped.omittedLines,
  };
}
