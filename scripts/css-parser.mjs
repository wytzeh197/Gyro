import { createRequire } from "node:module";

// Use the same PostCSS installation as the desktop's Vite toolchain. No new
// runtime dependency or network install is needed for repository CSS tools.
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const viteRequire = createRequire(desktopRequire.resolve("vite/package.json"));
export const postcss = viteRequire("postcss");
