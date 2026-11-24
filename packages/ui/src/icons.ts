import { createGyroIcon as createLucideIcon } from "./gyro-icon";

// Gyro's 24-unit glyphs share the established icon props and SVG class names.
// Callers control icon size, stroke width, and semantic color; gyro-icon adds
// the shared optical weight for small sizes.
export type { LucideIcon, LucideProps } from "lucide-react";

export const Activity = /* @__PURE__ */ createLucideIcon("Activity", [
  ["path", { d: "M3 12h4l2.2-4.5 4.3 9.5 2.2-5H21", key: "0" }],
]);

export const AppWindow = /* @__PURE__ */ createLucideIcon("AppWindow", [
  ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "0" }],
  ["path", { d: "M3 9.5h18", key: "1" }],
  [
    "circle",
    {
      cx: "6",
      cy: "7.25",
      r: "0.8",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
  [
    "circle",
    {
      cx: "8.75",
      cy: "7.25",
      r: "0.8",
      fill: "currentColor",
      stroke: "none",
      key: "3",
    },
  ],
]);

export const Archive = /* @__PURE__ */ createLucideIcon("Archive", [
  ["rect", { x: "4", y: "5", width: "16", height: "4.5", rx: "1.5", key: "0" }],
  [
    "path",
    { d: "M5.5 9.5v7.75a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9.5M10 13h4", key: "1" },
  ],
]);

export const ArrowDown = /* @__PURE__ */ createLucideIcon("ArrowDown", [
  [
    "path",
    {
      d: "M6 12h12m-4.5-4.5L18 12l-4.5 4.5",
      transform: "rotate(90 12 12)",
      key: "0",
    },
  ],
]);

export const ArrowLeft = /* @__PURE__ */ createLucideIcon("ArrowLeft", [
  [
    "path",
    {
      d: "M6 12h12m-4.5-4.5L18 12l-4.5 4.5",
      transform: "rotate(180 12 12)",
      key: "0",
    },
  ],
]);

export const ArrowRight = /* @__PURE__ */ createLucideIcon("ArrowRight", [
  ["path", { d: "M6 12h12m-4.5-4.5L18 12l-4.5 4.5", key: "0" }],
]);

export const ArrowUp = /* @__PURE__ */ createLucideIcon("ArrowUp", [
  [
    "path",
    {
      d: "M6 12h12m-4.5-4.5L18 12l-4.5 4.5",
      transform: "rotate(-90 12 12)",
      key: "0",
    },
  ],
]);

export const ArrowUpRight = /* @__PURE__ */ createLucideIcon("ArrowUpRight", [
  ["path", { d: "M7 17 17 7m-7 0h7v7", key: "0" }],
]);

export const AtSign = /* @__PURE__ */ createLucideIcon("AtSign", [
  [
    "path",
    { d: "M17.5 19.25A8.5 8.5 0 1 1 20.5 12v1.25a2 2 0 0 1-4 0V9", key: "0" },
  ],
  ["circle", { cx: "12.7", cy: "12", r: "3.8", key: "1" }],
]);

