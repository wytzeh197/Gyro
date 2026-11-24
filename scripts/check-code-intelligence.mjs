import { capabilityLabel } from "../packages/ui/src/capability-ui.ts";
import { readFile } from "./read-product-source.mjs";
import assert from "node:assert/strict";

import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const capabilities = await read("crates/gyro-core/src/capabilities.rs");
const lib = (
  await Promise.all(
    [
      "lib.rs",
      "app/setup.rs",
      "capabilities/execute.rs",
      "capabilities/access.rs",
      "capabilities/mcp_server.rs",
    ].map((path) => read(`apps/desktop/src-tauri/src/${path}`)),
  )
).join("\n");
const lsp = await read("apps/desktop/src-tauri/src/lsp_capability.rs");
const languageServer = await read(
  "apps/desktop/src-tauri/src/ide/language_server.rs",
);
const smoke = await read("apps/desktop/src-tauri/src/lsp_smoke.rs");
const types = await read("packages/ui/src/types.ts");
const chatRun = await read("packages/ui/src/chat-run.ts");
const catalog = await read("packages/ui/src/provider-catalog.ts");
const surfaces = await read("packages/ui/src/surfaces.tsx");
const approval = await read("apps/desktop/src-tauri/src/capabilities/approval.rs");
const execute = await read("apps/desktop/src-tauri/src/capabilities/execute.rs");

const tools = [
  ["CodeDefinition", "code.definition", "gyro_code_definition"],
  ["CodeReferences", "code.references", "gyro_code_references"],
  ["CodeHover", "code.hover", "gyro_code_hover"],
  ["CodeSymbols", "code.symbols", "gyro_code_symbols"],
  ["CodeFormat", "code.format", "gyro_code_format"],
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
  // Language servers can execute project build scripts and plugins, so even
  // semantic queries need command authority and must stay out of Plan mode.
  const descriptor = capabilities.match(
    new RegExp(`id: CapabilityId::${variant},[\\s\\S]{0,240}?description:`),
  )?.[0];
  assert.ok(descriptor, `${variant} has no descriptor`);
  assert.ok(
    descriptor.includes("CapabilityClass::TerminalExecute"),
    `${variant} must require TerminalExecute`,
  );
}

// lib.rs keeps delegation only: one dispatcher arm, one schema guard, one
// module, and the same sensitive-path upgrade workspace reads get.
assert.ok(
  lib.includes("mod lsp_capability;"),
  "lsp_capability module not declared",
);
assert.ok(
  lib.includes(
    "| CapabilityId::CodeSymbols => lsp_capability::execute(app, bound, request)?",
  ),
  "dispatcher arm for the code capabilities is missing",
);
assert.ok(
  lib.includes("lsp_capability::schema(id)"),
  "schema delegation is missing",
);
assert.match(
  lib,
  /CapabilityId::WorkspaceRead\s*\n\s*\| CapabilityId::WorkspaceReadRange\s*\n\s*\| CapabilityId::WorkspaceReadEditor\s*\n\s*\| CapabilityId::CodeDefinition/,
  "code capabilities must join the sensitive-path upgrade",
);
// Source contract: the production broker must finish every permission gate
// and its live-policy recheck before the sole dispatch that can start an LSP.
// The Rust tests exercise the actual classification and policy decisions.
const handler = execute.slice(
  execute.indexOf("fn handle_desktop_provider_capability_request_inner("),
);
const permissionLoop = handler.indexOf("for class in permission_classes.iter().copied()");
const finalGuard = handler.indexOf("// Approval can wait for minutes.");
const permissionRecheck = handler.indexOf("if capability_denied_permission(");
const dispatch = handler.indexOf("match execute_provider_capability(");
assert.ok(permissionLoop > 0 && finalGuard > permissionLoop);
assert.ok(permissionRecheck > finalGuard && dispatch > permissionRecheck);
const gates = handler.slice(permissionLoop, finalGuard);
assert.ok(gates.includes("if access == CapabilityAccess::Deny"));
assert.ok(gates.includes('return fail("user-denied"'));
assert.ok(gates.includes("wait_for_capability_approval("));
assert.ok(gates.includes("capability_execution_guard::rejection("));
assert.ok(!gates.includes("execute_provider_capability("));
assert.ok(
  handler.slice(permissionRecheck, dispatch).includes('return fail("policy-denied"'),
  "policy revocation after an approval wait must prevent dispatch",
);
assert.ok(lib.includes("mod lsp_smoke;"), "lsp_smoke module not declared");
assert.ok(
  lib.includes("if lsp_smoke::start(app.handle())?"),
  "the native LSP smoke harness is not wired",
);

// The capability module owns the observation envelope and the honest
// indexing outcome.
assert.ok(
  lsp.includes('"gyro.code-observation.v1"'),
  "observation schema missing",
);
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
assert.ok(
  smoke.includes("GYRO_LSP_SMOKE"),
  "smoke harness not gated on its env var",
);
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
function executeFunction(source, fileName, functionName, argument, dependencies = []) {
  const ast = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declarations = new Map();
  const names = [functionName, ...dependencies];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      names.includes(node.name?.getText(ast))
    ) {
      declarations.set(node.name.getText(ast), node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) {
    assert.ok(declarations.has(name), `${fileName} no longer declares ${name}`);
  }
  const code = ts.transpileModule(
    `${[...declarations.values()].join("\n")}; globalThis.run = ${functionName};`,
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
    capabilityLabel(id),
    label,
    `chat-run.ts no longer labels ${id} "${label}"`,
  );
}
assert.ok(
  chatRun.includes("capabilityUi(capabilityId)") &&
    chatRun.includes("capabilityLabel(capabilityId)"),
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

// Execute the shipped event adapter with the exact backend approval copy.
// The existing card uses reason as its visible description.
const executionReason = JSON.parse(
  approval.match(/const LANGUAGE_SERVER_EXECUTION_REASON: &str = ("[^"\n]+");/)?.[1] ?? "null",
);
assert.match(executionReason, /may run project build scripts or plugins/);
assert.ok(surfaces.includes("description={approval.reason ?? approval.risk}"));
const approvalDependencies = [
  "eventPayloadRecord", "stringFromEventPayload", "recordFromUnknown", "stringFromRecord",
];
for (const [variant] of tools) {
  const capabilityId = variant.replace(/[A-Z]/g, (letter, index) => `${index ? "-" : ""}${letter.toLowerCase()}`);
  const adapted = executeFunction(
    surfaces,
    "surfaces.tsx",
    "providerApprovalFromEvent",
    {
      kind: "approval-requested",
      payload: {
        kind: "capability-approval", approvalId: "approval", capabilityId,
        capabilityClass: "terminal-execute", scopeKind: "path", scopeValue: "src/main.rs",
        reason: executionReason, risk: "Execution permission", status: "waiting",
      },
    },
    approvalDependencies,
  );
  assert.equal(adapted.reason, executionReason, `${capabilityId} must show the execution risk`);
  assert.equal(adapted.risk, "Execution permission");
  assert.equal(adapted.scope, "path · src/main.rs");
  assert.equal(adapted.status, "pending");
}

console.log("code intelligence checks passed");
