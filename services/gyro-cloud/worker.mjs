const MAX_BYTES = 16 * 1024 * 1024;
const CHAT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KEY_CHECK_BYTES = 58;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function decode(value) {
  if (!BASE64URL.test(value) || value.length % 4 === 1) throw new Error("Invalid token encoding");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), c => c.charCodeAt(0));
}

async function hexDigest(value) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function accountFor(request, env) {
  const bearer = request.headers.get("Authorization");
  if (!bearer?.startsWith("Bearer ") || bearer.length > 8192) return null;
  try {
    const parts = bearer.slice(7).split(".");
    if (parts.length !== 3) return null;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const header = JSON.parse(decoder.decode(decode(parts[0])));
    const claims = JSON.parse(decoder.decode(decode(parts[1])));
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!["ES256", "HS256"].includes(header.alg) || header.crit ||
        !env.OIDC_ISSUER || !env.OIDC_AUDIENCE || claims.iss !== env.OIDC_ISSUER ||
        !audiences.includes(env.OIDC_AUDIENCE) || typeof claims.sub !== "string" || !CHAT_ID.test(claims.sub) ||
        claims.role !== "authenticated" || claims.is_anonymous !== false ||
        typeof claims.session_id !== "string" || !CHAT_ID.test(claims.session_id) || !Number.isFinite(claims.exp) || claims.exp <= now ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))) return null;
    const valid = header.alg === "ES256" && await verifyAsymmetric(env, header, parts);
    if (!valid && !await verifyWithIssuer(env, bearer, claims.sub)) return null;
    return await hexDigest(encoder.encode(JSON.stringify([claims.iss, claims.sub])));
  } catch (error) {
    console.warn("Gyro Cloud authentication error", error.name);
    return null;
  }
}

async function verifyAsymmetric(env, header, parts) {
  try {
    if (typeof header.kid !== "string") return false;
    const jwksUrl = new URL(env.OIDC_JWKS_URL);
    if (jwksUrl.protocol !== "https:") return false;
    const response = await fetch(jwksUrl.href, { redirect: "manual", cf: { cacheTtl: 60, cacheEverything: true } });
    if (!response.ok) { console.warn("Gyro Cloud JWKS response", response.status); return false; }
    const { keys } = await response.json();
    const jwk = keys.find(key => key.kid === header.kid && key.kty === "EC" && key.crv === "P-256" &&
      (!key.use || key.use === "sig") && (!key.alg || key.alg === "ES256"));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(parts[2]),
      encoder.encode(parts.slice(0, 2).join(".")));
  } catch (error) {
    console.warn("Gyro Cloud JWKS error", error.name);
    return false;
  }
}

async function verifyWithIssuer(env, bearer, subject) {
  // The issuer can validate legacy symmetric tokens and tokens that cannot
  // be verified with the currently cached JWKS.
  const url = new URL(env.OIDC_ISSUER + "/user");
  if (url.protocol !== "https:" || !env.SUPABASE_PUBLISHABLE_KEY) return false;
  const response = await fetch(url.href, {
    redirect: "manual",
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: { Authorization: bearer, apikey: env.SUPABASE_PUBLISHABLE_KEY },
  });
  if (!response.ok) { console.warn("Gyro Cloud issuer response", response.status); return false; }
  const user = await response.json();
  return user.id === subject && user.role === "authenticated" &&
    user.is_anonymous === false && Boolean(user.email_confirmed_at);
}

const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const empty = status => new Response(null, { status, headers: privateHeaders });
const json = data => Response.json(data, { headers: privateHeaders });

function entry(object) {
  return {
    id: object.key.split("/").at(-1),
    etag: object.httpEtag,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
    title: object.customMetadata?.title,
    digest: object.customMetadata?.digest,
  };
}

async function readBody(request, size) {
  if (!request.body) return null;
  const body = new Uint8Array(size);
  const reader = request.body.getReader();
  let offset = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (offset + value.length > size) {
      await reader.cancel();
      return null;
    }
    body.set(value, offset);
    offset += value.length;
  }
  return offset === size ? body : null;
}

async function route(request, env, account) {
  const url = new URL(request.url);
  const prefix = `v1/${account}/`;
  const bucket = env.CHATS;
  // Keep the account key check outside the paginated chat namespace.
  if (url.pathname === "/v1/key-check") {
    const key = `key-check/v1/${account}`;
    if (request.method === "GET") {
      const object = await bucket.get(key);
      return object ? new Response(object.body, { headers: privateHeaders }) : empty(404);
    }
    if (request.method !== "PUT") return empty(405);
    if (request.headers.get("Content-Length") !== String(KEY_CHECK_BYTES)) return empty(400);
    const body = await readBody(request, KEY_CHECK_BYTES);
    if (!body || body[0] !== 1) return empty(400);
    const onlyIf = new Headers({ "If-None-Match": "*" });
    return empty(await bucket.put(key, body, { onlyIf }) ? 201 : 412);
  }
  if (url.pathname === "/v1/chats" && request.method === "GET") {
    const page = await bucket.list({
      prefix,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: 50,
      include: ["customMetadata"],
    });
    return json({ items: page.objects.map(entry), cursor: page.truncated ? page.cursor : null });
  }
  const id = url.pathname.match(/^\/v1\/chats\/([^/]+)$/)?.[1];
  if (!id || !CHAT_ID.test(id)) return empty(404);
  const key = prefix + id;

  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return empty(404);
    return new Response(null, { headers: { ...privateHeaders, ETag: object.httpEtag, "X-Gyro-Digest": object.customMetadata.digest } });
  }
  if (request.method === "GET") {
    const object = await bucket.get(key);
    if (!object) return empty(404);
    return new Response(object.body, { headers: {
      ...privateHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
    } });
  }
  if (request.method === "DELETE") {
    await bucket.delete(key);
    return empty(204);
  }
  if (request.method !== "PUT") return empty(405);

  const match = request.headers.get("If-Match");
  const absent = request.headers.get("If-None-Match");
  const onlyIf = new Headers();
  if (match && /^"[0-9a-f]{32}"$/.test(match) && absent === null) onlyIf.set("If-Match", match);
  else if (absent === "*" && match === null) onlyIf.set("If-None-Match", "*");
  else return empty(428);
  const title = request.headers.get("X-Gyro-Title");
  if (!title || title.length > 1200 || !BASE64URL.test(title)) return empty(400);
  const length = request.headers.get("Content-Length");
  if (!length || !/^\d+$/.test(length) || !request.body) return empty(411);
  const size = Number(length);
  if (size > MAX_BYTES) return empty(413);
  if (size < 42) return empty(400);
  const body = await readBody(request, size);
  if (!body || body[0] !== 1) return empty(400);
  const digest = await hexDigest(body);
  const object = await bucket.put(key, body, { onlyIf, sha256: digest, customMetadata: { title, digest } });
  if (object) return json(entry(object));
  const current = await bucket.head(key);
  if (current?.customMetadata?.digest === digest) return json(entry(current));
  return empty(412);
}

export default {
  async fetch(request, env) {
    const account = await accountFor(request, env);
    if (!account) return empty(401);
    let response;
    try {
      if (new URL(request.url).pathname === "/v1/account" && request.method === "GET") {
        response = json({ account });
      } else {
        response = await route(request, env, account);
      }
    } catch {
      response = empty(503);
    }
    console.info(JSON.stringify({
      method: request.method,
      status: response.status,
      requestBytes: Number(request.headers.get("Content-Length")) || 0,
      responseBytes: Number(response.headers.get("Content-Length")) || 0,
    }));
    return response;
  },
};
