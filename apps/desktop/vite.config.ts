import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

// App.tsx and packages/ui surfaces.tsx are each >500KB. Babel
// (@vitejs/plugin-react) deoptimizes those and can serialize the dev server
// for minutes — WebView stays blank white. SWC transforms them in seconds.
export default defineConfig({
  clearScreen: false,
  plugins: [react()],
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
});
