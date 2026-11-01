import { CodeMode, Tool } from "@opencode/codemode";
import { Effect } from "effect";
import { createInterface } from "node:readline";

// Model source runs only in the confined interpreter, never in this host.
const pending = new Map();
let nextId = 0,
  executing = false,
  returnedBytes = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function hostCall(name, input) {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const abort = () => {
          pending.delete(id);
          reject(new Error("Call interrupted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
        send({ type: "call", id, name, input });
      }),
    catch: (error) => error,
  });
}
async function execute(message) {
  if (executing) throw new Error("Only one execution is allowed per worker");
  executing = true;
  if (
    typeof message.code !== "string" ||
    Buffer.byteLength(message.code) > 16384
  )
    throw new Error("Source exceeds the 16 KiB limit");
  if (!Array.isArray(message.tools) || message.tools.length > 4)
    throw new Error("Invalid tool catalog");
  const tools = Object.create(null);
  for (const tool of message.tools) {
    if (!/^gyro_workspace_(list|search|read|read_range)$/.test(tool.name))
      throw new Error("Tool is outside the inspection allowlist");
    tools[tool.name] = Tool.make({
      description: tool.description,
      input: tool.schema,
      output: { type: "object", additionalProperties: true },
      execute: (input) => hostCall(tool.name, input),
    });
  }
  const runtime = CodeMode.make({
    tools,
    limits: { timeoutMs: 60000, maxToolCalls: 32, maxOutputBytes: 16384 },
  });
  const { toolCalls, ...outcome } = await Effect.runPromise(
    runtime.execute(message.code),
  );
  // Rust retains child receipts; do not duplicate inputs/results in this frame.
  send({ type: "result", outcome, calls: toolCalls.length });
}
lines.on("line", (line) => {
  try {
    if (Buffer.byteLength(line) > 131072) throw new Error("Frame too large");
    const message = JSON.parse(line);
    if (message.type === "start") {
      execute(message).catch((error) =>
        send({
          type: "result",
          outcome: {
            ok: false,
            error: {
              kind: "WorkerFailure",
              message: String(error.message ?? error),
            },
          },
        }),
      );
    } else if (message.type === "response") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      returnedBytes += Buffer.byteLength(line);
      if (returnedBytes > 524288)
        call.reject(new Error("Intermediate data limit exceeded"));
      else if (message.error) call.reject(new Error(message.error));
      else call.resolve(message.value);
    } else throw new Error("Unknown message");
  } catch (error) {
    send({
      type: "result",
      outcome: {
        ok: false,
        error: {
          kind: "ProtocolError",
          message: String(error.message ?? error),
        },
      },
    });
  }
});
lines.on("close", () => {
  for (const call of pending.values())
    call.reject(new Error("Host disconnected"));
  pending.clear();
});