export const Atom = /* @__PURE__ */ createLucideIcon("Atom", [
  [
    "ellipse",
    {
      cx: "12",
      cy: "12",
      rx: "3.65",
      ry: "8.5",
      transform: "rotate(45 12 12)",
      key: "0",
    },
  ],
  [
    "ellipse",
    {
      cx: "12",
      cy: "12",
      rx: "3.65",
      ry: "8.5",
      transform: "rotate(135 12 12)",
      key: "1",
    },
  ],
  [
    "circle",
    {
      cx: "12",
      cy: "12",
      r: "1.28",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const Bell = /* @__PURE__ */ createLucideIcon("Bell", [
  [
    "path",
    {
      d: "M18 10.25c0-3.4-2.3-5.75-6-5.75s-6 2.35-6 5.75v3.7L4.5 16h15L18 13.95Zm-8 8.5c.6 1 3.4 1 4 0",
      key: "0",
    },
  ],
]);

export const Binary = /* @__PURE__ */ createLucideIcon("Binary", [
  [
    "rect",
    { x: "4.5", y: "5", width: "4.75", height: "6.25", rx: "1.45", key: "0" },
  ],
  [
    "rect",
    {
      x: "14.75",
      y: "12.75",
      width: "4.75",
      height: "6.25",
      rx: "1.45",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "m15.65 6.2 1.5-1.2v6.25m-1.75 0h3.5m-13 2.7 1.5-1.2V19m-1.75 0h3.5",
      key: "2",
    },
  ],
]);

export const Blocks = /* @__PURE__ */ createLucideIcon("Blocks", [
  [
    "path",
    {
      d: "M5 8h4.5v6h6v4.5A1.5 1.5 0 0 1 14 20H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 8Zm-1.5 6h6v6",
      key: "0",
    },
  ],
  [
    "rect",
    {
      x: "13.5",
      y: "4.5",
      width: "6.3",
      height: "6.3",
      rx: "1.35",
      transform: "rotate(-10 16.65 7.65)",
      key: "1",
    },
  ],
]);

export const Book = /* @__PURE__ */ createLucideIcon("Book", [
  [
    "path",
    {
      d: "M6.5 4.25H17A1.75 1.75 0 0 1 18.75 6v13.75H6.5a2.25 2.25 0 0 1-2.25-2.25v-11A2.25 2.25 0 0 1 6.5 4.25Zm12.25 11H6.5a2.25 2.25 0 0 0 0 4.5",
      key: "0",
    },
  ],
]);

export const BookOpen = /* @__PURE__ */ createLucideIcon("BookOpen", [
  [
    "path",
    {
      d: "M12 19.6a6.5 6.5 0 0 0-4.2-1.8H3.5V5.5h4.3c1.8 0 3.25.85 4.2 2m0 12.1a6.5 6.5 0 0 1 4.2-1.8h4.3V5.5h-4.3c-1.8 0-3.25.85-4.2 2m0 0v12.1",
      key: "0",
    },
  ],
]);

export const Box = /* @__PURE__ */ createLucideIcon("Box", [
  [
    "path",
    { d: "M12 3.5 20 8v8l-8 4.5L4 16V8Zm0 17v-8m-8-4.5 8 4.5L20 8", key: "0" },
  ],
]);

export const Boxes = /* @__PURE__ */ createLucideIcon("Boxes", [
  [
    "path",
    {
      d: "M12 3.5 16.4 6v5L12 13.5 7.6 11V6Zm0 10V8.5m-4.4-2.5L12 8.5 16.4 6M7.6 11 3.25 13.5v5l4.35 2.5 4.4-2.5v-5m-8.75 0L7.6 16l4.4-2.5M7.6 16v5m8.8-10 4.35 2.5v5L16.4 21 12 18.5m0-5 4.4 2.5 4.35-2.5M16.4 16v5",
      strokeWidth: "1.65",
      key: "0",
    },
  ],
]);

export const Braces = /* @__PURE__ */ createLucideIcon("Braces", [
  [
    "path",
    {
      d: "M8.25 4.5H7a1.5 1.5 0 0 0-1.5 1.5v3.4a2.6 2.6 0 0 1-2.25 2.6 2.6 2.6 0 0 1 2.25 2.6V18A1.5 1.5 0 0 0 7 19.5h1.25m7.5-15H17a1.5 1.5 0 0 1 1.5 1.5v3.4a2.6 2.6 0 0 0 2.25 2.6 2.6 2.6 0 0 0-2.25 2.6V18a1.5 1.5 0 0 1-1.5 1.5h-1.25",
      key: "0",
    },
  ],
]);

export const Brain = /* @__PURE__ */ createLucideIcon("Brain", [
  [
    "path",
    {
      d: "M12 6a3.25 3.25 0 0 0-6.25-1.25 3.7 3.7 0 0 0-1.5 5.35A4 4 0 0 0 5.9 17a3.2 3.2 0 0 0 6.1 1.25V6Zm0 0a3.25 3.25 0 0 1 6.25-1.25 3.7 3.7 0 0 1 1.5 5.35A4 4 0 0 1 18.1 17a3.2 3.2 0 0 1-6.1 1.25M5.85 10.2c1.35.05 2.1.7 2.35 2m9.95-2c-1.35.05-2.1.7-2.35 2",
      strokeWidth: "1.75",
      key: "0",
    },
  ],
]);

export const Bug = /* @__PURE__ */ createLucideIcon("Bug", [
  ["path", { d: "M8 10a4 4 0 1 1 8 0v5a4 4 0 1 1-8 0Zm4 0v8", key: "0" }],
  [
    "path",
    {
      d: "M6 4.5l2.95 2.3M18 4.5l-2.95 2.3M3.5 9.5 8 11m-4.5 3H8m-3.5 5.25L8.6 17M20.5 9.5 16 11m4.5 3H16m3.5 5.25L15.4 17",
      strokeWidth: "1.65",
      key: "1",
    },
  ],
]);

export const CalendarClock = /* @__PURE__ */ createLucideIcon("CalendarClock", [
  [
    "rect",
    { x: "4", y: "5.25", width: "16", height: "14.5", rx: "2.5", key: "0" },
  ],
  ["path", { d: "M8 3.75v3.5m8-3.5v3.5M4 9.5h16", key: "1" }],
  ["circle", { cx: "12", cy: "14.5", r: "2.75", key: "2" }],
  ["path", { d: "M12 13.6v1.3h1", key: "3" }],
]);

export const Camera = /* @__PURE__ */ createLucideIcon("Camera", [
  [
    "path",
    {
      d: "M5.5 7.5h3L10 5.25h4l1.5 2.25h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z",
      key: "0",
    },
  ],
  ["circle", { cx: "12", cy: "13", r: "3", key: "1" }],
]);

export const Check = /* @__PURE__ */ createLucideIcon("Check", [
  ["path", { d: "m5.5 12 4 4L18.5 7", key: "0" }],
]);

export const ChevronDown = /* @__PURE__ */ createLucideIcon("ChevronDown", [
  ["path", { d: "m8 10 4 4 4-4", key: "0" }],
]);

export const ChevronLeft = /* @__PURE__ */ createLucideIcon("ChevronLeft", [
  ["path", { d: "m8 10 4 4 4-4", transform: "rotate(90 12 12)", key: "0" }],
]);

export const ChevronRight = /* @__PURE__ */ createLucideIcon("ChevronRight", [
  ["path", { d: "m8 10 4 4 4-4", transform: "rotate(-90 12 12)", key: "0" }],
]);

export const ChevronUp = /* @__PURE__ */ createLucideIcon("ChevronUp", [
  ["path", { d: "m8 10 4 4 4-4", transform: "rotate(180 12 12)", key: "0" }],
]);

export const Circle = /* @__PURE__ */ createLucideIcon("Circle", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
]);

export const CircleAlert = /* @__PURE__ */ createLucideIcon("CircleAlert", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  ["path", { d: "M12 7.75V12.5", key: "1" }],
  [
    "circle",
    {
      cx: "12",
      cy: "16",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);
export { CircleAlert as AlertCircle };

export const CircleDashed = /* @__PURE__ */ createLucideIcon("CircleDashed", [
  [
    "circle",
    {
      cx: "12",
      cy: "12",
      r: "8.5",
      strokeDasharray: "3.2 4.43",
      transform: "rotate(-15 12 12)",
      key: "0",
    },
  ],
]);

export const HelpCircle = /* @__PURE__ */ createLucideIcon("CircleHelp", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "path",
    { d: "M9.7 9.1a2.4 2.4 0 0 1 4.6.85c0 1.85-2.3 2-2.3 3.75", key: "1" },
  ],
  [
    "circle",
    {
      cx: "12",
      cy: "16.6",
      r: "1.05",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const CircleMinus = /* @__PURE__ */ createLucideIcon("CircleMinus", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  ["path", { d: "M8.5 12h7", key: "1" }],
]);

export const PauseCircle = /* @__PURE__ */ createLucideIcon("CirclePause", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "rect",
    {
      x: "7",
      y: "5.75",
      width: "3.5",
      height: "12.5",
      rx: "1",
      fill: "currentColor",
      stroke: "none",
      transform: "translate(4.2 4.2) scale(.65)",
      key: "1",
    },
  ],
  [
    "rect",
    {
      x: "13.5",
      y: "5.75",
      width: "3.5",
      height: "12.5",
      rx: "1",
      fill: "currentColor",
      stroke: "none",
      transform: "translate(4.2 4.2) scale(.65)",
      key: "2",
    },
  ],
]);

export const CirclePlay = /* @__PURE__ */ createLucideIcon("CirclePlay", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "path",
    {
      d: "M9 6.25a.9.9 0 0 0-1.4.75v10a.9.9 0 0 0 1.4.75l7.75-5a.9.9 0 0 0 0-1.5Z",
      fill: "currentColor",
      stroke: "none",
      transform: "translate(4.2 4.2) scale(.65)",
      key: "1",
    },
  ],
]);

export const UserCircle = /* @__PURE__ */ createLucideIcon("CircleUser", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  ["circle", { cx: "12", cy: "9", r: "2.55", key: "1" }],
  [
    "path",
    {
      d: "M6.15 17.9c.9-2.6 2.95-3.95 5.85-3.95s4.95 1.35 5.85 3.95",
      key: "2",
    },
  ],
]);

export const XCircle = /* @__PURE__ */ createLucideIcon("CircleX", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "path",
    {
      d: "m7 7 10 10M17 7 7 17",
      transform: "translate(4.2 4.2) scale(.65)",
      key: "1",
    },
  ],
]);

export const Clock = /* @__PURE__ */ createLucideIcon("Clock", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  ["path", { d: "M12 7v5l3.25 2", key: "1" }],
]);

export const Cloud = /* @__PURE__ */ createLucideIcon("Cloud", [
  [
    "path",
    {
      d: "M7 17.5a4.2 4.2 0 0 1-.55-8.35 5.45 5.45 0 0 1 10.35 1.1A3.65 3.65 0 1 1 18 17.5Z",
      key: "0",
    },
  ],
]);

export const CloudUpload = /* @__PURE__ */ createLucideIcon("CloudUpload", [
  [
    "path",
    {
      d: "M7.25 17h-.6a3.75 3.75 0 0 1-.35-7.48 5.7 5.7 0 0 1 10.85 1A3.3 3.3 0 1 1 18 17h-1.25M12 20v-8m-3 3 3-3 3 3",
      key: "0",
    },
  ],
]);

export const CodeXml = /* @__PURE__ */ createLucideIcon("CodeXml", [
  ["path", { d: "m7.5 8-4 4 4 4m9-8 4 4-4 4M13.5 6l-3 12", key: "0" }],
]);

export const Coffee = /* @__PURE__ */ createLucideIcon("Coffee", [
  [
    "path",
    {
      d: "M4.5 10h11v4.25a4.25 4.25 0 0 1-4.25 4.25h-2.5a4.25 4.25 0 0 1-4.25-4.25Zm11.25.75h1.4a2.35 2.35 0 0 1 0 4.7H15M3.5 20.5h14m-10-14V4m3 2.5V4m3 2.5V4",
      key: "0",
    },
  ],
]);

export const Columns2 = /* @__PURE__ */ createLucideIcon("Columns2", [
  ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "0" }],
  ["path", { d: "M12 5v14", key: "1" }],
]);

export const Command = /* @__PURE__ */ createLucideIcon("Command", [
  [
    "path",
    {
      d: "M8.25 8.25H6a2.25 2.25 0 1 1 2.25-2.25v12a2.25 2.25 0 1 1-2.25-2.25h12a2.25 2.25 0 1 1-2.25 2.25V6A2.25 2.25 0 1 1 18 8.25Z",
      key: "0",
    },
  ],
]);

