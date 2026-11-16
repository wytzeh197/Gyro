import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  documentSymbolKindGlyph,
  documentSymbolKindLabel,
  documentSymbolPathAt,
  type DocumentSymbol,
} from "./document-symbols";
import { useEditorCursor } from "./editor-cursor";
import type { DocumentSymbolsState } from "./types";

export type RevealDocumentSymbol = (
  path: string,
  symbol: DocumentSymbol,
) => void;

function symbolKey(symbol: DocumentSymbol) {
  const { startLineNumber, startColumn } = symbol.selectionRange;
  return `${symbol.name}:${startLineNumber}:${startColumn}`;
}

/** Explorer "Outline" section body: the active editor's symbol tree. */
export function DocumentOutline({
  state,
  onReveal,
}: {
  state?: DocumentSymbolsState;
  onReveal: RevealDocumentSymbol;
}) {
  const cursor = useEditorCursor(state?.path);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activeKeys = useMemo(
    () =>
      new Set(
        state && cursor
          ? documentSymbolPathAt(state.symbols, cursor).map(symbolKey)
          : [],
      ),
    [cursor, state],
  );
  if (!state)
    return (
      <div className="gyro-sidebar-mini-copy">
        Open a file to see its symbols.
      </div>
    );
  if (!state.symbols.length)
    return (
      <div className="gyro-sidebar-mini-copy" role="status">
        {state.status === "loading"
          ? "Reading symbols…"
          : state.status === "unavailable"
            ? "No language server provides symbols for this file."
            : "No symbols found in this file."}
      </div>
    );
  const innermost = [...activeKeys].at(-1);
  const rows = (items: readonly DocumentSymbol[], depth: number) =>
    items.map((symbol) => {
      const key = symbolKey(symbol);
      const hasChildren = symbol.children.length > 0;
      const isCollapsed = collapsed.has(key);
      return (
        <div key={key} role="none">
          <button
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            aria-label={`${documentSymbolKindLabel(symbol.kind)} ${symbol.name}`}
            aria-level={depth + 1}
            aria-selected={key === innermost}
            className={[
              "gyro-sidebar-row gyro-sidebar-explorer-row gyro-outline-row",
              key === innermost ? "is-active" : "",
              activeKeys.has(key) ? "is-on-path" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-symbol-kind={symbol.kind}
            onClick={() => onReveal(state.path, symbol)}
            role="treeitem"
            style={{ paddingLeft: `${8 + Math.min(depth, 8) * 11}px` }}
            title={`${symbol.name}${symbol.detail ? ` · ${symbol.detail}` : ""} — line ${symbol.selectionRange.startLineNumber}`}
            type="button"
          >
            <span
              aria-hidden="true"
              className="gyro-outline-twisty"
              onClick={(event) => {
                if (!hasChildren) return;
                event.stopPropagation();
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              }}
            >
              {hasChildren ? (
                isCollapsed ? (
                  <ChevronRight size={12} />
                ) : (
                  <ChevronDown size={12} />
                )
              ) : null}
            </span>
            <span aria-hidden="true" className="gyro-outline-kind">
              {documentSymbolKindGlyph(symbol.kind)}
            </span>
            <span className="gyro-outline-name">{symbol.name}</span>
            {symbol.detail ? (
              <small className="gyro-outline-detail">{symbol.detail}</small>
            ) : null}
          </button>
          {hasChildren && !isCollapsed ? rows(symbol.children, depth + 1) : null}
        </div>
      );
    });
  return (
    <div aria-label="Outline" className="gyro-outline" role="tree">
      {rows(state.symbols, 0)}
    </div>
  );
}

/**
 * Path segments, then the chain of symbols around the cursor. Subscribes to
 * the cursor store itself so a cursor move re-renders only this row.
 */
export function EditorBreadcrumbs({
  path,
  displayPath,
  symbols,
  onReveal,
}: {
  path: string;
  displayPath: string;
  symbols?: DocumentSymbolsState;
  onReveal?: RevealDocumentSymbol;
}) {
  const cursor = useEditorCursor(path);
  const chain = useMemo(
    () =>
      symbols?.path === path && cursor
        ? documentSymbolPathAt(symbols.symbols, cursor)
        : [],
    [cursor, path, symbols],
  );
  const segments = displayPath.split("/").filter(Boolean);
  return (
    <nav aria-label="Breadcrumbs" className="gyro-editor-breadcrumbs">
      {segments.map((segment, index) => (
        <span
          className={
            index === segments.length - 1
              ? "gyro-breadcrumb-file"
              : "gyro-breadcrumb-folder"
          }
          key={`${index}:${segment}`}
        >
          {index > 0 ? (
            <ChevronRight aria-hidden="true" size={11} />
          ) : null}
          {segment}
        </span>
      ))}
      {chain.map((symbol) => (
        <span className="gyro-breadcrumb-symbol" key={symbolKey(symbol)}>
          <ChevronRight aria-hidden="true" size={11} />
          <button
            aria-label={`Go to ${documentSymbolKindLabel(symbol.kind)} ${symbol.name}`}
            onClick={() => onReveal?.(path, symbol)}
            type="button"
          >
            <span aria-hidden="true" className="gyro-outline-kind">
              {documentSymbolKindGlyph(symbol.kind)}
            </span>
            {symbol.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
