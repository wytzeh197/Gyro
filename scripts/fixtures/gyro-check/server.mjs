import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createTodos } from "./todo.mjs";

export function createTodoServer(variant = "working") {
  if (!["working", "broken", "broken-form"].includes(variant))
    throw new Error("Unknown fixture variant");
  const todos = createTodos({ broken: variant === "broken" });
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
        });
        const html = await readFile(
          new URL("index.html", import.meta.url),
          "utf8",
        );
        response.end(
          html.replace(
            'data-fixture-mode="working"',
            `data-fixture-mode="${variant}"`,
          ),
        );
      } else if (request.method === "GET" && request.url === "/todos") {
        send(200, todos.list());
      } else if (request.method === "POST" && request.url === "/todos") {
        let text = "";
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 4096) {
            send(413, { error: "Body too large" });
            return;
          }
        }
        const result = todos.add(JSON.parse(text).title);
        send(result.status, result.body);
      } else send(404, { error: "Not found" });
    } catch {
      send(400, { error: "Invalid request" });
    }
  });
}

export async function listen(server, url) {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  ) {
    throw new Error("Use an isolated loopback HTTP origin");
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(target.port || 80),
      target.hostname.replace(/^\[|\]$/g, ""),
      resolve,
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const variant = process.argv[2] || "working";
  const url = process.env.GYRO_CHECK_URL || "http://127.0.0.1:4317";
  const server = createTodoServer(variant);
  await listen(server, url);
  console.log(`${variant} synthetic to-do fixture: ${url}`);
}
