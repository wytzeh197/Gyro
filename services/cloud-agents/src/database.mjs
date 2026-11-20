import { ApiError, UUID } from "./safety.mjs";

export async function authenticate(request, env, fetcher = fetch) {
  const bearer = request.headers.get("authorization");
  if (!bearer?.startsWith("Bearer ") || bearer.length > 8192)
    throw new ApiError(401, "sign_in_required");
  try {
    const parts = bearer.slice(7).split(".");
    if (parts.length !== 3) throw new Error();
    const claims = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (
      claims.iss !== `${env.SUPABASE_URL}/auth/v1` ||
      ![claims.aud].flat().includes("authenticated") ||
      !UUID.test(claims.sub) ||
      claims.role !== "authenticated" ||
      claims.is_anonymous !== false ||
      !UUID.test(claims.session_id ?? "") ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000
    )
      throw new Error();
    const result = await fetcher(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization: bearer, apikey: env.SUPABASE_PUBLISHABLE_KEY },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) throw new Error();
    const user = await result.json();
    if (
      user.id !== claims.sub ||
      user.is_anonymous !== false ||
      !user.email_confirmed_at
    )
      throw new Error();
    return user.id;
  } catch {
    throw new ApiError(401, "sign_in_required");
  }
}

export class Database {
  constructor(env, fetcher = fetch) {
    this.env = env;
    this.fetcher = fetcher;
  }
  /** @param {string} action @param {string|null} userId @param {string|null} runId @param {object} data */
  async call(action, userId, runId = null, data = {}) {
    let response;
    try {
      response = await this.fetcher(
        `${this.env.SUPABASE_URL}/rest/v1/rpc/cloud_agents_rpc`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            "content-type": "application/json",
            apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
            authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            p_action: action,
            p_user_id: userId,
            p_run_id: runId,
            p_data: data,
          }),
        },
      );
    } catch {
      throw new ApiError(503, "database_unavailable");
    }
    if (!response.ok) throw new ApiError(503, "database_unavailable");
    const result = await response.json();
    if (result.error)
      throw new ApiError(
        {
          not_found: 404,
          insufficient_hours: 402,
          disabled: 503,
          conflict: 409,
          invalid_state: 409,
          cap_reached: 409,
        }[result.error] ?? 400,
        result.error,
      );
    return result;
  }
}
