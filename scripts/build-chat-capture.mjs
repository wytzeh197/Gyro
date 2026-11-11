import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { build, preview } = await import(
  pathToFileURL(require.resolve("vite")).href
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const directory = resolve(
  root,
  argument("--out") ?? "artifacts/chat-consolidation/production-before",
);
await build({
  root: resolve(root, "apps/desktop"),
  configFile: resolve(root, "apps/desktop/vite.config.ts"),
  logLevel: "warn",
  mode: "chat-render-smoke",
  build: {
    outDir: directory,
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, "apps/desktop/capture.html") },
  },
});
console.log(`Built production capture at ${directory}`);
if (argument("--serve")) {
  const server = await preview({
    root: resolve(root, "apps/desktop"),
    configFile: false,
    build: { outDir: directory },
    preview: {
      host: "127.0.0.1",
      port: Number(argument("--serve")),
      strictPort: true,
    },
  });
  server.printUrls();
}
