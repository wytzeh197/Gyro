import { pathToFileURL } from "node:url";
import { createTodoServer, listen } from "./server.mjs";

export async function observeTodos(previewUrl) {
  const transcript = [];
  const request = async (method, path, body) => {
    const response = await fetch(new URL(path, previewUrl), {
      method,
      signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() };
    transcript.push({
      method,
      path,
      ...(body === undefined ? {} : { request: body }),
      ...result,
    });
    return result;
  };
  const initial = await request("GET", "/todos");
  const created = await request("POST", "/todos", { title: "Gyro Check item" });
  const afterAdd = await request("GET", "/todos");
  const addEvidence = JSON.stringify(transcript);
  const empty = await request("POST", "/todos", { title: "   " });
  const afterEmpty = await request("GET", "/todos");
  return {
    version: 2,
    previewUrl,
    observations: [
      {
        criterionId: "add-item",
        scope: "api",
        actual:
          initial.status === 200 &&
          created.status === 201 &&
          afterAdd.status === 200 &&
          afterAdd.body.length === initial.body.length + 1 &&
          afterAdd.body.some(
            (item) =>
              item.id === created.body.id && item.title === "Gyro Check item",
          ),
        evidence: addEvidence,
      },
      {
        criterionId: "reject-empty",
        scope: "api",
        actual:
          empty.status === 400 &&
          afterEmpty.status === 200 &&
          afterEmpty.body.length === afterAdd.body.length &&
          typeof empty.body.error === "string",
        evidence: JSON.stringify(transcript.slice(3)),
      },
    ],
  };
}

export async function runFixture(variant, previewUrl) {
  if (!["working", "broken", "broken-form", "unavailable"].includes(variant))
    throw new Error("Unknown fixture variant");
  // Claim our own test environment. Never attach to an unknown existing app.
  const server = createTodoServer(
    variant === "unavailable" ? "working" : variant,
  );
  await listen(server, previewUrl);
  try {
    if (variant === "unavailable") {
      await new Promise((resolve) => server.close(resolve));
      throw new Error(
        "Controlled unavailable case: the preview server is stopped. No assertions ran.",
      );
    }
    return await observeTodos(previewUrl);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const observations = await runFixture(
      process.argv[2] || "working",
      process.env.GYRO_CHECK_URL || "http://127.0.0.1:4317",
    );
    console.log(JSON.stringify(observations));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
