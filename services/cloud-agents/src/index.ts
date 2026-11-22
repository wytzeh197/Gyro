import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { handleAPI } from "./api.mjs";
import { Controller } from "./controller.mjs";
import { Database } from "./database.mjs";
import {
  ApiError,
  featureEnabled,
  unseal,
  redact,
  checkedPushBody,
  packageRegistryRead,
} from "./safety.mjs";

type Run = {
  id: string;
  user_id: string;
  status: string;
  provider: string;
  repo: string;
  result_branch: string;
  deadline_at: string;
  idle_seconds: number;
  [key: string]: unknown;
};
type Ciphertext = { iv: string; data: string };
type State = {
  run: Run;
  phase: string;
  encrypted?: Ciphertext;
  snapshot?: { id: string };
};

class ContainerRuntime {
  constructor(
    private owner: CloudRun,
    private ctx: DurableObjectState,
  ) {}
  private container() {
    if (!this.ctx.container) throw new Error("container_not_configured");
    return this.ctx.container;
  }
  running() {
    return this.container().running;
  }
  async start(state: State) {
    const c = this.container();
    if (c.running) throw new Error("already_running");
    c.start({
      ...(state.snapshot
        ? { containerSnapshot: state.snapshot }
        : { image: c.images.agent }),
      instance: "standard-1",
      enableInternet: false,
    });
    const outbound = this.ctx.exports.RunOutbound({
      props: { runId: state.run.id },
    });
    try {
      await c.interceptAllOutboundHttp(outbound);
      await c.interceptOutboundHttps("*", outbound);
      // Independent platform fallback if the alarm path stops running.
      await c.setInactivityTimeout(60000);
      await this.launch("run", state);
    } catch (error) {
      await c.destroy();
      throw error;
    }
  }
  private async launch(action: string, state: State) {
    const config = {
      ...state.run,
      deadline_epoch: Date.parse(state.run.deadline_at) / 1000,
      restored: Boolean(state.snapshot),
    };
    const stdin = new Blob([JSON.stringify(config)]).stream();
    const process = await this.container().exec(
      ["python3", "/opt/gyro/runner.py", action],
      { stdin, stdout: "ignore", stderr: "ignore" },
    );
    // Container processes outlive this RPC and DO eviction. Completion is read
    // by durable alarms. Do not waitUntil an hours-long exit promise.
    process.exitCode.catch(() => {});
  }
  async probe(after: number) {
    const p = await this.container().exec([
      "python3",
      "/opt/gyro/runner.py",
      "probe",
      String(after),
    ]);
    const output = await p.output(); // runner output bounded to 512 x 4 KiB.
    if (output.exitCode) throw new Error("probe_failed");
    const result = JSON.parse(new TextDecoder().decode(output.stdout));
    result.events = result.events.map((event: { text: string }) => ({
      ...event,
      text: redact(event.text),
    }));
    return result;
  }
  async quiesce() {
    const p = await this.container().exec(
      ["python3", "/opt/gyro/runner.py", "quiesce"],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (await p.exitCode) throw new Error("quiesce_failed");
  }
  async snapshot() {
    return this.container().snapshotContainer({ name: "gyro-cloud-paused" });
  }
  async destroy() {
    if (this.running()) await this.container().destroy();
  }
  async publish(state: State) {
    await this.launch("publish", state);
  }
}

export class CloudRun extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly controller: Controller;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.controller = new Controller(
      ctx.storage,
      new Database(env),
      new ContainerRuntime(this, ctx),
      env,
    );
    if (ctx.container?.running)
      ctx.blockConcurrencyWhile(() =>
        ctx.container!.setInactivityTimeout(60000),
      );
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  initialize(userId: string, run: Run, encrypted: Ciphertext) {
    return this.exclusive(() =>
      this.controller.initialize(userId, run, encrypted),
    );
  }
  resume(userId: string, encrypted: Ciphertext) {
    return this.exclusive(() => this.controller.resume(userId, encrypted));
  }
  command(userId: string, action: string) {
    return this.exclusive(() => this.controller.command(userId, action));
  }
  logs(userId: string, after: number) {
    return this.exclusive(() => this.controller.logs(userId, after));
  }
  async reconcile(run: Run): Promise<void> {
    await this.exclusive(() => this.controller.reconcile(run));
  }
  alarm() {
    return this.exclusive(() => this.controller.tick());
  }

