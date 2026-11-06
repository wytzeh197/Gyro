import { Folder, FolderOpen } from "./workspace-folder-icons";
import { ChevronRight, Search, X } from "lucide-react";
import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { buildDiffFileTree, type DiffTreeNode } from "./diff-file-tree";
import { FileChangeCountBadges } from "./file-change-counts-view";
import type { ReviewFile } from "./review-scope";
import { workspaceFileBadge } from "./workspace-file-icons";
import { workspaceRelativeFilePath } from "./workspace-project";
import "./review-file-navigator.css";

export function ReviewFileNavigator({
  files,
  selectedPath,
  workspacePath,
  onSelect,
}: {
  files: ReviewFile[];
  selectedPath?: string;
  workspacePath?: string;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusedKey, setFocusedKey] = useState<string>();
  const treeId = useId();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = useMemo(
    () =>
      files.filter((file) => {
        const path = workspaceRelativeFilePath(
          file.path,
          workspacePath,
        ).toLocaleLowerCase();
        return words.every((word) => path.includes(word));
      }),
    [files, workspacePath, query],
  );
  const tree = useMemo(
    () => buildDiffFileTree(filtered, workspacePath),
    [filtered, workspacePath],
  );
  const searching = words.length > 0;
  const visibleKeys = (nodes: DiffTreeNode<ReviewFile>[]): string[] =>
    nodes.flatMap((node) => [
      `${node.kind}:${node.path}`,
      ...(node.kind === "directory" && (searching || !collapsed.has(node.path))
        ? visibleKeys(node.children)
        : []),
    ]);
  const keys = visibleKeys(tree);
  const tabKey =
    focusedKey && keys.includes(focusedKey)
      ? focusedKey
      : keys.includes(`file:${selectedPath}`)
        ? `file:${selectedPath}`
        : keys[0];
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    const target = event.target;
    if (
      !(target instanceof HTMLButtonElement) ||
      target.getAttribute("role") !== "treeitem"
    )
      return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="treeitem"]',
      ),
    );
    const index = items.indexOf(target);
    const level = Number(target.getAttribute("aria-level"));
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown")
      next = items[Math.min(index + 1, items.length - 1)];
    else if (event.key === "ArrowUp") next = items[Math.max(0, index - 1)];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "ArrowRight") {
      if (target.getAttribute("aria-expanded") === "false") target.click();
      else if (Number(items[index + 1]?.getAttribute("aria-level")) > level)
        next = items[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (target.getAttribute("aria-expanded") === "true" && !searching)
        target.click();
      else
        next = items
          .slice(0, index)
          .reverse()
          .find((item) => Number(item.getAttribute("aria-level")) < level);
    } else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  };
  const renderNode = (node: DiffTreeNode<ReviewFile>, depth = 0): ReactNode => {
    if (node.kind === "file") {
      const badge = workspaceFileBadge(node.path);
      const Icon = badge.icon;
      return (
        <button
          key={`file:${node.path}`}
          type="button"
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={node.path === selectedPath}
          tabIndex={tabKey === `file:${node.path}` ? 0 : -1}
          onFocus={() => setFocusedKey(`file:${node.path}`)}
          className={`gyro-review-tree-file${node.path === selectedPath ? " is-active" : ""}`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          title={node.path}
          onClick={() => onSelect(node.path)}
        >
          <Icon
            className="gyro-workspace-search-file-icon"
            data-file-tone={badge.tone}
            size={14}
            aria-hidden="true"
          />
          <span>{node.name}</span>
          <small>
            <FileChangeCountBadges counts={node.file} showUnknown={false} />
          </small>
        </button>
      );
    }
    const open = searching || !collapsed.has(node.path);
    return (
      <div key={`directory:${node.path}`}>
        <button
          className="gyro-review-tree-directory"
          type="button"
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={open}
          tabIndex={tabKey === `directory:${node.path}` ? 0 : -1}
          onFocus={() => setFocusedKey(`directory:${node.path}`)}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          title={node.path}
          onClick={() => {
            if (!searching) toggle(node.path);
          }}
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={open ? "is-open" : ""}
          />
          {open ? (
            <FolderOpen size={14} aria-hidden="true" />
          ) : (
            <Folder size={14} aria-hidden="true" />
          )}
          <span>{node.name}</span>
          <small>{node.changedFiles}</small>
        </button>
        {open ? (
          <div role="group">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <aside className="gyro-review-files" aria-label="Changed files">
      <div className="gyro-review-file-filter">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          aria-label="Filter changed files"
          aria-controls={treeId}
          placeholder="Filter files…"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget
                .closest("aside")
                ?.querySelector<HTMLButtonElement>('[role="treeitem"]')
                ?.focus();
            }
          }}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear file filter"
            title="Clear file filter"
            onClick={() => setQuery("")}
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      <div
        id={treeId}
        role="tree"
        aria-label="Select a changed file"
        className="gyro-review-file-tree"
        onKeyDown={onTreeKeyDown}
      >
        {tree.map((node) => renderNode(node))}
        {!tree.length ? <p role="status">No matching files.</p> : null}
      </div>
      {searching ? (
        <div className="gyro-review-filter-count" role="status">
          {filtered.length} of {files.length} files
        </div>
      ) : null}
    </aside>
  );
}
