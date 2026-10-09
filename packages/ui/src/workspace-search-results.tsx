import { ChevronRight } from "lucide-react";
import { workspaceFileBadge } from "./workspace-file-icons";
import "./workspace-search-results.css";
import { useMemo, useState } from "react";
import type { WorkspaceSearchResult } from "./types";
import { workspaceSearchPreview } from "./workspace-search-preview";

function SearchLine({
  line,
  query,
  ranges,
}: {
  line: string;
  query: string;
  ranges: WorkspaceSearchResult["ranges"];
}) {
  const preview = workspaceSearchPreview(line, query, ranges);
  return (
    <code>
      {preview.leadingEllipsis ? "…" : null}
      {preview.parts.map((part, index) =>
        part.matched ? (
          <mark key={index}>{part.text}</mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
      {preview.trailingEllipsis ? "…" : null}
    </code>
  );
}

export function WorkspaceSearchResults({
  results,
  query,
  activePath,
  replaceOpen,
  selectedPaths,
  onToggleReplacePath,
  onOpenFile,
}: {
  results: WorkspaceSearchResult[];
  query: string;
  activePath?: string;
  replaceOpen: boolean;
  selectedPaths: Set<string>;
  onToggleReplacePath: (path: string) => void;
  onOpenFile?: (path: string, line: number, column: number) => void;
}) {
  const [collapsedPaths, setCollapsedPaths] = useState(new Set<string>());
  const groups = useMemo(() => {
    const byPath = new Map<string, WorkspaceSearchResult[]>();
    for (const result of results) {
      const group = byPath.get(result.path) ?? [];
      group.push(result);
      byPath.set(result.path, group);
    }
    return [...byPath];
  }, [results]);

  return (
    <div className="gyro-workspace-search-results">
      <p className="gyro-workspace-search-summary" role="status">
        {results.length} matching {results.length === 1 ? "line" : "lines"} in{" "}
        {groups.length} {groups.length === 1 ? "file" : "files"}
      </p>
      {groups.map(([path, matches]) => {
        const collapsed = collapsedPaths.has(path);
        const slash = path.lastIndexOf("/");
        const name = path.slice(slash + 1);
        const directory = slash >= 0 ? path.slice(0, slash) : "";
        const badge = workspaceFileBadge(path);
        const FileIcon = badge.icon;
        return (
          <section className="gyro-workspace-search-file" key={path}>
            <div className="gyro-workspace-search-file-heading">
              {replaceOpen ? (
                <input
                  type="checkbox"
                  aria-label={`Include ${path} in replace`}
                  checked={selectedPaths.has(path)}
                  onChange={() => onToggleReplacePath(path)}
                />
              ) : null}
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} matches in ${path}`}
                title={path}
                onClick={() =>
                  setCollapsedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              >
                <ChevronRight
                  size={13}
                  className={collapsed ? "" : "is-expanded"}
                />
                <FileIcon
                  aria-hidden="true"
                  className="gyro-workspace-search-file-icon"
                  data-file-tone={badge.tone}
                  size={14}
                />
                <strong>{name}</strong>
                <small>{directory}</small>
                <span
                  className="gyro-workspace-search-count"
                  title="Matching lines"
                >
                  {matches.length}
                </span>
              </button>
            </div>
            {!collapsed
              ? matches.map((result, index) => (
                  <button
                    className={`gyro-workspace-search-match${activePath === path ? " is-active-file" : ""}`}
                    key={`${result.lineNumber}:${index}`}
                    type="button"
                    title={`${path}:${result.lineNumber}\n${result.line}`}
                    aria-label={`${name}, line ${result.lineNumber}: ${result.line.trim()}`}
                    onClick={() =>
                      onOpenFile?.(
                        path,
                        result.lineNumber,
                        result.ranges?.[0]?.startColumn ?? 1,
                      )
                    }
                  >
                    <span className="gyro-workspace-search-line-number">
                      {result.lineNumber}
                    </span>
                    <SearchLine
                      line={result.line}
                      query={query}
                      ranges={result.ranges}
                    />
                  </button>
                ))
              : null}
          </section>
        );
      })}
    </div>
  );
}
