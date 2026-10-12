import react from "@vitejs/plugin-react-swc";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

function textMateNotices(): Plugin {
  const root = new URL("./src/editor/textmate/", import.meta.url);
  return {
    name: "gyro-textmate-notices",
    apply: "build",
    generateBundle() {
      const licenses = readdirSync(new URL("licenses/", root), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) => `licenses/${entry.name}`)
        .sort();
      for (const file of ["manifest.json", "README.md", ...licenses]) {
        const source = new URL(file, root);
        this.addWatchFile(fileURLToPath(source));
        this.emitFile({
          type: "asset",
          fileName: `third-party/textmate/${file}`,
          source: readFileSync(source),
        });
      }
    },
  };
}

// App.tsx and packages/ui surfaces.tsx are each >500KB. Babel
// (@vitejs/plugin-react) deoptimizes those and can serialize the dev server
// for minutes — WebView stays blank white. SWC transforms them in seconds.
export default defineConfig(({ mode }) => ({
  clearScreen: false,
  plugins: [react(), textMateNotices()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/early-shell.tsx",
        "./src/early-shell.css",
        "./src/App.tsx",
        "../../packages/ui/src/index.ts",
        "../../packages/ui/src/surfaces.tsx",
        "../../packages/ui/src/styles.css",
      ],
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
    ],
  },
  // A native drag build embeds a disposable production-component fixture.
  ...(mode === "native-chat-drag-smoke"
    ? {
        build: {
          outDir: process.env.GYRO_NATIVE_CHAT_DRAG_FRONTEND_DIR,
          rollupOptions: {
            input: "chat-drag-preview.html",
          },
        },
      }
    : {}),
  // QA entrypoints are embedded only by the explicit native acceptance build.
  ...(mode === "native-syntax-smoke"
    ? {
        build: {
          rollupOptions: {
            input: ["index.html", "workspace-syntax-native-smoke.html"],
          },
        },
      }
    : {}),
}));