export const Copy = /* @__PURE__ */ createLucideIcon("Copy", [
  [
    "rect",
    { x: "8.5", y: "8.5", width: "11.5", height: "11.5", rx: "2.5", key: "0" },
  ],
  [
    "path",
    {
      d: "M15.5 6.25V6A2 2 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h.25",
      key: "1",
    },
  ],
]);

export const CornerDownRight = /* @__PURE__ */ createLucideIcon(
  "CornerDownRight",
  [["path", { d: "M6 6v4a4 4 0 0 0 4 4h8m-3.5-3.5L18 14l-3.5 3.5", key: "0" }]],
);

export const CreditCard = /* @__PURE__ */ createLucideIcon("CreditCard", [
  [
    "rect",
    { x: "3", y: "5.5", width: "18", height: "13", rx: "2.75", key: "0" },
  ],
  ["path", { d: "M3 10.5h18M7 15h3", key: "1" }],
]);

export const Database = /* @__PURE__ */ createLucideIcon("Database", [
  ["ellipse", { cx: "12", cy: "6.7", rx: "7.4", ry: "3.1", key: "0" }],
  [
    "path",
    {
      d: "M4.6 6.7v10.6c0 1.72 3.3 3.1 7.4 3.1s7.4-1.38 7.4-3.1V6.7M4.6 12c0 1.72 3.3 3.1 7.4 3.1s7.4-1.38 7.4-3.1",
      key: "1",
    },
  ],
]);

export const Download = /* @__PURE__ */ createLucideIcon("Download", [
  [
    "path",
    {
      d: "M12 4.5v10m-3.5-3.5 3.5 3.5 3.5-3.5M4.5 14v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14",
      key: "0",
    },
  ],
]);

export const Globe2 = /* @__PURE__ */ createLucideIcon("Earth", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "path",
    {
      d: "m6.6 5.5 3.2 1.65-.4 2.75-3.35 1.3-1.9-.65m5.45 9.55 1.2-3.1-1.95-2.8 1.75-2.05h3.65l1.45 2.15 3.65-1.25M13 3.6l.3 2.2 2.2 1.6 3.25-.1",
      strokeWidth: "1.65",
      key: "1",
    },
  ],
]);

