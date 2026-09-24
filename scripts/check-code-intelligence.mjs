import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const capabilities = await read("crates/gyro-core/src/capabilities.rs");
const lib = await read("apps/desktop/src-tauri/src/lib.rs");
const lsp = await read("apps/desktop/src-tauri/src/lsp_capability.rs");
const languageServer = await read("apps/desktop/src-tauri/src/language_server.rs");
const smoke = await read("apps/desktop/src-tauri/src/lsp_smoke.rs");
const types = await read("packages/ui/src/types.ts");
const chatRun = await read("packages/ui/src/chat-run.ts");
const catalog = await read("packages/ui/src/provider-catalog.ts");

const tools = [
  ["CodeDefinition", "code.definition", "gyro_code_definition"],
  ["CodeReferences", "code.references", "gyro_code_references"],
  ["CodeHover", "code.hover", "gyro_code_hover"],
  ["CodeSymbols", "code.symbols", "gyro_code_symbols"],
];

for (const [variant, id, tool] of tools) {
  assert.ok(
    capabilities.includes(`    ${variant},`),
    `${variant} is missing from CapabilityId`,
  );
  assert.ok(capabilities.includes(`"${id}"`), `${id} is missing from as_str`);
  assert.ok(
    capabilities.includes(`"${tool}"`),
    `${tool} is missing from provider_tool_name`,
  );
  // The descriptors must exist, and stay inspection-class so Plan mode can
  // advertise them.
  const descriptor = capabilities.match(
    new RegExp(`id: CapabilityId::${variant},[\\s\\S]{0,240}?description:`),
  )?.[0];
  assert.ok(descriptor, `${variant} has no descriptor`);
  assert.ok(
    descriptor.includes("CapabilityClass::WorkspaceInspect"),
    `${variant} must stay WorkspaceInspect`,
  );
}

// lib.rs keeps delegation only: one dispatcher arm, one schema guard, one
// module, and the same sensitive-path upgrade workspace reads get.
assert.ok(lib.includes("mod lsp_capability;"), "lsp_capability module not declared");
assert.ok(
  lib.includes("| CapabilityId::CodeSymbols => lsp_capability::execute(app, bound, request)?"),
  "dispatcher arm for the code capabilities is missing",
);
assert.ok(lib.includes("lsp_capability::schema(id)"), "schema delegation is missing");
assert.match(
  lib,
  /CapabilityId::WorkspaceRead\s*\n\s*\| CapabilityId::WorkspaceReadRange\s*\n\s*\| CapabilityId::WorkspaceReadEditor\s*\n\s*\| CapabilityId::CodeDefinition/,
  "code capabilities must join the sensitive-path upgrade",
);
assert.ok(lib.includes("mod lsp_smoke;"), "lsp_smoke module not declared");
assert.ok(
  lib.includes("if lsp_smoke::start(app.handle())?"),
  "the native LSP smoke harness is not wired",
);

// The capability module owns the observation envelope and the honest
// indexing outcome.
assert.ok(lsp.includes('"gyro.code-observation.v1"'), "observation schema missing");
assert.ok(lsp.includes('"indexing"'), "indexing outcome missing");
assert.ok(lsp.includes("retryAfterMs"), "retryAfterMs missing");
assert.ok(
  lsp.includes("pub(super) fn schema(id: CapabilityId)"),
  "lsp_capability must own its schemas",
);

// The language-server module owns the registry, the document lifecycle, and
// the file-request entry point.
assert.ok(languageServer.includes("pub fn language_server_for_path"));
assert.ok(languageServer.includes("LANGUAGE_SERVER_BY_SUFFIX"));
assert.ok(languageServer.includes("textDocument/didOpen"));
assert.ok(languageServer.includes("textDocument/didClose"));
assert.ok(smoke.includes("GYRO_LSP_SMOKE"), "smoke harness not gated on its env var");
assert.ok(smoke.includes("lsp-smoke.json"), "smoke harness writes no report");

// Renderer parity: union member, human label, activity beat, tool chip.
for (const id of [
  "code-definition",
  "code-references",
  "code-hover",
  "code-symbols",
]) {
  assert.ok(
    types.includes(`"${id}"`),
    `${id} is missing from the renderer CapabilityId union`,
  );
}
// The labels and the tool mapping are executed from the shipped
// implementations rather than pattern-matched: a refactor that keeps the
// strings but drops the behaviour cannot pass.
function executeFunction(source, fileName, functionName, argument) {
  const ast = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let declaration;
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.getText(ast) === functionName
    ) {
      declaration ??= node.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(declaration, `${fileName} no longer declares ${functionName}`);
  const code = ts.transpileModule(
    `${declaration}; globalThis.run = ${functionName};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  const context = {};
  vm.runInNewContext(code, context);
  return context.run(argument);
}
for (const [id, label] of [
  ["code-definition", "Go to definition"],
  ["code-references", "Find references"],
  ["code-hover", "Hover info"],
  ["code-symbols", "File symbols"],
]) {
  assert.equal(
    executeFunction(chatRun, "chat-run.ts", "humanizeCapabilityId", id),
    label,
    `chat-run.ts no longer labels ${id} "${label}"`,
  );
}
assert.ok(
  chatRun.includes('capabilityId.startsWith("code-")'),
  "code capabilities have no activity beat",
);
assert.deepEqual(
  [
    ...executeFunction(
      catalog,
      "provider-catalog.ts",
      "allowedToolsFromCapabilityIds",
      ["code-definition", "code-symbols"],
    ),
  ],
  ["files"],
  "code capabilities do not map to the files tool",
);

console.log("code intelligence checks passed");
