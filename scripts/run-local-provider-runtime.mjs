// Scripted loopback provider through the real native chat/tool pipeline.
// This measures integration behavior, not model intelligence or provider speed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeDebugExecutable } from "./build-native-debug-executable.mjs";

const browserOnly = process.argv.includes("--browser-only");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp("/private/tmp/gyro-local-runtime-");
const data = join(root, "data");
await mkdir(data);
const requests = [];
let requestIndex = 0;
const errors = [];
const pageRequests = [];
const fixtureReadme =
  "# Meridian Tools\n\nSmall local utility functions.\n\n## Install\n\nRequires Node 22 or newer. No dependencies.\n\n## Usage\n\nImport clamp from src/clamp.mjs.\n\n## Development\n\nRun node --test.\n\nMore details: [Guide](docs/guide.md).\n";
function objects(value, out = []) {
  if (value && typeof value === "object") {
    out.push(value);
    for (const child of Object.values(value)) objects(child, out);
  }
  return out;
}
function toolHistory(body) {
  const calls = new Map();
  for (const message of body.messages)
    for (const call of message.tool_calls || []) {
      let args = JSON.parse(call.function.arguments);
      let name = call.function.name;
      if (name === "gyro_tool_invoke") {
        name = args.name;
        args = args.arguments;
      }
      calls.set(call.id, { name, args });
    }
  return body.messages
    .filter((m) => m.role === "tool")
    .map((m) => ({
      ...calls.get(m.tool_call_id),
      payload: JSON.parse(m.content),
    }));
}
function readResult(history, path) {
  const result = history.findLast(
    (r) => r.name === "gyro_workspace_read" && r.args.path === path,
  );
  assert.ok(result, `missing real file read: ${path}`);
  const file = objects(result.payload).find(
    (v) => typeof v.content === "string" && typeof v.contentHash === "string",
  );
  assert.ok(
    file,
    `file read did not return content/hash: ${JSON.stringify(result.payload)}`,
  );
  return file;
}
function actionsFor(body) {
  const text = body.messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((c) => c.text || "").join("\n"),
    )
    .join("\n");
  const instruction = text.slice(
    text.lastIndexOf("\n\nUser message:\n") + "\n\nUser message:\n".length,
  );
  const history = toolHistory(body);
  if (instruction.includes("Remember the exact test keyword"))
    return { final: "MEMORIZED" };
  if (
    instruction.includes("Reply exactly GYRO_OK") ||
    instruction.includes("Reply with the exact test keyword I asked")
  ) {
    assert.ok(
      text.includes("GYRO_OK"),
      "resumed keyword missing from actual conversation history",
    );
    return { final: "GYRO_OK" };
  }
  if (instruction.includes("BROWSER_SEQUENCE")) {
    const desired = [
      {
        name: "gyro_browser_open",
        args: {
          url: `${endpoint.slice(0, -3)}/browser-fixture.html`,
          reveal: false,
        },
      },
      {
        name: "gyro_browser_set_viewport",
        args: { mode: "responsive", width: 1440, height: 960 },
      },
      { name: "gyro_browser_screenshot", args: {} },
    ];
    for (const action of desired) {
      const result = history.findLast((r) => r.name === action.name);
      if (!result) return { actions: [action] };
      assert.ok(
        !JSON.stringify(result.payload).includes('"status":"error"'),
        JSON.stringify(result.payload),
      );
    }
    const images = objects(body.messages).filter(
      (v) =>
        typeof v.url === "string" && v.url.startsWith("data:image/png;base64,"),
    );
    assert.ok(
      images.length,
      "screenshot must reach the model as actual PNG image data",
    );
    const png = Buffer.from(images.at(-1).url.split(",")[1], "base64");
    assert.equal(png.readUInt32BE(16), 1440);
    assert.equal(png.readUInt32BE(20), 960);
    return { final: "BROWSER_OK" };
  }
  const code = instruction.includes("Fix clamp in src/clamp.mjs");
  const readme = instruction.includes("Shorten README.md from 267 lines");
  const paths = code
    ? ["src/clamp.mjs", "clamp.test.mjs"]
    : readme
      ? ["README.md"]
      : ["README.md", "src/clamp.mjs"];
  const edits = history.filter((r) => r.name === "gyro_workspace_propose_edit");
  const reads = history.filter((r) => r.name === "gyro_workspace_read");
  if (!paths.every((path) => reads.some((r) => r.args.path === path)))
    return {
      actions: paths.map((path) => ({
        name: "gyro_workspace_read",
        args: { path },
      })),
    };
  if (!code && !readme) {
    assert.ok(text.includes("mascot is heron"), "unknown bootstrap request");
    return { final: "SCRIPTED_CONTEXT_HERON: heron." };
  }
  if (!edits.length) {
    return {
      actions: paths.map((path) => {
        const file = readResult(history, path);
        const content = readme
          ? fixtureReadme
          : path === "src/clamp.mjs"
            ? file.content.replace(
                "return Math.max(value, minimum);",
                "return Math.min(Math.max(value, minimum), maximum);",
              )
            : file.content +
              "test('upper bound', () => assert.equal(clamp(20, 0, 10), 10));\n";
        return {
          name: "gyro_workspace_propose_edit",
          args: { path, content, expectedHash: file.contentHash },
        };
      }),
    };
  }
  const lastEdit = history.findLastIndex(
    (r) => r.name === "gyro_workspace_propose_edit",
  );
  if (
    !paths.every((path) =>
      history
        .slice(lastEdit + 1)
        .some((r) => r.name === "gyro_workspace_read" && r.args.path === path),
    )
  )
    return {
      reviewWait: true,
      actions: paths.map((path) => ({
        name: "gyro_workspace_read",
        args: { path },
      })),
    };
  for (const path of paths) {
    const file = readResult(history, path);
    assert.ok(
      readme
        ? file.content.split("\n").length <= 85
        : path === "src/clamp.mjs"
          ? file.content.includes("Math.min")
          : file.content.includes("test('upper bound'"),
      `reviewed edit missing from ${path}`,
    );
  }
  if (code && !history.some((r) => r.name === "gyro_terminal_open"))
    return {
      actions: [
        {
          name: "gyro_terminal_open",
          args: {
            program: "node",
            args: ["--test"],
          },
        },
      ],
    };
  if (code) {
    const terminal = history.findLast((r) =>
      ["gyro_terminal_open", "gyro_terminal_wait"].includes(r.name),
    );
    if (!objects(terminal.payload).some((v) => v.completed === true)) {
      const resource = objects(terminal.payload).find(
        (v) => v.kind === "terminal" && typeof v.id === "string",
      );
      assert.ok(resource, "running terminal must retain its owned resource");
      return {
        actions: [
          {
            name: "gyro_terminal_wait",
            args: { resourceId: resource.id, timeoutMs: 5000 },
          },
        ],
      };
    }
    const result = JSON.stringify(terminal.payload);
    assert.ok(
      objects(terminal.payload).some((v) => v.exitCode === 0),
      `terminal did not complete successfully: ${result}`,
    );
    assert.ok(
      !result.includes('"status":"denied"') &&
        !result.includes('"status":"error"'),
      `terminal failed: ${result}`,
    );
  }
  return {
    final: "Verified the scripted fixture change using Gyro tool results.",
  };
}
function advertisedActions(body, desired) {
  const names = body.tools.map((t) => t.function.name);
  const history = toolHistory(body);
  const missing = desired.filter((a) => !names.includes(a.name));
  const undiscovered = missing.filter(
    (a) =>
      !history.some(
        (r) => r.name === "gyro_tool_catalog" && r.args.prefix === a.name,
      ),
  );
  if (undiscovered.length) {
    assert.ok(names.includes("gyro_tool_catalog"));
    return [...new Set(undiscovered.map((a) => a.name))].map((prefix) => ({
      name: "gyro_tool_catalog",
      args: { prefix },
    }));
  }
  return desired.map((a) =>
    names.includes(a.name)
      ? a
      : { name: "gyro_tool_invoke", args: { name: a.name, arguments: a.args } },
  );
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(
      request.headers.authorization,
      undefined,
      "fixture must be keyless",
    );
    if (request.method === "GET" && request.url === "/browser-fixture.html") {
      const pageRequest = { startedAt: Date.now(), delayMs: 4000 };
      pageRequests.push(pageRequest);
      await new Promise((resolve) => setTimeout(resolve, pageRequest.delayMs));
      pageRequest.respondedAt = Date.now();
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          "<!doctype html><title>Gyro browser sequence</title><h1>BROWSER_SEQUENCE</h1><button onclick='this.textContent=\"Clicked\"'>Try browser</button>",
        );
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "scripted-runtime" }] }));
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 8 * 1024 * 1024);
    }
    const body = JSON.parse(raw);
    await writeFile(join(root, `request-${requestIndex++}.json`), raw, {
      mode: 0o600,
    });
    const plan = actionsFor(body);
    const actions = plan.actions ? advertisedActions(body, plan.actions) : [];
    requests.push({
      index: requests.length,
      at: Date.now(),
      toolResults: body.messages.filter((m) => m.role === "tool").length,
      actions: actions.map((a) => a.name),
      final: plan.final || null,
      reviewWaitMs: plan.reviewWait ? 100 : 0,
    });
    if (plan.reviewWait)
      await new Promise((resolve) => setTimeout(resolve, 100));
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (plan.final) {
      send({ content: plan.final });
      send({}, "stop");
    } else {
      actions.forEach((action, index) => {
        const id = `fixture_${requests.length}_${index}`,
          args = JSON.stringify(action.args),
          split = Math.max(1, Math.floor(action.name.length / 2));
        send({
          tool_calls: [
            {
              index,
              id,
              type: "function",
              function: {
                name: action.name.slice(0, split),
                arguments: args.slice(0, 7),
              },
            },
          ],
        });
        send({
          tool_calls: [
            {
              index,
              function: {
                name: action.name.slice(split),
                arguments: args.slice(7),
              },
            },
          ],
        });
      });
      send({}, "tool_calls");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(String(error));
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const spec = {
  providers: [
    { id: "local-runtime-fixture", model: "scripted-runtime", effort: "" },
  ],
  trials: 1,
  timeoutSeconds: 15,
  tasks: browserOnly ? ["browser"] : ["readme", "code", "no-tool", "browser"],
  reviewFixtureEdits: true,
  localFixtureEndpoint: endpoint,
};
const specPath = join(root, "spec.json");
await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n");
const env = {};
for (const key of ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  GYRO_TEST_DATA_DIR: data,
  GYRO_BENCHMARK_ROOT: root,
  GYRO_TIMING_DIAGNOSTICS: "1",
  GYRO_PERFORMANCE_BENCHMARK: specPath,
  GYRO_LOCAL_PROVIDER_FIXTURE: "1",
  TAURI_CONFIG: JSON.stringify({
    app: {
      windows: [
        {
          label: "main",
          url: "about:blank",
          visible: false,
          width: 1280,
          height: 1000,
          incognito: true,
        },
      ],
    },
  }),
});
console.log(`Local scripted runtime evidence: ${root}`);
let code;
try {
  const binary = await buildNativeDebugExecutable({
    root: repo,
    bin: "gyro-desktop",
    env,
  });
  code = await new Promise((resolve, reject) => {
    const child = spawn(binary, [], { cwd: repo, env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.once("error", reject);
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      resolve(signal || exit);
    });
  });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(root, "mock-transport.json"),
    JSON.stringify(
      { scripted: true, endpoint, code, requests, pageRequests, errors },
      null,
      2,
    ) + "\n",
  );
}
assert.equal(code, 0);
assert.deepEqual(errors, []);
const screenshotRequests = requests.filter((r) =>
  r.actions.includes("gyro_browser_screenshot"),
);
assert.equal(pageRequests.length, 2);
assert.equal(screenshotRequests.length, 2);
pageRequests.forEach((page, i) =>
  assert.ok(
    screenshotRequests[i].at < page.respondedAt,
    "screenshot must be requested before navigation commits",
  ),
);
const report = JSON.parse(
  await readFile(join(root, "benchmark-local-runtime-fixture.json"), "utf8"),
);
assert.equal(report.records.length, browserOnly ? 2 : 8);
assert.ok(
  report.records.every((r) => r.outcome === "completed" && r.correct === true),
  JSON.stringify(
    report.records.map((r) => ({
      task: r.task,
      resumed: r.resumedRequested,
      outcome: r.outcome,
      correct: r.correct,
      error: r.failureDetail,
    })),
  ),
);
console.log(
  JSON.stringify(
    {
      passed: true,
      scripted: true,
      root,
      turnConditions: report.records.length,
      httpRequests: requests.length,
    },
    null,
    2,
  ),
);
