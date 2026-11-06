export type PersistentProcessKind = "dev-server" | "watcher" | "service";

/** Small, conservative shell reader for classification only; never executes text.
 * Unsupported shell syntax opts out of automatic supervision. */
function commandSegments(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  const flushWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === "\\" && quote !== "'") {
      if (++i >= command.length) return undefined;
      word += command[i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (
      char === ";" ||
      char === "\n" ||
      (char === "&" && command[i + 1] === "&")
    ) {
      if (char === "&") i += 1;
      flushSegment();
    } else if (/\s/.test(char)) {
      flushWord();
    } else if (/[|&<>`$()#]/.test(char)) {
      return undefined;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  flushSegment();
  return segments;
}

const basename = (word: string) => word.split("/").at(-1) ?? word;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const scriptKind = (script: string): PersistentProcessKind | undefined => {
  if (/^(?:watch(?::[\w-]+)?|[\w-]+:watch)$/.test(script)) return "watcher";
  if (/^(?:dev|serve|start)(?::[\w-]+)?$/.test(script)) return "dev-server";
  return undefined;
};

function classifyWords(
  input: string[],
  depth: number,
): PersistentProcessKind | undefined {
  if (depth > 4) return undefined;
  const words = [...input];
  while (assignment.test(words[0] ?? "")) words.shift();
  const program = basename(words.shift() ?? "");
  if (words.some((word) => ["--help", "--version", "-h", "-v"].includes(word)))
    return undefined;
  if (program === "env" || program === "exec")
    return classifyWords(words, depth + 1);
  if (["npm", "pnpm", "yarn", "bun", "npx"].includes(program)) {
    while (words[0]?.startsWith("-")) {
      const flag = words.shift()!;
      if (
        [
          "--filter",
          "-F",
          "--dir",
          "-C",
          "--prefix",
          "--cwd",
          "--workspace",
          "-w",
        ].includes(flag)
      )
        words.shift();
      else if (
        !/^(?:--(?:filter|dir|prefix|cwd|workspace)=.+|--silent|--yes|-y)$/.test(
          flag,
        )
      )
        return undefined;
    }
    if (words[0] === "exec" || words[0] === "dlx" || program === "npx") {
      if (program !== "npx") words.shift();
      return classifyWords(words, depth + 1);
    }
    if (words[0] === "run") words.shift();
    if (!words[0]) return undefined;
    if (words.includes("--watch")) return "watcher";
    return scriptKind(words[0]);
  }
  if (program === "cargo" && words[0] === "watch") return "watcher";
  if (["watchexec", "nodemon"].includes(program)) return "watcher";
  if (["tsc", "rollup", "webpack", "node"].includes(program)) {
    return words.includes("--watch") || words.includes("-w")
      ? "watcher"
      : undefined;
  }
  if (program === "vitest")
    return words.includes("run") ? undefined : "watcher";
  if (
    ["vite", "next", "nuxt", "astro", "remix", "parcel", "storybook"].includes(
      program,
    )
  ) {
    if (
      words.some((word) =>
        ["build", "check", "test", "info", "telemetry"].includes(word),
      )
    )
      return undefined;
    return !words.length ||
      words[0]?.startsWith("-") ||
      ["dev", "serve", "start", "preview"].includes(words[0]!)
      ? "dev-server"
      : undefined;
  }
  if (
    [
      "uvicorn",
      "gunicorn",
      "http-server",
      "serve",
      "webpack-dev-server",
    ].includes(program)
  )
    return "dev-server";
  if (
    /^python(?:3(?:\.\d+)?)?$/.test(program) &&
    words[0] === "-m" &&
    words[1] === "http.server"
  )
    return "dev-server";
  return undefined;
}

/** Only explicit persistent commands qualify. Names, paths and arbitrary scripts
 * are not evidence that a process should be automatically restarted. */
export function persistentProcessKind(
  command: string,
  depth = 0,
): PersistentProcessKind | undefined {
  if (depth > 4) return undefined;
  const segments = commandSegments(command);
  if (!segments?.length) return undefined;
  const first = segments[0]!;
  if (
    ["sh", "bash", "zsh", "fish"].includes(basename(first[0] ?? "")) &&
    /^-[il]*c$/.test(first[1] ?? "")
  ) {
    // Terminal summaries may omit the original quotes around the shell script.
    const inner = first.slice(2);
    if (segments.length === 1 && inner.length === 1)
      return persistentProcessKind(inner[0]!, depth + 1);
    segments[0] = inner;
  }
  // Repeating a build/test/deploy prefix on restart is not safe. Only shell
  // setup may precede the persistent command.
  if (
    segments
      .slice(0, -1)
      .some((words) => !["cd", "export", "set"].includes(words[0] ?? ""))
  )
    return undefined;
  return classifyWords(segments.at(-1)!, depth);
}