export const MoreHorizontal = /* @__PURE__ */ createLucideIcon("Ellipsis", [
  [
    "circle",
    {
      cx: "6",
      cy: "12",
      r: "1.6",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "12",
      cy: "12",
      r: "1.6",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  [
    "circle",
    {
      cx: "18",
      cy: "12",
      r: "1.6",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const MoreVertical = /* @__PURE__ */ createLucideIcon(
  "EllipsisVertical",
  [
    [
      "circle",
      {
        cx: "12",
        cy: "6",
        r: "1.6",
        fill: "currentColor",
        stroke: "none",
        key: "0",
      },
    ],
    [
      "circle",
      {
        cx: "12",
        cy: "12",
        r: "1.6",
        fill: "currentColor",
        stroke: "none",
        key: "1",
      },
    ],
    [
      "circle",
      {
        cx: "12",
        cy: "18",
        r: "1.6",
        fill: "currentColor",
        stroke: "none",
        key: "2",
      },
    ],
  ],
);

export const ExternalLink = /* @__PURE__ */ createLucideIcon("ExternalLink", [
  [
    "path",
    {
      d: "M11 5H6.5a2 2 0 0 0-2 2v10.5a2 2 0 0 0 2 2H17a2 2 0 0 0 2-2V13m-6-8.5h6.5V11m0-6.5L10 14",
      key: "0",
    },
  ],
]);

export const Eye = /* @__PURE__ */ createLucideIcon("Eye", [
  [
    "path",
    {
      d: "M3 12c2.4-3.6 5.75-5.75 9-5.75s6.6 2.15 9 5.75c-2.4 3.6-5.75 5.75-9 5.75S5.4 15.6 3 12Z",
      key: "0",
    },
  ],
  ["circle", { cx: "12", cy: "12", r: "2.25", key: "1" }],
]);

export const EyeOff = /* @__PURE__ */ createLucideIcon("EyeOff", [
  [
    "path",
    {
      d: "M5 9.25c2.15-2 4.5-3 7-3 3.25 0 6.6 2.15 9 5.75-.65 1-1.4 1.9-2.15 2.65M16.15 16.95A10.7 10.7 0 0 1 12 17.75c-3.25 0-6.6-2.15-9-5.75l.4-.55",
      key: "0",
    },
  ],
  [
    "path",
    { d: "m4.75 4.75 14.5 14.5m-8.5-8.45a1.8 1.8 0 0 0 2.45 2.45", key: "1" },
  ],
]);

export const FileArchive = /* @__PURE__ */ createLucideIcon("FileArchive", [
  [
    "path",
    {
      d: "M7 3.5h6l4.5 4.5v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Zm6 0V8h4.5",
      key: "0",
    },
  ],
  ["path", { d: "M11.25 5.25v.75m0 2.5v.75m0 2.5v.75m0 2.5v.75", key: "1" }],
  [
    "rect",
    {
      x: "10",
      y: "17.15",
      width: "2.5",
      height: "1.2",
      rx: "0.45",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const FileCode2 = /* @__PURE__ */ createLucideIcon("FileCode2", [
  [
    "path",
    {
      d: "M7 3.5h6l4.5 4.5v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Zm6 0V8h4.5",
      key: "0",
    },
  ],
  ["path", { d: "m9.25 12-1.5 1.5 1.5 1.5m4-3 1.5 1.5-1.5 1.5", key: "1" }],
]);

export const FileDiff = /* @__PURE__ */ createLucideIcon("FileDiff", [
  [
    "path",
    {
      d: "M7 3.5h6l4.5 4.5v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Zm6 0V8h4.5",
      key: "0",
    },
  ],
  ["path", { d: "M11.2 10.7v4m-2-2h4m-2 4.75h2.25", key: "1" }],
]);

export const FileText = /* @__PURE__ */ createLucideIcon("FileText", [
  [
    "path",
    {
      d: "M7 3.5h6l4.5 4.5v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Zm6 0V8h4.5",
      key: "0",
    },
  ],
  ["path", { d: "M8.75 12.25h5m-5 3.75h5", key: "1" }],
]);

export const FileType = /* @__PURE__ */ createLucideIcon("FileType", [
  [
    "path",
    {
      d: "M7 3.5h6l4.5 4.5v10.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Zm6 0V8h4.5",
      key: "0",
    },
  ],
  ["path", { d: "M8.75 12h5.6m-2.8 0v5", key: "1" }],
]);

export const Files = /* @__PURE__ */ createLucideIcon("Files", [
  [
    "path",
    {
      d: "M8 3.75h6.3L19 8.5v10a1.75 1.75 0 0 1-1.75 1.75H8.5a2 2 0 0 1-2-2V5.5A1.75 1.75 0 0 1 8 3.75Zm6.1 0V8.6H19",
      key: "0",
    },
  ],
  ["path", { d: "M4.1 7.1v10.05c0 1.65.4 2.3 1.45 2.95", key: "1" }],
]);

export const Folder = /* @__PURE__ */ createLucideIcon("Folder", [
  [
    "path",
    {
      d: "M3.5 8.75v-2a2 2 0 0 1 2-2H10l2 2h6.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z",
      key: "0",
    },
  ],
  ["path", { d: "M3.5 10h17", key: "1" }],
]);

export const FolderGit2 = /* @__PURE__ */ createLucideIcon("FolderGit2", [
  [
    "path",
    {
      d: "M3.5 8.75v-2a2 2 0 0 1 2-2H10l2 2h6.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z",
      key: "0",
    },
  ],
  ["path", { d: "M3.5 10h17", key: "1" }],
  [
    "path",
    {
      d: "M10 12v4.25m0-1.6h2.8a1.75 1.75 0 0 0 1.75-1.75v-.5",
      strokeWidth: "1.6",
      key: "2",
    },
  ],
  [
    "circle",
    {
      cx: "10",
      cy: "12",
      r: "1.02",
      fill: "currentColor",
      stroke: "none",
      key: "3",
    },
  ],
  [
    "circle",
    {
      cx: "10",
      cy: "16.25",
      r: "1.02",
      fill: "currentColor",
      stroke: "none",
      key: "4",
    },
  ],
  [
    "circle",
    {
      cx: "14.55",
      cy: "12.4",
      r: "1.02",
      fill: "currentColor",
      stroke: "none",
      key: "5",
    },
  ],
]);

export const FolderOpen = /* @__PURE__ */ createLucideIcon("FolderOpen", [
  [
    "path",
    { d: "M4 17V6.75a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1.5", key: "0" },
  ],
  [
    "path",
    {
      d: "M4 17.6 6.1 12a2 2 0 0 1 1.9-1.3h11.15a1.5 1.5 0 0 1 1.4 2.04L18.6 18a2 2 0 0 1-1.9 1.3H5.2A1.3 1.3 0 0 1 4 17.6Z",
      fill: "currentColor",
      fillOpacity: ".08",
      key: "1",
    },
  ],
]);

export const FolderSearch = /* @__PURE__ */ createLucideIcon("FolderSearch", [
  [
    "path",
    {
      d: "M4.5 17.75a1.75 1.75 0 0 1-1-1.55V6.75a2 2 0 0 1 2-2H10l2 2h6.5a2 2 0 0 1 2 2v2.2M3.5 10h10",
      key: "0",
    },
  ],
  ["circle", { cx: "15", cy: "14.25", r: "3", key: "1" }],
  ["path", { d: "m17.2 16.45 2.85 2.85", key: "2" }],
]);

export const Gauge = /* @__PURE__ */ createLucideIcon("Gauge", [
  ["path", { d: "M5.5 18a8.5 8.5 0 1 1 13 0ZM12 14l3.5-3.5", key: "0" }],
  [
    "circle",
    {
      cx: "12",
      cy: "14",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
]);

export const Gem = /* @__PURE__ */ createLucideIcon("Gem", [
  [
    "path",
    {
      d: "M4 9.75 7.75 5h8.5L20 9.75l-8 9.6ZM4 9.75h16m-8-4.75-3.25 4.75L12 19.35l3.25-9.6Z",
      key: "0",
    },
  ],
]);

export const GitBranch = /* @__PURE__ */ createLucideIcon("GitBranch", [
  ["path", { d: "M6.5 9v6m0-2.15h5.75a4.25 4.25 0 0 0 4.25-4.25", key: "0" }],
  ["circle", { cx: "6.5", cy: "6.5", r: "2.1", key: "1" }],
  ["circle", { cx: "6.5", cy: "17.5", r: "2.1", key: "2" }],
  ["circle", { cx: "16.5", cy: "6.5", r: "2.1", key: "3" }],
]);

export const GitBranchPlus = /* @__PURE__ */ createLucideIcon("GitBranchPlus", [
  [
    "path",
    { d: "M6.2 8.5v6.9m0-1.6h5.45a3.95 3.95 0 0 0 3.95-3.95", key: "0" },
  ],
  ["circle", { cx: "6.2", cy: "6.45", r: "2", key: "1" }],
  ["circle", { cx: "6.2", cy: "17.45", r: "2", key: "2" }],
  ["path", { d: "M16 3.75v6.25m-3.125-3.125h6.25", key: "3" }],
]);

export const GitCommitHorizontal = /* @__PURE__ */ createLucideIcon(
  "GitCommitHorizontal",
  [
    ["path", { d: "M3.75 12H8m8 0h4.25", key: "0" }],
    ["circle", { cx: "12", cy: "12", r: "3.65", key: "1" }],
  ],
);

export const GitPullRequest = /* @__PURE__ */ createLucideIcon(
  "GitPullRequest",
  [
    [
      "path",
      { d: "M6.75 8.65v6.7m9.5 0v-4.6A4.75 4.75 0 0 0 11.5 6", key: "0" },
    ],
    ["circle", { cx: "6.75", cy: "6.5", r: "2.05", key: "1" }],
    ["circle", { cx: "6.75", cy: "17.5", r: "2.05", key: "2" }],
    ["circle", { cx: "16.25", cy: "17.5", r: "2.05", key: "3" }],
    ["path", { d: "m14 3.5-2.5 2.5L14 8.5", key: "4" }],
  ],
);

export const Globe = /* @__PURE__ */ createLucideIcon("Globe", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "path",
    { d: "M3.5 12h17M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17Z", key: "1" },
  ],
]);

export const Goal = /* @__PURE__ */ createLucideIcon("Goal", [
  [
    "path",
    {
      d: "M19.55 10.3a8 8 0 1 1-6-6m2.25 6.75A4.2 4.2 0 1 1 12.75 8M12 12l8-8m-3.85 0H20v3.85",
      key: "0",
    },
  ],
]);

export const GripVertical = /* @__PURE__ */ createLucideIcon("GripVertical", [
  [
    "circle",
    {
      cx: "9.5",
      cy: "7",
      r: "1.2",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "14.5",
      cy: "7",
      r: "1.2",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  [
    "circle",
    {
      cx: "9.5",
      cy: "12",
      r: "1.2",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
  [
    "circle",
    {
      cx: "14.5",
      cy: "12",
      r: "1.2",
      fill: "currentColor",
      stroke: "none",
      key: "3",
    },
  ],
  [
    "circle",
    {
      cx: "9.5",
      cy: "17",
      r: "1.2",
      fill: "currentColor",
      stroke: "none",
      key: "4",
    },
  ],
  [
    "circle",
    {
      cx: "14.5",
      cy: "17",
      r: "1.2",
      fill: "currentColor",
      stroke: "none",
      key: "5",
    },
  ],
]);

export const Hammer = /* @__PURE__ */ createLucideIcon("Hammer", [
  [
    "path",
    {
      d: "M13.4 8.25 10.7 5.55a4.5 4.5 0 0 1 5.6.55l3.7 3.7-3.15 3.15-1.75-1.75L7 19.3a1.55 1.55 0 1 1-2.2-2.2Zm0 0 1.7 2.95",
      key: "0",
    },
  ],
]);

export const Hand = /* @__PURE__ */ createLucideIcon("Hand", [
  [
    "path",
    {
      d: "M7.75 12V6.75a1.5 1.5 0 0 1 3 0v4.5-6a1.5 1.5 0 0 1 3 0V11 6.5a1.5 1.5 0 0 1 3 0v5-2.25a1.5 1.5 0 0 1 3 0v4.6c0 4.4-2.45 6.65-6.3 6.65-2.45 0-4.25-.95-5.85-2.85l-3-3.55a1.55 1.55 0 0 1 2.2-2.15l.95.85",
      strokeWidth: "1.65",
      key: "0",
    },
  ],
]);

export const HardDrive = /* @__PURE__ */ createLucideIcon("HardDrive", [
  [
    "path",
    {
      d: "m6.15 5.5-2.6 8v3.25A2.25 2.25 0 0 0 5.8 19h12.4a2.25 2.25 0 0 0 2.25-2.25V13.5l-2.6-8ZM3.55 13.5h16.9",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "7",
      cy: "16.25",
      r: "0.92",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  [
    "circle",
    {
      cx: "10.75",
      cy: "16.25",
      r: "0.92",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const Hash = /* @__PURE__ */ createLucideIcon("Hash", [
  [
    "path",
    { d: "M9.5 4.75 7 19.25m10-14.5-2.5 14.5M5 9h14M4 15h14", key: "0" },
  ],
]);

export const History = /* @__PURE__ */ createLucideIcon("History", [
  [
    "path",
    {
      d: "M4.5 11.5A7.5 7.5 0 1 1 6 16.65m-1.5-9v4.1h4.1M12 8v4l2.5 1.5",
      key: "0",
    },
  ],
]);

export const Image = /* @__PURE__ */ createLucideIcon("Image", [
  [
    "rect",
    { x: "3.5", y: "5", width: "17", height: "14", rx: "2.75", key: "0" },
  ],
  [
    "circle",
    {
      cx: "15.75",
      cy: "9",
      r: "1.3",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "m4 16 4.3-4.3a1.5 1.5 0 0 1 2.1 0l2.1 2.05 2.6-2.65a1.5 1.5 0 0 1 2.1 0l3.25 3.4",
      key: "2",
    },
  ],
]);

export const ImagePlus = /* @__PURE__ */ createLucideIcon("ImagePlus", [
  [
    "path",
    {
      d: "M14.5 5H6.25A2.75 2.75 0 0 0 3.5 7.75v8.5A2.75 2.75 0 0 0 6.25 19h11.5a2.75 2.75 0 0 0 2.75-2.75V12m-16.5 4 4.3-4.3a1.5 1.5 0 0 1 2.1 0l2.1 2.05 2.6-2.65m3.5-7.55v6m-3-3h6",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "13.25",
      cy: "8.25",
      r: "0.95",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
]);

export const Images = /* @__PURE__ */ createLucideIcon("Images", [
  ["path", { d: "M4.25 15.75V7.5a2 2 0 0 1 2-2h10.5", key: "0" }],
  [
    "rect",
    { x: "7", y: "8.25", width: "13.15", height: "10.75", rx: "2", key: "1" },
  ],
  ["path", { d: "m7.5 16.8 3.8-3.45 2.2 2.1 1.9-1.7 4.1 3.2", key: "2" }],
  [
    "circle",
    {
      cx: "16.75",
      cy: "11.5",
      r: "1.05",
      fill: "currentColor",
      stroke: "none",
      key: "3",
    },
  ],
]);

export const Info = /* @__PURE__ */ createLucideIcon("Info", [
  ["circle", { cx: "12", cy: "12", r: "8.5", key: "0" }],
  [
    "circle",
    {
      cx: "12",
      cy: "7.8",
      r: "1.18",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  ["path", { d: "M12 11.25v4.75", key: "2" }],
]);

export const KeyRound = /* @__PURE__ */ createLucideIcon("KeyRound", [
  ["circle", { cx: "8", cy: "9", r: "4.25", key: "0" }],
  ["path", { d: "m11.2 11.8 2.7 2.7h2.85v2.9h2.75v2.35", key: "1" }],
]);

export const Laptop = /* @__PURE__ */ createLucideIcon("Laptop", [
  [
    "rect",
    { x: "3.25", y: "4.5", width: "17.5", height: "13", rx: "2.8", key: "0" },
  ],
  [
    "path",
    {
      d: "M3.25 17.5 2.5 19.5a.75.75 0 0 0 .7 1h17.6a.75.75 0 0 0 .7-1l-.75-2M9.75 17.5h4.5",
      key: "1",
    },
  ],
]);

export const Layers = /* @__PURE__ */ createLucideIcon("Layers", [
  [
    "path",
    {
      d: "m12 4 8.5 4.5L12 13 3.5 8.5Zm-8.5 8.75L12 17.25l8.5-4.5m-17 4.25 8.5 4.5 8.5-4.5",
      key: "0",
    },
  ],
]);

export const LayoutPanelLeft = /* @__PURE__ */ createLucideIcon(
  "LayoutPanelLeft",
  [
    [
      "rect",
      { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "0" },
    ],
    ["path", { d: "M9 5v14m0-7h12", key: "1" }],
  ],
);

export const Lightbulb = /* @__PURE__ */ createLucideIcon("Lightbulb", [
  [
    "path",
    {
      d: "M9.2 16.2v-1.4a5.4 5.4 0 1 1 5.6 0v1.4Zm.6 3h4.4m-2.2-3v-4.75m-1.85-1.25L12 12.05l1.85-1.85",
      key: "0",
    },
  ],
]);

export const Link = /* @__PURE__ */ createLucideIcon("Link", [
  [
    "path",
    {
      d: "m9.6 14.4 4.8-4.8m-5.8 6.8-1.4 1.4a3.4 3.4 0 0 1-4.8-4.8l3.4-3.4a3.4 3.4 0 0 1 4.8 0m4.8-2 1.4-1.4a3.4 3.4 0 0 1 4.8 4.8l-3.4 3.4a3.4 3.4 0 0 1-4.8 0",
      key: "0",
    },
  ],
]);

export const ListChecks = /* @__PURE__ */ createLucideIcon("ListChecks", [
  [
    "path",
    {
      d: "m4 7 1.75 1.75L9 5.5M4 15.25 5.75 17 9 13.75m3-6h8m-8 8.25h8",
      key: "0",
    },
  ],
]);

export const Loader = /* @__PURE__ */ createLucideIcon("Loader", [
  [
    "path",
    { d: "M12 4v2.4", opacity: "1.00", transform: "rotate(0 12 12)", key: "0" },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.91",
      transform: "rotate(45 12 12)",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.82",
      transform: "rotate(90 12 12)",
      key: "2",
    },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.73",
      transform: "rotate(135 12 12)",
      key: "3",
    },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.64",
      transform: "rotate(180 12 12)",
      key: "4",
    },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.55",
      transform: "rotate(225 12 12)",
      key: "5",
    },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.46",
      transform: "rotate(270 12 12)",
      key: "6",
    },
  ],
  [
    "path",
    {
      d: "M12 4v2.4",
      opacity: "0.37",
      transform: "rotate(315 12 12)",
      key: "7",
    },
  ],
]);

export const LoaderCircle = /* @__PURE__ */ createLucideIcon("LoaderCircle", [
  ["path", { d: "M12 3.5a8.5 8.5 0 1 1-8.5 8.5", key: "0" }],
]);
export { LoaderCircle as Loader2 };

export const LockKeyhole = /* @__PURE__ */ createLucideIcon("LockKeyhole", [
  [
    "rect",
    { x: "5.5", y: "10", width: "13", height: "10", rx: "2.25", key: "0" },
  ],
  ["path", { d: "M8.25 10V7.75a3.75 3.75 0 0 1 7.5 0V10m-3.75 4v2", key: "1" }],
]);

export const Maximize2 = /* @__PURE__ */ createLucideIcon("Maximize2", [
  [
    "path",
    { d: "M14 5.5h4.5V10m0-4.5L14 10M10 18.5H5.5V14m0 4.5L10 14", key: "0" },
  ],
]);

export const MessageCircle = /* @__PURE__ */ createLucideIcon("MessageCircle", [
  [
    "path",
    {
      d: "M20.5 11.75a8.5 8.5 0 0 1-11.96 7.77L4 20.5l.98-4.54a8.5 8.5 0 1 1 15.52-4.21Z",
      key: "0",
    },
  ],
]);

export const MessageCirclePlus = /* @__PURE__ */ createLucideIcon(
  "MessageCirclePlus",
  [
    [
      "path",
      {
        d: "M20.5 11.75a8.5 8.5 0 0 1-11.96 7.77L4 20.5l.98-4.54a8.5 8.5 0 1 1 15.52-4.21Z",
        key: "0",
      },
    ],
    [
      "path",
      {
        d: "M12 6v12M6 12h12",
        transform: "translate(5 5) scale(.55)",
        key: "1",
      },
    ],
  ],
);

export const MessageCircleQuestion = /* @__PURE__ */ createLucideIcon(
  "MessageCircleQuestion",
  [
    [
      "path",
      {
        d: "M20.5 11.75a8.5 8.5 0 0 1-11.96 7.77L4 20.5l.98-4.54a8.5 8.5 0 1 1 15.52-4.21Z",
        key: "0",
      },
    ],
    [
      "path",
      {
        d: "M9.8 9.65a2.3 2.3 0 0 1 4.45.75c0 1.65-2.25 1.8-2.25 3.25",
        key: "1",
      },
    ],
    [
      "circle",
      {
        cx: "12",
        cy: "16.25",
        r: "1",
        fill: "currentColor",
        stroke: "none",
        key: "2",
      },
    ],
  ],
);

export const MessageSquare = /* @__PURE__ */ createLucideIcon("MessageSquare", [
  [
    "path",
    {
      d: "M6 5h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-7l-4.5 3v-3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z",
      key: "0",
    },
  ],
]);

export const Mic = /* @__PURE__ */ createLucideIcon("Mic", [
  ["rect", { x: "9", y: "3.5", width: "6", height: "11", rx: "3", key: "0" }],
  ["path", { d: "M6 11.5a6 6 0 0 0 12 0m-6 6v3m-2.75 0h5.5", key: "1" }],
]);

export const Minimize2 = /* @__PURE__ */ createLucideIcon("Minimize2", [
  [
    "path",
    {
      d: "M18.5 10H14V5.5m0 4.5 4.5-4.5M5.5 14H10v4.5M10 14l-4.5 4.5",
      key: "0",
    },
  ],
]);

export const Minus = /* @__PURE__ */ createLucideIcon("Minus", [
  ["path", { d: "M6 12h12", key: "0" }],
]);

export const Monitor = /* @__PURE__ */ createLucideIcon("Monitor", [
  ["rect", { x: "3", y: "5", width: "18", height: "12", rx: "2.75", key: "0" }],
  ["path", { d: "M12 17v3m-4.5 0h9", key: "1" }],
]);

export const Music2 = /* @__PURE__ */ createLucideIcon("Music2", [
  ["path", { d: "M9.5 16.25V6.35l8.5-1.8v9.85m-8.5-4.4L18 8.25", key: "0" }],
  [
    "ellipse",
    {
      cx: "7",
      cy: "17.3",
      rx: "2.55",
      ry: "1.8",
      fill: "currentColor",
      key: "1",
    },
  ],
  [
    "ellipse",
    {
      cx: "15.5",
      cy: "15.1",
      rx: "2.55",
      ry: "1.8",
      fill: "currentColor",
      key: "2",
    },
  ],
]);

export const Network = /* @__PURE__ */ createLucideIcon("Network", [
  [
    "rect",
    { x: "9.25", y: "4", width: "5.5", height: "4.25", rx: "1.15", key: "0" },
  ],
  [
    "rect",
    {
      x: "3.25",
      y: "15.5",
      width: "5.5",
      height: "4.25",
      rx: "1.15",
      key: "1",
    },
  ],
  [
    "rect",
    {
      x: "15.25",
      y: "15.5",
      width: "5.5",
      height: "4.25",
      rx: "1.15",
      key: "2",
    },
  ],
  ["path", { d: "M12 8.25v3.5m-6 3.75v-3.75h12v3.75", key: "3" }],
]);

export const Palette = /* @__PURE__ */ createLucideIcon("Palette", [
  [
    "path",
    {
      d: "M12.3 20.5A8.5 8.5 0 1 1 20.5 12a3 3 0 0 1-3 3H15a1.95 1.95 0 0 0-1.55 3.15A1.45 1.45 0 0 1 12.3 20.5Z",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "7",
      cy: "11",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  [
    "circle",
    {
      cx: "9.8",
      cy: "7.6",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
  [
    "circle",
    {
      cx: "14.1",
      cy: "7.6",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "3",
    },
  ],
  [
    "circle",
    {
      cx: "17",
      cy: "10.65",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "4",
    },
  ],
]);

export const PanelBottom = /* @__PURE__ */ createLucideIcon("PanelBottom", [
  [
    "path",
    {
      d: "M3 14h18v2.25A2.75 2.75 0 0 1 18.25 19H5.75A2.75 2.75 0 0 1 3 16.25Z",
      fill: "currentColor",
      fillOpacity: ".18",
      stroke: "none",
      key: "0",
    },
  ],
  ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "1" }],
  ["path", { d: "M3 14h18", key: "2" }],
  ["path", { d: "m10 8.5 2 2 2-2", key: "3" }],
]);

export const PanelLeft = /* @__PURE__ */ createLucideIcon("PanelLeft", [
  [
    "path",
    {
      d: "M9 5v14H5.75A2.75 2.75 0 0 1 3 16.25v-8.5A2.75 2.75 0 0 1 5.75 5Z",
      fill: "currentColor",
      fillOpacity: ".18",
      stroke: "none",
      key: "0",
    },
  ],
  ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "1" }],
  ["path", { d: "M9 5v14", key: "2" }],
  ["path", { d: "m16 9.5-2.5 2.5 2.5 2.5", key: "3" }],
]);

export const PanelRight = /* @__PURE__ */ createLucideIcon("PanelRight", [
  [
    "path",
    {
      d: "M9 5v14H5.75A2.75 2.75 0 0 1 3 16.25v-8.5A2.75 2.75 0 0 1 5.75 5Z",
      fill: "currentColor",
      fillOpacity: ".18",
      stroke: "none",
      transform: "translate(24 0) scale(-1 1)",
      key: "0",
    },
  ],
  [
    "rect",
    {
      x: "3",
      y: "5",
      width: "18",
      height: "14",
      rx: "2.75",
      transform: "translate(24 0) scale(-1 1)",
      key: "1",
    },
  ],
  [
    "path",
    { d: "M9 5v14", transform: "translate(24 0) scale(-1 1)", key: "2" },
  ],
  [
    "path",
    {
      d: "m16 9.5-2.5 2.5 2.5 2.5",
      transform: "translate(24 0) scale(-1 1)",
      key: "3",
    },
  ],
]);

export const Paperclip = /* @__PURE__ */ createLucideIcon("Paperclip", [
  [
    "path",
    {
      d: "m9.5 14.4 5.4-5.4a1.7 1.7 0 1 1 2.4 2.4l-6.6 6.6a3.5 3.5 0 1 1-5-5l7.05-7.05a4.5 4.5 0 0 1 6.36 6.36l-5.3 5.3",
      key: "0",
    },
  ],
]);

export const Pause = /* @__PURE__ */ createLucideIcon("Pause", [
  [
    "rect",
    {
      x: "7",
      y: "5.75",
      width: "3.5",
      height: "12.5",
      rx: "1",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
  [
    "rect",
    {
      x: "13.5",
      y: "5.75",
      width: "3.5",
      height: "12.5",
      rx: "1",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
]);

export const Edit3 = /* @__PURE__ */ createLucideIcon("PenLine", [
  ["path", { d: "m5 16 10-10 3 3L8 19H5Zm8.5-8.5 3 3", key: "0" }],
  ["path", { d: "M11.5 19h7", key: "1" }],
]);

export const Pencil = /* @__PURE__ */ createLucideIcon("Pencil", [
  ["path", { d: "m5 16 10-10 3 3L8 19H5Zm8.5-8.5 3 3", key: "0" }],
]);

export const Pin = /* @__PURE__ */ createLucideIcon("Pin", [
  [
    "path",
    {
      d: "M9 4.5h6l-.65 5.25 2.65 2.5v1.5H7v-1.5l2.65-2.5Zm3 9.25v5.75",
      key: "0",
    },
  ],
]);

export const Play = /* @__PURE__ */ createLucideIcon("Play", [
  [
    "path",
    {
      d: "M9 6.25a.9.9 0 0 0-1.4.75v10a.9.9 0 0 0 1.4.75l7.75-5a.9.9 0 0 0 0-1.5Z",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
]);

export const PlugZap = /* @__PURE__ */ createLucideIcon("PlugZap", [
  [
    "path",
    {
      d: "M6.85 8.3v3.1m3.8-3.1v3.1m-5.9 0h8v2a4 4 0 0 1-8 0Zm4 6v2.6",
      transform: "rotate(45 9 14)",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "m18.15 3.5-4.2 4.8H17l-.65 4.45 4.25-5h-3.1Z",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
]);

export const Plus = /* @__PURE__ */ createLucideIcon("Plus", [
  ["path", { d: "M12 6v12M6 12h12", key: "0" }],
]);

export const RefreshCw = /* @__PURE__ */ createLucideIcon("RefreshCw", [
  [
    "path",
    {
      d: "M4.25 10a8 8 0 0 1 13.35-3.9L20 8.5m0-4.25V8.5h-4.25M19.75 14A8 8 0 0 1 6.4 17.9L4 15.5m0 4.25V15.5h4.25",
      key: "0",
    },
  ],
]);

export const RotateCcw = /* @__PURE__ */ createLucideIcon("RotateCcw", [
  [
    "path",
    {
      d: "M19.5 10a7.7 7.7 0 1 0-.7 6.5m.7-10v4.25h-4.25",
      transform: "translate(24 0) scale(-1 1)",
      key: "0",
    },
  ],
]);

export const RotateCw = /* @__PURE__ */ createLucideIcon("RotateCw", [
  ["path", { d: "M19.5 10a7.7 7.7 0 1 0-.7 6.5m.7-10v4.25h-4.25", key: "0" }],
]);

export const ScanLine = /* @__PURE__ */ createLucideIcon("ScanLine", [
  ["path", { d: "M6 10V6h4m4 0h4v4m0 4v4h-4m-4 0H6v-4", key: "0" }],
  ["path", { d: "M4 12h16", key: "1" }],
]);

export const ScrollText = /* @__PURE__ */ createLucideIcon("ScrollText", [
  [
    "path",
    {
      d: "M5.75 4.5h10.5a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5H9.7a2.5 2.5 0 0 1-2.5-2.5v-.45h9.05M7.2 7a2.45 2.45 0 0 0-4.9 0v1.65h4.9V7Zm3 1.65h5m-5 3.6h5",
      key: "0",
    },
  ],
]);

export const Search = /* @__PURE__ */ createLucideIcon("Search", [
  ["circle", { cx: "10.5", cy: "10.5", r: "5.5", key: "0" }],
  ["path", { d: "m15 15 4.5 4.5", key: "1" }],
]);

export const Send = /* @__PURE__ */ createLucideIcon("Send", [
  [
    "path",
    {
      d: "m3.75 9.5 16.5-5.75L14.5 20.25l-3.2-7.55ZM20.25 3.75 11.3 12.7",
      key: "0",
    },
  ],
]);

export const Settings = /* @__PURE__ */ createLucideIcon("Settings", [
  [
    "path",
    {
      d: "M10 3.5h4l.55 2.55 1.45.85 2.5-.85 2 3.4-1.95 1.75v1.6l1.95 1.75-2 3.4-2.5-.85-1.45.85L14 20.5h-4l-.55-2.55-1.45-.85-2.5.85-2-3.4 1.95-1.75v-1.6L3.5 9.45l2-3.4 2.5.85 1.45-.85Z",
      strokeWidth: "1.78",
      key: "0",
    },
  ],
  ["circle", { cx: "12", cy: "12", r: "2.55", key: "1" }],
]);

export const Settings2 = /* @__PURE__ */ createLucideIcon("Settings2", [
  [
    "path",
    { d: "M4 8h6.5m0-2.6v5.2m0-2.6H20M4 16h9.5m0-2.6v5.2m0-2.6H20", key: "0" },
  ],
]);

export const ShieldAlert = /* @__PURE__ */ createLucideIcon("ShieldAlert", [
  [
    "path",
    {
      d: "m12 3.5 7 2.75v5.25c0 4.25-2.4 7.4-7 9.25-4.6-1.85-7-5-7-9.25V6.25Z",
      key: "0",
    },
  ],
  ["path", { d: "M12 8v4", key: "1" }],
  [
    "circle",
    {
      cx: "12",
      cy: "15.25",
      r: "1",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const ShieldCheck = /* @__PURE__ */ createLucideIcon("ShieldCheck", [
  [
    "path",
    {
      d: "m12 3.5 7 2.75v5.25c0 4.25-2.4 7.4-7 9.25-4.6-1.85-7-5-7-9.25V6.25Z",
      key: "0",
    },
  ],
  ["path", { d: "m8.85 12 2.15 2.15 4.2-4.2", key: "1" }],
]);

export const ShieldQuestion = /* @__PURE__ */ createLucideIcon(
  "ShieldQuestion",
  [
    [
      "path",
      {
        d: "m12 3.5 7 2.75v5.25c0 4.25-2.4 7.4-7 9.25-4.6-1.85-7-5-7-9.25V6.25Z",
        key: "0",
      },
    ],
    [
      "path",
      {
        d: "M9.8 9.65a2.3 2.3 0 0 1 4.45.75c0 1.65-2.25 1.8-2.25 3.25",
        key: "1",
      },
    ],
    [
      "circle",
      {
        cx: "12",
        cy: "16.25",
        r: "1",
        fill: "currentColor",
        stroke: "none",
        key: "2",
      },
    ],
  ],
);

export const SlidersHorizontal = /* @__PURE__ */ createLucideIcon(
  "SlidersHorizontal",
  [
    ["path", { d: "M4.5 7.5h4.25m3.5 0h7.25m-15 9h7.25m3.5 0h4.25", key: "0" }],
    ["circle", { cx: "10.5", cy: "7.5", r: "1.75", key: "1" }],
    ["circle", { cx: "13.5", cy: "16.5", r: "1.75", key: "2" }],
  ],
);

export const Smartphone = /* @__PURE__ */ createLucideIcon("Smartphone", [
  [
    "rect",
    { x: "7.25", y: "3", width: "9.5", height: "18", rx: "2.5", key: "0" },
  ],
  ["path", { d: "M11 17.5h2", key: "1" }],
]);

export const Sparkles = /* @__PURE__ */ createLucideIcon("Sparkles", [
  [
    "path",
    {
      d: "M9.75 6.7q1.7 5.1 6.8 6.8q-5.1 1.7 -6.8 6.8q-1.7 -5.1 -6.8 -6.8q5.1 -1.7 6.8 -6.8Z",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M17.75 3.5q0.8125 2.4375 3.25 3.25q-2.4375 0.8125 -3.25 3.25q-0.8125 -2.4375 -3.25 -3.25q2.4375 -0.8125 3.25 -3.25Z",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
  [
    "circle",
    {
      cx: "18.25",
      cy: "16.25",
      r: "1",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);

export const Square = /* @__PURE__ */ createLucideIcon("Square", [
  [
    "rect",
    {
      x: "5.5",
      y: "5.5",
      width: "13",
      height: "13",
      rx: "2.2",
      fill: "currentColor",
      stroke: "none",
      key: "0",
    },
  ],
]);

export const SquarePen = /* @__PURE__ */ createLucideIcon("SquarePen", [
  [
    "path",
    {
      d: "M12 5H7.25A2.25 2.25 0 0 0 5 7.25v9.5A2.25 2.25 0 0 0 7.25 19h9.5A2.25 2.25 0 0 0 19 16.75V12m-9 2v-2.5l6.75-6.75 2.5 2.5L12.5 14Z",
      key: "0",
    },
  ],
]);

export const SquareTerminal = /* @__PURE__ */ createLucideIcon(
  "SquareTerminal",
  [
    [
      "rect",
      { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "0" },
    ],
    [
      "path",
      {
        d: "m5.75 8.5 3.5 3.5-3.5 3.5m6.75 0h5.75",
        transform: "translate(2.16 2.16) scale(.82)",
        key: "1",
      },
    ],
  ],
);

export const Table2 = /* @__PURE__ */ createLucideIcon("Table2", [
  [
    "rect",
    { x: "3.5", y: "5", width: "17", height: "14", rx: "2.75", key: "0" },
  ],
  [
    "path",
    {
      d: "M3.5 10h17M3.5 14.5h17M10 10v9m5-9v9",
      strokeWidth: "1.55",
      key: "1",
    },
  ],
]);

export const Tablet = /* @__PURE__ */ createLucideIcon("Tablet", [
  [
    "rect",
    {
      x: "5.75",
      y: "3.75",
      width: "12.5",
      height: "16.5",
      rx: "2.75",
      key: "0",
    },
  ],
  ["path", { d: "M11 17.15h2", key: "1" }],
]);

export const Tag = /* @__PURE__ */ createLucideIcon("Tag", [
  [
    "path",
    {
      d: "M4.25 5.75A1.5 1.5 0 0 1 5.75 4.25h5.9l7.75 7.75a2 2 0 0 1 0 2.8l-4.6 4.6a2 2 0 0 1-2.8 0l-7.75-7.75Z",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "8.25",
      cy: "8.25",
      r: "1.3",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
]);

export const Terminal = /* @__PURE__ */ createLucideIcon("Terminal", [
  ["path", { d: "m5.75 8.5 3.5 3.5-3.5 3.5m6.75 0h5.75", key: "0" }],
]);

export const Trash2 = /* @__PURE__ */ createLucideIcon("Trash2", [
  [
    "path",
    {
      d: "M4.75 7.25h14.5M9 7.25V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.75m2.75 0-.8 11A1.85 1.85 0 0 1 15.1 20h-6.2a1.85 1.85 0 0 1-1.85-1.75l-.8-11M10 11v5.5m4-5.5v5.5",
      key: "0",
    },
  ],
]);

export const TriangleAlert = /* @__PURE__ */ createLucideIcon("TriangleAlert", [
  [
    "path",
    {
      d: "M10.45 5.35a1.8 1.8 0 0 1 3.1 0l6.85 11.9a1.8 1.8 0 0 1-1.55 2.7H5.15a1.8 1.8 0 0 1-1.55-2.7Z",
      key: "0",
    },
  ],
  ["path", { d: "M12 9.25v4", key: "1" }],
  [
    "circle",
    {
      cx: "12",
      cy: "16.3",
      r: "1.05",
      fill: "currentColor",
      stroke: "none",
      key: "2",
    },
  ],
]);
export { TriangleAlert as AlertTriangle };

export const UserRound = /* @__PURE__ */ createLucideIcon("UserRound", [
  ["circle", { cx: "12", cy: "8.4", r: "3.05", key: "0" }],
  [
    "path",
    { d: "M5.5 19c.7-3.45 3.05-5.25 6.5-5.25s5.8 1.8 6.5 5.25", key: "1" },
  ],
]);

export const Users = /* @__PURE__ */ createLucideIcon("Users", [
  ["circle", { cx: "9", cy: "8.25", r: "2.8", key: "0" }],
  [
    "path",
    {
      d: "M3.8 19c.65-3.2 2.45-4.85 5.2-4.85s4.55 1.65 5.2 4.85m1.5-13.3a2.8 2.8 0 0 1 0 5.4m1 3.25c2 .55 3.15 2.1 3.5 4.6",
      key: "1",
    },
  ],
]);

export const Video = /* @__PURE__ */ createLucideIcon("Video", [
  [
    "rect",
    { x: "3.5", y: "6.5", width: "11.75", height: "11", rx: "2.5", key: "0" },
  ],
  ["path", { d: "m15.25 10 5.25-2v8l-5.25-2", key: "1" }],
]);

export const WifiOff = /* @__PURE__ */ createLucideIcon("WifiOff", [
  [
    "path",
    {
      d: "M3.5 9.1c1.15-.9 2.34-1.55 3.55-1.99m3.65-.84A13.8 13.8 0 0 1 20.5 9.1M6.25 12.3a9 9 0 0 1 3.9-1.7m4.15.15a9 9 0 0 1 3.45 1.55M9 15.5a5 5 0 0 1 4.25-.8M4.75 4.75l14.5 14.5",
      key: "0",
    },
  ],
  [
    "circle",
    {
      cx: "12",
      cy: "18.35",
      r: "1.15",
      fill: "currentColor",
      stroke: "none",
      key: "1",
    },
  ],
]);

export const Workflow = /* @__PURE__ */ createLucideIcon("Workflow", [
  ["rect", { x: "3.75", y: "5", width: "6", height: "5", rx: "1.3", key: "0" }],
  [
    "rect",
    { x: "14.25", y: "5", width: "6", height: "5", rx: "1.3", key: "1" },
  ],
  [
    "rect",
    { x: "14.25", y: "14", width: "6", height: "5", rx: "1.3", key: "2" },
  ],
  [
    "path",
    {
      d: "M9.75 7.5h4.5m-7.5 2.5v4.25a2.25 2.25 0 0 0 2.25 2.25h5.25",
      key: "3",
    },
  ],
]);

export const WrapText = /* @__PURE__ */ createLucideIcon("WrapText", [
  [
    "path",
    {
      d: "M4 5.5h16M4 10.75h13.25a2.75 2.75 0 1 1 0 5.5H10m2.25-2.25L10 16.25l2.25 2.25M4 16.25h2",
      key: "0",
    },
  ],
]);

export const Wrench = /* @__PURE__ */ createLucideIcon("Wrench", [
  [
    "path",
    {
      d: "M13.75 5.6a5.1 5.1 0 0 1 6.05-.95L16.7 7.75l.55 1.75 1.75.55 3.1-3.1a5.15 5.15 0 0 1-6.4 6.55l-7.1 6.75a2.15 2.15 0 1 1-3-3.05l6.8-7.05a5.1 5.1 0 0 1 1.35-4.55Z",
      transform: "translate(-.5 .2) scale(.97)",
      key: "0",
    },
  ],
]);

export const X = /* @__PURE__ */ createLucideIcon("X", [
  ["path", { d: "m7 7 10 10M17 7 7 17", key: "0" }],
]);

export const Zap = /* @__PURE__ */ createLucideIcon("Zap", [
  ["path", { d: "m13.25 3.5-8 10h5.5l-.5 7 8.5-10.5h-5.5Z", key: "0" }],
]);

export const PanelLeftClosed = /* @__PURE__ */ createLucideIcon(
  "PanelLeftClosed",
  [
    [
      "rect",
      { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "0" },
    ],
    ["path", { d: "M9 5v14", key: "1" }],
    ["path", { d: "m13.5 9.5 2.5 2.5-2.5 2.5", key: "2" }],
  ],
);

export const PanelRightClosed = /* @__PURE__ */ createLucideIcon(
  "PanelRightClosed",
  [
    [
      "rect",
      {
        x: "3",
        y: "5",
        width: "18",
        height: "14",
        rx: "2.75",
        transform: "translate(24 0) scale(-1 1)",
        key: "0",
      },
    ],
    [
      "path",
      { d: "M9 5v14", transform: "translate(24 0) scale(-1 1)", key: "1" },
    ],
    [
      "path",
      {
        d: "m13.5 9.5 2.5 2.5-2.5 2.5",
        transform: "translate(24 0) scale(-1 1)",
        key: "2",
      },
    ],
  ],
);

export const PanelBottomClosed = /* @__PURE__ */ createLucideIcon(
  "PanelBottomClosed",
  [
    [
      "rect",
      { x: "3", y: "5", width: "18", height: "14", rx: "2.75", key: "0" },
    ],
    ["path", { d: "M3 14h18", key: "1" }],
    ["path", { d: "m10 10.5 2-2 2 2", key: "2" }],
  ],
);

export const AutoApproveIcon = /* @__PURE__ */ createLucideIcon("AutoApprove", [
  [
    "path",
    {
      d: "m12 3.5 7 2.75v5.25c0 4.25-2.4 7.4-7 9.25-4.6-1.85-7-5-7-9.25V6.25Z",
      key: "0",
    },
  ],
  ["path", { d: "m8.5 10 2.4 2.4-2.4 2.4m4.4 0h2.7", key: "1" }],
]);

export const ChatSwitcherIcon = /* @__PURE__ */ createLucideIcon(
  "ChatSwitcher",
  [["path", { d: "M5 8.25h14M5 12h10M5 15.75h5.5", key: "0" }]],
);

export const ComposerSendIcon = /* @__PURE__ */ createLucideIcon(
  "ComposerSend",
  [["path", { d: "M12 18.5V5.5m-5.5 5.5L12 5.5l5.5 5.5", key: "0" }]],
);
