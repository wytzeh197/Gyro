import { createLucideIcon, type IconNode } from "lucide-react";

// One folder silhouette across project navigation, file trees, and actions.
// The quiet face fill inherits each surface's ink, including custom accents.
const closedFolder: IconNode = [
  ["path", {
    d: "M3 8V5.75A1.75 1.75 0 0 1 4.75 4h4.1a2 2 0 0 1 1.4.58L12.5 6.5h6.75A1.75 1.75 0 0 1 21 8.25V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
    fill: "currentColor", fillOpacity: "0.08", key: "body",
  }],
  ["path", { d: "M3 9h18", strokeOpacity: "0.55", key: "lip" }],
];

export const Folder = createLucideIcon("GyroFolder", closedFolder);

export const FolderOpen = createLucideIcon("GyroFolderOpen", [
  ["path", {
    d: "M3 17.5V5.75A1.75 1.75 0 0 1 4.75 4h4.1a2 2 0 0 1 1.4.58L12.5 6.5h6.75A1.75 1.75 0 0 1 21 8.25V10",
    fill: "currentColor", fillOpacity: "0.05", strokeOpacity: "0.65", key: "back",
  }],
  ["path", {
    d: "M5 20a2 2 0 0 1-1.94-2.49l1.5-6A2 2 0 0 1 6.5 10h14a1.5 1.5 0 0 1 1.46 1.86l-1.65 6.63A2 2 0 0 1 18.37 20Z",
    fill: "currentColor", fillOpacity: "0.12", key: "face",
  }],
]);

export const FolderPlus = createLucideIcon("GyroFolderPlus", [
  ...closedFolder,
  ["path", { d: "M12 12v5m-2.5-2.5h5", key: "add" }],
]);

export const Folders = createLucideIcon("GyroFolders", [
  ["path", {
    d: "M2 15V4.5A1.5 1.5 0 0 1 3.5 3H7l2 2h7",
    strokeOpacity: "0.55", key: "stack",
  }],
  ["path", {
    d: "M6 12V9.5A1.5 1.5 0 0 1 7.5 8H11l2 2h7.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 6 19.5Z",
    fill: "currentColor", fillOpacity: "0.08", key: "body",
  }],
  ["path", { d: "M6 12.5h16", strokeOpacity: "0.55", key: "lip" }],
]);
