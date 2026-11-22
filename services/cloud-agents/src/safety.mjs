export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const terminal = (s) => ["done", "failed", "cancelled"].includes(s);
export const featureEnabled = (env) =>
  env.GYRO_CLOUD_ENABLED === "1" && env.CLOUD_AGENTS_ENABLED === "1";

// Mirrors gyro-core's recognizable token families. Exact supplied secrets are
// removed first. No redactor can identify arbitrary secrets in repository text.
export function redact(text, secrets = []) {
  let value = String(text);
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    value = value.split(secret).join("[REDACTED]");
  return value
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bxai-[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function startInput(body, id) {
  if (!UUID.test(id ?? "")) throw new ApiError(400, "idempotency_key_required");
  if (!body || Array.isArray(body) || typeof body !== "object")
    throw new ApiError(400, "invalid_request");
  if (
    Object.keys(body).some(
      (k) =>
        ![
          "repo",
          "branch",
          "task",
          "provider",
          "model",
          "capSeconds",
          "idleSeconds",
          "credentials",
        ].includes(k),
    )
  )
    throw new ApiError(400, "unknown_field");
  if (
    typeof body.repo !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      body.repo,
    )
  )
    throw new ApiError(400, "github_repo_required");
  const repo = body.repo.replace(/\.git$/, "") + ".git";
  const path = new URL(repo).pathname;
  if (
    path.split("/").some((p) => p === "." || p === "..") ||
    path.endsWith("/..git")
  )
    throw new ApiError(400, "invalid_repo");
  if (
    typeof body.branch !== "string" ||
    body.branch.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(body.branch) ||
    /\.\.|\/\/|@\{|\.lock(?:\/|$)|[/.]$/.test(body.branch)
  )
    throw new ApiError(400, "invalid_branch");
  if (
    typeof body.task !== "string" ||
    !body.task.trim() ||
    body.task.length > 16000 ||
    body.task.includes("\0")
  )
    throw new ApiError(400, "invalid_task");
  if (!["claude", "codex"].includes(body.provider))
    throw new ApiError(400, "invalid_provider");
  const { apiKey, gitToken } = credentialsInput(
    body.credentials,
    body.provider,
  );
  const capSeconds = body.capSeconds ?? 3600,
    idleSeconds = body.idleSeconds ?? 600;
  if (
    !Number.isInteger(capSeconds) ||
    capSeconds < 60 ||
    capSeconds > 3600 ||
    !Number.isInteger(idleSeconds) ||
    idleSeconds < 60 ||
    idleSeconds > 600
  )
    throw new ApiError(400, "invalid_limits");
  if (
    body.model !== undefined &&
    (typeof body.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/.test(body.model))
  )
    throw new ApiError(400, "invalid_model");
  return {
    config: {
      id: id.toLowerCase(),
      repo,
      branch: body.branch,
      task: redact(body.task, [apiKey, gitToken]),
      provider: body.provider,
      model: body.model ?? null,
      cap_seconds: capSeconds,
      idle_seconds: idleSeconds,
      result_branch: `gyro/cloud/${id.toLowerCase()}`,
    },
    credentials: { apiKey, gitToken },
  };
}
export function credentialsInput(value, provider) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["apiKey", "gitToken"].includes(k))
  )
    throw new ApiError(400, "byok_credentials_required");
  const { apiKey, gitToken } = value;
  if (
    typeof apiKey !== "string" ||
    apiKey.length > 1024 ||
    /[\s\0]/.test(apiKey) ||
    !(
      provider === "claude"
        ? /^sk-ant-api[A-Za-z0-9_-]{12,}$/
        : /^sk-[A-Za-z0-9_-]{12,}$/
    ).test(apiKey) ||
    /^sk-ant-oat/.test(apiKey)
  )
    throw new ApiError(400, "api_key_required_no_subscription_tokens");
  if (
    typeof gitToken !== "string" ||
    gitToken.length > 1024 ||
    !/^(ghp_|github_pat_)[A-Za-z0-9_]{12,}$/.test(gitToken)
  )
    throw new ApiError(400, "github_token_required");
  return { apiKey, gitToken };
}
export async function readJSON(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "json_required");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "body_required");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new ApiError(413, "request_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "invalid_json");
  }
}
const encoder = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
async function aes(key) {
  try {
    const bytes = unb64(key);
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new ApiError(503, "encryption_not_configured");
  }
}
export async function seal(value, key, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await aes(key),
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}
export async function unseal(value, key, context) {
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(value.iv),
          additionalData: encoder.encode(context),
        },
        await aes(key),
        unb64(value.data),
      ),
    ),
  );
}

// Only the generated branch may be changed. Check all receive-pack command
// packets before forwarding any bytes to GitHub. Pack objects remain streamed.
export async function checkedPushBody(stream, branch) {
  if (!stream) throw new ApiError(403, "push_denied");
  const reader = stream.getReader();
  let buffer = new Uint8Array(0),
    offset = 0,
    commands = 0;
  for (;;) {
    while (buffer.length >= offset + 4) {
      const header = new TextDecoder().decode(
        buffer.subarray(offset, offset + 4),
      );
      if (!/^[0-9a-f]{4}$/.test(header)) throw new ApiError(403, "push_denied");
      const length = parseInt(header, 16);
      if (length === 0) {
        if (!commands) throw new ApiError(403, "push_denied");
        return new ReadableStream({
          start(c) {
            c.enqueue(buffer);
          },
          async pull(c) {
            const item = await reader.read();
            if (item.done) c.close();
            else c.enqueue(item.value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      }
      if (length < 4 || offset + length > 65536)
        throw new ApiError(403, "push_denied");
      if (buffer.length < offset + length) break;
      const line = new TextDecoder()
        .decode(buffer.subarray(offset + 4, offset + length))
        .split("\0")[0]
        .trim();
      const match =
        /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/heads\/[^\s]+)$/.exec(
          line,
        );
      if (
        !match ||
        match[3] !== `refs/heads/${branch}` ||
        /^0+$/.test(match[2])
      )
        throw new ApiError(403, "push_denied");
      commands++;
      offset += length;
    }
    if (buffer.length >= 65536) throw new ApiError(403, "push_denied");
    const item = await reader.read();
    if (item.done) throw new ApiError(403, "push_denied");
    // Fetch chunks are bounded by the runtime; the pack itself is not buffered.
    const next = new Uint8Array(buffer.length + item.value.length);
    next.set(buffer);
    next.set(item.value, buffer.length);
    buffer = next;
  }
}

// Public package registries the agent may read while installing dependencies.
// Only anonymous GET/HEAD reads are forwarded: no credentials are attached and
// publishing, login and private registries stay blocked. Redirects are not
// followed by the Worker, so each redirect target is checked again here.
const PACKAGE_REGISTRIES = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
]);
export function packageRegistryRead(url, method, phase) {
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    PACKAGE_REGISTRIES.has(url.hostname) &&
    ["GET", "HEAD"].includes(method) &&
    ["starting", "running"].includes(phase) &&
    !url.pathname.startsWith("/-/user") &&
    !url.pathname.startsWith("/-/npm/v1/tokens") &&
    !url.pathname.startsWith("/-/whoami")
  );
}
