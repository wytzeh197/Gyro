// Explicit native acceptance entrypoint; excluded from ordinary Vite builds.
import * as monaco from "monaco-editor";
import { resolveLanguage } from "@gyro-dev/ui";
import { loadSyntax } from "./monaco-editor";
import { workspaceSyntaxSamples } from "./workspace-syntax-samples";

const options = (
  window as typeof window & {
    __nativeSyntaxSmoke?: { blockedWasm: boolean };
  }
).__nativeSyntaxSmoke;
const blockedWasm = options?.blockedWasm ?? false;
const checks: string[] = [];
const fetches: string[] = [];
const violations: { directive: string; blocked: string }[] = [];
const errors: string[] = [];
const palettes: unknown[] = [];
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  fetches.push(input instanceof Request ? input.url : String(input));
  return originalFetch(input, init);
};
window.addEventListener("securitypolicyviolation", (event) => {
  violations.push({
    directive: event.effectiveDirective,
    blocked: event.blockedURI,
  });
});
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason)),
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(message);
}
type Sample = {
  path: string;
  content: string;
  lines: monaco.Token[][];
};
function roleAt(sample: Sample, lineNumber: number, fragment: string) {
  const offset = sample.content.split("\n")[lineNumber - 1]!.indexOf(fragment);
  assert(offset >= 0, `${sample.path}:${lineNumber} contains ${fragment}`);
  return sample.lines[lineNumber - 1]!.findLast(
    (token) => token.offset <= offset,
  )?.type;
}
async function until<T>(
  read: () => T | undefined,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
const report = async (passed: boolean, error?: unknown) => {
  const payload = JSON.stringify({
    passed,
    blockedWasm,
    origin: location.origin,
    href: location.href,
    userAgent: navigator.userAgent,
    checks,
    fetches,
    resources: performance
      .getEntriesByType("resource")
      .map((entry) => entry.name),
    violations,
    errors,
    palettes,
    ...(error ? { error: String(error) } : {}),
  });
  // WebKit bounds title notifications to roughly 1 KiB. Preserve the complete
  // diagnostic report with short, bounded pieces; native reassembles it once.
  const characters = [...payload];
  const count = Math.ceil(characters.length / 400);
  for (let index = 0; index < count; index++) {
    document.title =
      "GYRO_WORKSPACE_SYNTAX_SMOKE:" +
      JSON.stringify({
        index,
        count,
        chunk: characters.slice(index * 400, (index + 1) * 400).join(""),
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

async function run() {
  assert(!!options, "Native harness initialized the isolated page");
  assert(
    location.protocol === "tauri:",
    "Fixture uses embedded App-origin assets",
  );
  assert(
    navigator.userAgent.includes("AppleWebKit"),
    "Probe runs in native WebKit",
  );
  const host = document.getElementById("editor")!;
  const editor = monaco.editor.create(host, {
    automaticLayout: false,
    minimap: { enabled: false },
    fontSize: 14,
    "semanticHighlighting.enabled": false,
    theme: "gyro-dark",
  });
  editor.layout({ width: 700, height: 480 });
  const entries = Object.entries(workspaceSyntaxSamples);
  if (blockedWasm) {
    const [path, content] = entries[0]!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await loadSyntax(resolveLanguage({ path, content }));
      assert(
        !result.available && result.language === "plaintext" && !!result.reason,
        `Blocked WASM attempt ${attempt + 1} returns explicit plain-text fallback`,
      );
    }
    const model = monaco.editor.createModel(content, "plaintext");
    editor.setModel(model);
    model.applyEdits([
      { range: new monaco.Range(1, 1, 1, 1), text: "editable\n" },
    ]);
    assert(
      model.getValue().startsWith("editable\n"),
      "WASM failure leaves buffer editable",
    );
    const javascript = "const fallback = 'still available';";
    const syntax = await loadSyntax(
      resolveLanguage({ path: "/syntax/fallback.js", content: javascript }),
    );
    assert(
      syntax.available && syntax.language === "javascript",
      "WASM failure preserves bundled Monaco syntax",
    );
    assert(
      monaco.editor
        .tokenize(javascript, syntax.language)[0]!
        .some((token) => token.type.includes("keyword")),
      "Bundled JavaScript actually tokenizes after WASM failure",
    );
    model.dispose();
  } else {
    const samples: Sample[] = [];
    for (const [path, content] of entries) {
      const result = await loadSyntax(resolveLanguage({ path, content }));
      assert(
        result.available && result.language.startsWith("gyro-tm-"),
        `${path} installs bundled TextMate grammar`,
      );
      const sample = {
        path,
        content,
        lines: monaco.editor.tokenize(content, result.language),
      };
      samples.push(sample);
      const sass = path.endsWith(".sass");
      assert(
        roleAt(sample, sass ? 4 : 2, "comment starts here") === "comment",
        `${path} opens block comment`,
      );
      assert(
        roleAt(sample, sass ? 5 : 3, "and continues here") === "comment",
        `${path} preserves multiline comment state`,
      );
      if (!sass) {
        assert(
          roleAt(sample, 4, "const") === "storageKeyword",
          `${path} highlights embedded TypeScript`,
        );
        assert(
          roleAt(sample, 5, "Workspace") === "templateString",
          `${path} preserves multiline template state`,
        );
        assert(
          roleAt(sample, 7, "h1") === "tag",
          `${path} resumes markup after script`,
        );
      }
    }
    const [vue, svelte, astro, sass] = samples as [
      Sample,
      Sample,
      Sample,
      Sample,
    ];
    assert(
      roleAt(vue, 11, "color") === "cssProperty",
      "Vue embedded SCSS highlights CSS properties",
    );
    assert(
      roleAt(svelte, 11, "color") === "cssProperty",
      "Svelte embedded CSS highlights CSS properties",
    );
    assert(
      roleAt(astro, 12, "color") === "cssProperty",
      "Astro embedded CSS highlights CSS properties",
    );
    assert(
      ["variable", "constant"].includes(roleAt(astro, 8, "ready") ?? ""),
      "Token offsets after astral Unicode use UTF-16",
    );
    assert(
      roleAt(sass, 7, "color") === "cssProperty",
      "Indented Sass highlights CSS properties",
    );
    const result = await loadSyntax(
      resolveLanguage({ path: vue.path, content: vue.content }),
    );
    const model = monaco.editor.createModel(vue.content, result.language);
    editor.setModel(model);
    const palette = () => {
      editor.render(true);
      const spans = [
        ...host.querySelectorAll('.view-lines span[class*="mtk"]'),
      ];
      const keyword = spans.find((span) => span.textContent === "const");
      const comment = spans.find((span) =>
        span.textContent
          ?.replace(/\u00a0/g, " ")
          .includes("Vue comment starts here"),
      );
      if (!keyword || !comment) return;
      const colors = {
        keyword: getComputedStyle(keyword).color,
        comment: getComputedStyle(comment).color,
        commentStyle: getComputedStyle(comment).fontStyle,
        keywordClass: keyword.className,
        commentClass: comment.className,
      };
      if (JSON.stringify(palettes.at(-1)) !== JSON.stringify(colors))
        palettes.push(colors);
      return colors;
    };
    const dark = await until(() => {
      const colors = palette();
      return colors &&
        colors.keyword !== colors.comment &&
        colors.commentStyle === "italic"
        ? colors
        : undefined;
    }, "Native editor did not render the shared dark palette and italic comments");
    assert(
      dark.keyword !== dark.comment && dark.commentStyle === "italic",
      "Shared dark palette and comment style apply to TextMate",
    );
    monaco.editor.setTheme("gyro-light");
    const light = await until(() => {
      const next = palette();
      return next &&
        next.keyword !== dark.keyword &&
        next.comment !== dark.comment &&
        next.commentStyle === "italic"
        ? next
        : undefined;
    }, "Native editor theme did not change");
    assert(
      light.commentStyle === "italic" && light.comment !== dark.comment,
      "Existing TextMate model adopts the shared light palette",
    );
    model.applyEdits([
      {
        range: new monaco.Range(2, 1, 4, 1),
        text: "/* closed comment */\nconst edited = 'offline';\n",
      },
    ]);
    const edited = {
      path: vue.path,
      content: model.getValue(),
      lines: monaco.editor.tokenize(model.getValue(), result.language),
    };
    assert(
      roleAt(edited, 3, "const") === "storageKeyword",
      "Editing closed comment retokenizes following embedded code",
    );
    model.dispose();
  }
  editor.dispose();
  assert(
    fetches.some((url) => /\.wasm(?:$|\?)/.test(url)),
    "Oniguruma WASM requested from embedded assets",
  );
  assert(
    fetches.every(
      (url) => new URL(url, location.href).origin === location.origin,
    ),
    "No syntax fetch requires a network origin",
  );
  assert(errors.length === 0, "Native page has no uncaught errors");
  if (!blockedWasm)
    assert(
      violations.length === 0,
      "Production CSP accepts bundled syntax, rendering, and WebAssembly",
    );
  await report(true);
}
void run().catch((error) => report(false, error));
