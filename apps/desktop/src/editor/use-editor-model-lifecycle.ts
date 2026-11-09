import { useLayoutEffect, useRef } from "react";
import type { IdeState } from "@gyro-dev/ui";
import { retireEditorModels } from "./model-retirement";
import { canonicalFileUri } from "./document-uri";

/** Tabs own models even while their asynchronous file read is still pending. */
export function editorModelUris(
  ide: Pick<IdeState, "buffers" | "tabs" | "layout">,
) {
  const uris = new Set<string>();
  const paths = [
    ...Object.keys(ide.buffers),
    ...ide.tabs.map((tab) => tab.path),
    ...ide.layout.groups.flatMap((group) => [
      ...group.tabs.map((tab) => tab.path),
      ...group.panes.map((pane) => pane.path),
    ]),
  ];
  for (const path of paths) {
    // Diff previews have their own model lifetime; legacy/invalid paths must
    // not turn a cleanup operation into a render error.
    if (!path?.startsWith("/")) continue;
    try {
      uris.add(canonicalFileUri(path));
    } catch {
      /* Unsupported local path. */
    }
  }
  return uris;
}

/** Models follow committed ownership, including implicit preview closes. */
export function useEditorModelLifecycle(
  ide: Pick<IdeState, "buffers" | "tabs" | "layout">,
) {
  const committedPaths = useRef(new Set<string>());
  useLayoutEffect(() => {
    const next = editorModelUris(ide);
    const removed = [...committedPaths.current].filter(
      (path) => !next.has(path),
    );
    committedPaths.current = next;
    retireEditorModels(removed, (path) => !committedPaths.current.has(path));
  }, [ide.buffers, ide.tabs, ide.layout]);
}