  // This method must not join the lifecycle queue: a running Git/agent command
  // can call it while start/probe/publish is waiting on the container.
  async outbound(request: Request): Promise<Response> {
    try {
      if (!featureEnabled(this.env)) return new Response(null, { status: 403 });
      const state = await this.ctx.storage.get<State>("run");
      if (
        !state ||
        !state.encrypted ||
        !["starting", "running", "publishing"].includes(state.phase) ||
        Date.now() >= Date.parse(state.run.deadline_at)
      )
        return new Response(null, { status: 403 });
      const control = await new Database(this.env).call(
        "control",
        state.run.user_id,
        state.run.id,
      );
      if (!control.enabled) return new Response(null, { status: 403 });
      const url = new URL(request.url);
      if (url.protocol !== "https:" || url.port || url.username || url.password)
        return new Response(null, { status: 403 });
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.delete("cookie");
      // Anonymous dependency downloads: no stored credential is unsealed or
      // attached, and the request cannot carry a body.
      if (packageRegistryRead(url, request.method, state.phase)) {
        headers.delete("proxy-authorization");
        return await fetch(
          new Request(url, {
            method: request.method,
            headers,
            redirect: "manual",
          }),
        );
      }
      const credentials = await unseal(
        state.encrypted,
        this.env.CLOUD_AGENTS_ENCRYPTION_KEY,
        state.run.id,
      );
      let body = request.body;
      if (
        (state.run.provider === "claude" &&
          url.hostname === "api.anthropic.com" &&
          ["/v1/messages", "/v1/messages/count_tokens"].includes(
            url.pathname,
          )) ||
        (state.run.provider === "codex" &&
          url.hostname === "api.openai.com" &&
          ["/v1/responses", "/v1/responses/compact"].includes(url.pathname))
      ) {
        if (
          request.method !== "POST" ||
          !["starting", "running"].includes(state.phase)
        )
          return new Response(null, { status: 403 });
        if (state.run.provider === "claude")
          headers.set("x-api-key", credentials.apiKey);
        else headers.set("authorization", `Bearer ${credentials.apiKey}`);
      } else if (url.hostname === "github.com") {
        const path = new URL(state.run.repo).pathname;
        const discovery = url.pathname === `${path}/info/refs`;
        const upload = url.pathname === `${path}/git-upload-pack`;
        const receive = url.pathname === `${path}/git-receive-pack`;
        if (discovery && request.method === "GET") {
          if (
            ![
              "git-upload-pack",
              ...(state.phase === "publishing" ? ["git-receive-pack"] : []),
            ].includes(url.searchParams.get("service") ?? "")
          )
            return new Response(null, { status: 403 });
        } else if (upload && request.method === "POST" && !url.search) {
          // Repository read, restricted to this run's original URL.
        } else if (
          receive &&
          request.method === "POST" &&
          !url.search &&
          state.phase === "publishing" &&
          !headers.has("content-encoding")
        ) {
          body = await checkedPushBody(body, state.run.result_branch);
        } else return new Response(null, { status: 403 });
        headers.set(
          "authorization",
          `Basic ${btoa(`x-access-token:${credentials.gitToken}`)}`,
        );
      } else return new Response(null, { status: 403 });
      // Credentials are never forwarded across a redirect, even to GitHub.
      return await fetch(
        new Request(request, { headers, body, redirect: "manual" }),
      );
    } catch {
      return new Response(null, { status: 403 });
    }
  }
}
export class RunOutbound extends WorkerEntrypoint<Env, { runId: string }> {
  fetch(request: Request): Promise<Response> {
    return this.env.RUNS.getByName(this.ctx.props.runId).outbound(request);
  }
}
export default {
  fetch: handleAPI,
  async scheduled(_event: ScheduledController, env: Env) {
    // Also runs with the UI flag disabled so stale reservations are released.
    // No sandbox is started by reconciliation when the flags are off.
    const stale: Run[] = await new Database(env).call("stale", null);
    for (const run of stale) await env.RUNS.getByName(run.id).reconcile(run);
  },
};
