import { useEffect, useRef } from "react";
import {
  documentSymbolsFromLsp,
  type DocumentSymbolsState,
} from "@gyro-dev/ui";

const EDIT_DEBOUNCE_MS = 400;

/**
 * One `textDocument/documentSymbol` request for the active editor feeds the
 * Outline, the symbol breadcrumbs and the `@` palette. Edits are debounced;
 * switching files asks at once. Stale answers are dropped by sequence.
 */
export function useDocumentSymbols(options: {
  path?: string;
  content?: string;
  request?: (
    path: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  current?: DocumentSymbolsState;
  onChange(state: DocumentSymbolsState | undefined): void;
}) {
  const { path, content, request } = options;
  const latest = useRef(options);
  latest.current = options;
  const sequence = useRef(0);
  const lastPath = useRef<string>();

  useEffect(() => {
    const id = ++sequence.current;
    const { onChange, current } = latest.current;
    if (!path || content === undefined || !request) {
      lastPath.current = undefined;
      if (current) onChange(undefined);
      return;
    }
    const switched = lastPath.current !== path;
    lastPath.current = path;
    if (switched || current?.path !== path)
      onChange({ path, status: "loading", symbols: [] });
    const timer = window.setTimeout(
      async () => {
        try {
          const result = await request(path, "textDocument/documentSymbol", {});
          if (id !== sequence.current) return;
          latest.current.onChange({
            path,
            status: "ready",
            symbols: documentSymbolsFromLsp(result),
          });
        } catch (failure) {
          if (id !== sequence.current) return;
          // A newer edit supersedes this one and will ask again.
          if (String(failure).includes("document changed")) return;
          const previous = latest.current.current;
          latest.current.onChange({
            path,
            status: "unavailable",
            symbols: previous?.path === path ? previous.symbols : [],
          });
        }
      },
      switched ? 0 : EDIT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [path, content, request]);
}
