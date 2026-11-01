import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IdeSurface, WorkspaceEditBar, createInitialWorkbenchState, type EditorTab } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const paths = ["/fixture/project/main.ts", "/fixture/project/greeting.ts"];
function Preview() {
  const [index, setIndex] = useState(-1);
  const [rename, setRename] = useState(false);
  const [light, setLight] = useState(true);
  const [split, setSplit] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = light ? "light" : "dark"; }, [light]);
  const activePath = paths[index];
  const tabs: EditorTab[] = index < 0 ? [] : paths.map(path => ({ path, title: path.split("/").pop()!, dirty: false }));
  return (
    <main className="header-preview">
      <style>{`
        html,body,#root { height:100%;margin:0; }
        .header-preview { height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans); }
        .header-preview > header { display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--gyro-border);font-size:12px; }
        .header-preview > header strong { margin-right:auto; }
        .header-preview > header button { border:1px solid var(--gyro-border);border-radius:6px;background:var(--gyro-pane);color:inherit;font:inherit;padding:6px 10px; }
        .header-preview > section { min-height:0;height:100%; }
        .header-preview *, .header-preview *::before, .header-preview *::after { animation:none !important;transition:none !important; }
        .header-preview footer { padding:10px 16px;border-top:1px solid var(--gyro-border);font-size:12px;color:var(--gyro-muted); }
        .header-preview pre { margin:0;padding:20px;font-size:13px;height:100%;box-sizing:border-box; }
      `}</style>
      <header>
        <strong>Workspace header · actual components / fixture data</strong>
        <button onClick={() => { setIndex(-1); setRename(false); }}>Empty workspace</button>
        <button onClick={() => setIndex(0)}>Open main.ts</button>
        <button onClick={() => setIndex(1)}>Jump to greeting.ts</button>
        <button onClick={() => setSplit(!split)}>{split ? "Single group" : "Split groups"}</button>
        <button onClick={() => setRename(!rename)}>Toggle rename changes</button>
        <button onClick={() => setLight(!light)}>{light ? "Dark theme" : "Light theme"}</button>
      </header>
      <section className="gyro-workspace-route is-code" style={{ gridTemplateRows:"minmax(0,1fr)" }}>
        <div className="gyro-workspace-primary">
          <WorkspaceEditBar paths={rename ? paths : []} canUndo={rename} busy={false} onUndo={() => setRename(false)} onSaveAll={() => setRename(false)} onOpenFile={path => setIndex(paths.indexOf(path))} />
          <IdeSurface
            workspacePath="/fixture/project" files={[]} selectedPath={activePath}
            editorTabs={tabs} activePaneTab="terminal" terminalOutput="" showEmbeddedPanel={false}
            ide={split ? { ...createInitialWorkbenchState().ide, layout:{ ...createInitialWorkbenchState().ide.layout, activeGroupId:"main", splitDirection:"right", groups:[{ id:"main",title:"Main",activePath,tabs,panes:[] },{ id:"second",title:"Second",activePath:paths[0],tabs:tabs.slice(0,1),panes:[] }] } } : undefined}
            editorNavigation={{ canBack:index > 0,canForward:index === 0,onBack:() => setIndex(0),onForward:() => setIndex(1) }}
            onSelectFile={path => setIndex(paths.indexOf(path))} onPaneTabChange={() => undefined}
            renderEditor={({ path }) => <pre aria-label="Fixture code">{path?.endsWith("greeting.ts") ? 'export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n' : 'import { greet } from "./greeting";\n\nconsole.log(greet("Workspace"));\n'}</pre>}
          />
        </div>
      </section>
      <footer aria-live="polite">{index < 0 ? "Empty workspace · no navigation row" : `Current fixture location: ${paths[index]}`} · editor text and history are local fixtures</footer>
    </main>
  );
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Preview />);
