import {
  ApiError,
  UUID,
  startInput,
  credentialsInput,
  readJSON,
  featureEnabled,
  seal,
  terminal,
} from "./safety.mjs";
import { authenticate, Database } from "./database.mjs";

export const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
export function errorResponse(error) {
  return json(
    { error: error instanceof ApiError ? error.code : "internal_error" },
    error instanceof ApiError ? error.status : 500,
  );
}

export async function handleAPI(request, env, deps = {}) {
  if (!featureEnabled(env)) return new Response(null, { status: 404 });
  const url = new URL(request.url);
  try {
    const userId = await (deps.authenticate ?? authenticate)(request, env);
    if (
      !env.CLOUD_AGENTS_USER_IDS.split(",")
        .map((x) => x.trim())
        .includes(userId)
    )
      throw new ApiError(403, "prototype_access_required");
    const db = deps.db ?? new Database(env);
    const runStub = deps.runStub ?? ((id) => env.RUNS.getByName(id));
    const method = request.method;
    if (url.pathname === "/v1/cloud/balance" && method === "GET")
      return json(await db.call("balance", userId));
    if (url.pathname === "/v1/cloud/runs" && method === "GET")
      return json(await db.call("list", userId));
    if (url.pathname === "/v1/cloud/runs" && method === "POST") {
      const { config, credentials } = startInput(
        await readJSON(request),
        request.headers.get("idempotency-key"),
      );
      // Encryption is validated before reserving any money. No request object,
      // bearer, or credentials is passed to waitUntil, a queue, or a log sink.
      const encrypted = await seal(
        credentials,
        env.CLOUD_AGENTS_ENCRYPTION_KEY,
        config.id,
      );
      const run = await db.call("reserve", userId, config.id, config);
      if (run.status === "queued")
        await runStub(config.id).initialize(userId, run, encrypted);
      return json(run, 202);
    }
    const match =
      /^\/v1\/cloud\/runs\/([^/]+)(?:\/(logs|stop|pause|resume))?$/.exec(
        url.pathname,
      );
    if (!match || !UUID.test(match[1])) throw new ApiError(404, "not_found");
    const [, id, action] = match;
    // Check ownership in Postgres before touching a Durable Object, even for logs.
    const run = await db.call("get", userId, id);
    if (method === "GET" && !action) return json(run);
    if (method === "GET" && action === "logs") {
      const after =
        url.searchParams.get("after") ??
        request.headers.get("last-event-id") ??
        "0";
      if (!/^\d{1,12}$/.test(after))
        throw new ApiError(400, "invalid_log_cursor");
      const batch = await runStub(id).logs(userId, Number(after));
      // Each finite SSE batch carries retry + cursor. EventSource reconnects;
      // desktop fetch clients reconnect with Last-Event-ID and their JWT header.
      const lines = ["retry: 2000\n\n"];
      for (const event of batch.events)
        lines.push(
          `id: ${event.id}\nevent: log\ndata: ${JSON.stringify(event)}\n\n`,
        );
      lines.push(
        `event: status\ndata: ${JSON.stringify({ status: run.status, reason: run.reason, cursor: batch.cursor, truncated: batch.truncated, terminal: terminal(run.status) })}\n\n`,
      );
      return new Response(lines.join(""), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (method !== "POST" || !action || action === "logs")
      throw new ApiError(405, "method_not_allowed");
    if (action === "resume") {
      const body = await readJSON(request);
      if (!body || Object.keys(body).some((k) => k !== "credentials"))
        throw new ApiError(400, "invalid_request");
      const credentials = credentialsInput(body.credentials, run.provider);
      const encrypted = await seal(
        credentials,
        env.CLOUD_AGENTS_ENCRYPTION_KEY,
        id,
      );
      return json(await runStub(id).resume(userId, encrypted), 202);
    }
    return json(await runStub(id).command(userId, action));
  } catch (error) {
    return errorResponse(error);
  }
}
