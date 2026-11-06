// Production Workspace panes and tokenizers. No language server is connected.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveLanguage, type ResolvedTheme } from "@gyro-dev/ui";
import * as monaco from "monaco-editor";
import { loadSyntax } from "./monaco-editor";
import { MonacoEditorPane } from "./editor/workspace-code-editor";
import { canonicalFileUri } from "./editor/document-uri";
import "@gyro-dev/ui/styles.css";
import "./workspace-syntax-fixture.css";
import { workspaceSyntaxSamples as samples } from "./workspace-syntax-samples";

function Fixture() {
  const [theme, setTheme] = useState<ResolvedTheme>("dark");
  const [generation, setGeneration] = useState(0);
  const [contents, setContents] = useState<Record<string, string>>(samples);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    monaco.editor.setTheme(theme === "light" ? "gyro-light" : "gyro-dark");
  }, [theme]);
  useEffect(() => {
    Object.assign(window, {
      __syntaxFixture: {
        monaco,
        samples,
        remountPanes: () => setGeneration((current) => current + 1),
        tokenization: async (
          path: keyof typeof samples,
          content = samples[path],
        ) => {
          const result = await loadSyntax(resolveLanguage({ path, content }));
          return {
            ...result,
            lines: monaco.editor.tokenize(content, result.language),
          };
        },
        model: (path: string) =>
          monaco.editor.getModel(monaco.Uri.parse(canonicalFileUri(path))),
      },
    });
    return () => {
      delete (window as typeof window & { __syntaxFixture?: unknown })
        .__syntaxFixture;
    };
  }, []);
  return (
    <main className="workspace-syntax-fixture">
      <header>
        <strong>Workspace syntax</strong>
        <span>Production tokenizers · no language server</span>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          Switch to {theme === "dark" ? "light" : "dark"}
        </button>
      </header>
      <div className="workspace-syntax-fixture-panes">
        {Object.keys(samples).map((path) => (
          <section
            className="workspace-syntax-fixture-pane"
            key={`${generation}:${path}`}
            data-path={path}
          >
            <div className="workspace-syntax-fixture-tab">{path}</div>
            <MonacoEditorPane
              path={path}
              fileContent={{
                path,
                content: contents[path] ?? "",
                contentHash: "syntax-fixture",
                sizeBytes: (contents[path] ?? "").length,
                truncated: false,
              }}
              loadState="ready"
              minimapEnabled={false}
              theme={theme}
              onChange={(content) =>
                setContents((current) => ({ ...current, [path]: content }))
              }
              onSelectionChange={() => undefined}
            />
          </section>
        ))}
      </div>
      <footer>
        Vue, Svelte, Astro and Sass · embedded TypeScript, CSS and SCSS · local
        grammar assets
      </footer>
    </main>
  );
}

if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
