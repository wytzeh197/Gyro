import type { DiffFile } from "./types";
import { workspaceRelativeFilePath } from "./workspace-project.ts";

// The recorded review and Git comparison use the same compact path hierarchy.
export type DiffTreeFileData = {
  path: string;
  additions?: number;
  deletions?: number;
  state?: string;
};
export type DiffTreeNode<File extends DiffTreeFileData = DiffFile> =
  DiffTreeDirectoryNode<File> | DiffTreeFileNode<File>;

type DiffTreeDirectoryNode<File extends DiffTreeFileData = DiffFile> = {
  kind: "directory";
  name: string;
  path: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  pendingFiles: number;
  children: DiffTreeNode<File>[];
};

type DiffTreeFileNode<File extends DiffTreeFileData = DiffFile> = {
  kind: "file";
  name: string;
  path: string;
  file: File;
};

export function buildDiffFileTree<File extends DiffTreeFileData>(
  files: File[],
  workspacePath?: string,
): DiffTreeNode<File>[] {
  const root: DiffTreeNode<File>[] = [];
  const directories = new Map<string, DiffTreeDirectoryNode<File>>();

  for (const file of files) {
    const displayPath = workspaceRelativeFilePath(file.path, workspacePath);
    const parts = displayPath.split("/").filter(Boolean);
    const fileName = parts.at(-1) ?? displayPath;
    const directoriesForFile = parts.slice(0, -1);
    let children = root;

    directoriesForFile.forEach((directoryName, index) => {
      const directoryPath = directoriesForFile.slice(0, index + 1).join("/");
      let directory = directories.get(directoryPath);
      if (!directory) {
        directory = {
          additions: 0,
          changedFiles: 0,
          children: [],
          deletions: 0,
          kind: "directory",
          name: directoryName,
          path: directoryPath,
          pendingFiles: 0,
        };
        directories.set(directoryPath, directory);
        children.push(directory);
      }
      children = directory.children;
    });

    children.push({
      file,
      kind: "file",
      name: fileName,
      path: file.path,
    });
  }

  const compacted = compactDiffTree(root);
  aggregateDiffTree(compacted);
  return compacted;
}

function compactDiffTree<File extends DiffTreeFileData>(
  nodes: DiffTreeNode<File>[],
): DiffTreeNode<File>[] {
  return nodes.map((node) => {
    if (node.kind !== "directory") {
      return node;
    }
    let current: DiffTreeDirectoryNode<File> = {
      ...node,
      children: compactDiffTree(node.children),
    };
    while (
      current.children.length === 1 &&
      current.children[0]?.kind === "directory"
    ) {
      const only = current.children[0];
      current = {
        ...only,
        name: `${current.name}/${only.name}`,
      };
    }
    return current;
  });
}

function aggregateDiffTree<File extends DiffTreeFileData>(
  nodes: DiffTreeNode<File>[],
) {
  nodes.sort((first, second) => {
    if (first.kind !== second.kind) {
      return first.kind === "directory" ? -1 : 1;
    }
    return first.name.localeCompare(second.name);
  });

  for (const node of nodes) {
    if (node.kind === "file") {
      continue;
    }
    aggregateDiffTree(node.children);
    node.additions = node.children.reduce(
      (sum, child) =>
        sum +
        (child.kind === "directory"
          ? child.additions
          : (child.file.additions ?? 0)),
      0,
    );
    node.deletions = node.children.reduce(
      (sum, child) =>
        sum +
        (child.kind === "directory"
          ? child.deletions
          : (child.file.deletions ?? 0)),
      0,
    );
    node.changedFiles = node.children.reduce(
      (sum, child) =>
        sum + (child.kind === "directory" ? child.changedFiles : 1),
      0,
    );
    node.pendingFiles = node.children.reduce(
      (sum, child) =>
        sum +
        (child.kind === "directory"
          ? child.pendingFiles
          : child.file.state === "pending"
            ? 1
            : 0),
      0,
    );
  }
}
