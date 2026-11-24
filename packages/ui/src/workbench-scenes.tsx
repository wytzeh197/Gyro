import type { ReactNode } from "react";
import { Cloud, FolderOpen, MessageSquare, Terminal } from "./icons";
import { Keycap } from "./primitives";
import "./workbench-scenes.css";

function SceneTile({ children }: { children: ReactNode }) {
  return <span className="gyro-scene-tile">{children}</span>;
}

function SceneLink() {
  return (
    <span className="gyro-scene-link">
      <i />
    </span>
  );
}

function SceneHalo({ children }: { children: ReactNode }) {
  return <span className="gyro-scene-halo">{children}</span>;
}

export function WorkbenchScene({
  kind,
}: {
  kind: "providers" | "import" | "project" | "composer" | "cloud";
}) {
  if (kind === "composer") {
    return (
      <div aria-hidden="true" className="gyro-scene gyro-scene--compact">
        <div className="gyro-scene-shortcut">
          <Keycap>
            {typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
              ? "⌘"
              : "Ctrl"}
          </Keycap>
          <Keycap>↵</Keycap>
        </div>
      </div>
    );
  }
  const Start =
    kind === "import"
      ? MessageSquare
      : kind === "project"
        ? FolderOpen
        : Terminal;
  const End =
    kind === "cloud" ? Cloud : kind === "project" ? MessageSquare : null;
  return (
    <div aria-hidden="true" className={`gyro-scene gyro-scene--${kind}`}>
      <SceneTile>
        <Start size={20} strokeWidth={1.5} />
      </SceneTile>
      <SceneLink />
      <SceneHalo>
        <SceneTile>
          {End ? (
            <End size={20} strokeWidth={1.5} />
          ) : (
            <span className="gyro-brand-logo gyro-brand-mark" />
          )}
        </SceneTile>
      </SceneHalo>
      {kind === "providers" || kind === "import" ? (
        <>
          <SceneLink />
          <SceneTile>
            <MessageSquare size={20} strokeWidth={1.5} />
          </SceneTile>
        </>
      ) : null}
    </div>
  );
}
