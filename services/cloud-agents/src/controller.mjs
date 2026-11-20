import { ApiError, featureEnabled, terminal } from "./safety.mjs";

// Runtime and storage are injected to exercise crash/retry paths without buying
// a sandbox. Only encrypted credentials enter this state machine.
export class Controller {
  constructor(storage, db, runtime, env, now = Date.now) {
    Object.assign(this, { storage, db, runtime, env, now });
  }
  async state(userId) {
    const state = await this.storage.get("run");
    if (!state || (userId && state.run.user_id !== userId))
      throw new ApiError(404, "not_found");
    return state;
  }
  async save(state) {
    await this.storage.put("run", state);
  }
  async arm() {
    await this.storage.setAlarm(this.now() + 15000);
  }
  async initialize(userId, run, encrypted) {
    const prior = await this.storage.get("run");
    if (prior) {
      if (prior.run.user_id !== userId) throw new ApiError(404, "not_found");
      return prior.run;
    }
    if (run.user_id !== userId) throw new ApiError(404, "not_found");
    await this.save({
      run,
      encrypted,
      phase: "queued",
      snapshot: null,
      logCursor: 0,
    });
    await this.arm();
    return run;
  }
  async resume(userId, encrypted) {
    const state = await this.state(userId);
    if (["queued", "starting", "running", "publishing"].includes(state.phase))
      return state.run;
    if (state.phase !== "paused" || !state.snapshot)
      throw new ApiError(409, "invalid_state");
    // Reserve in a database transaction. Retries return the existing segment.
    state.run = await this.db.call("resume", userId, state.run.id);
    state.encrypted = encrypted;
    state.phase = "queued";
    await this.save(state);
    await this.arm();
    return state.run;
  }
  async command(userId, action) {
    const state = await this.state(userId);
    if (terminal(state.run.status)) return state.run;
    if (action === "pause" && state.phase === "paused") return state.run;
    if (action === "pause" && state.phase === "settling")
      throw new ApiError(409, "settlement_pending");
    return this.finish(
      state,
      action === "pause" ? "waiting" : "cancelled",
      action === "pause" ? "manual_pause" : "user_stop",
      action === "pause",
    );
  }
  async collect(state) {
    if (!this.runtime.running()) return null;
    const probe = await this.runtime.probe(state.logCursor);
    const events = probe.events ?? [];
    if (events.length) {
      const history = (await this.storage.get("logs")) ?? [];
      const seen = new Set(history.map((e) => e.id));
      const bounded = [
        ...history,
        ...events.filter((e) => !seen.has(e.id)),
      ].slice(-512);
      while (new TextEncoder().encode(JSON.stringify(bounded)).length > 96000)
        bounded.shift();
      await this.storage.put("logs", bounded);
    }
    state.logCursor = probe.cursor;
    await this.save(state);
    return probe;
  }
  async logs(userId, after) {
    const state = await this.state(userId);
    const events = (await this.storage.get("logs")) ?? [];
    return {
      events: events.filter((e) => e.id > after),
      cursor: state.logCursor,
      truncated: events.length > 0 && after < events[0].id - 1,
    };
  }
  async finish(state, status, reason, snapshot = false) {
    // Persist intent before I/O. An alarm retries an interrupted settlement.
    state.phase = "settling";
    state.settlement = { status, reason, snapshot, endedAt: null };
    await this.save(state);
    await this.arm();
    return this.settle(state);
  }
  async settle(state) {
    const intent = state.settlement;
    try {
      if (this.runtime.running()) {
        try {
          await this.runtime.quiesce();
          await this.collect(state);
        } catch {
          intent.snapshot = false;
          intent.status = "failed";
          intent.reason = "checkpoint_failed";
        }
        if (intent.snapshot) {
          try {
            state.snapshot = await this.runtime.snapshot();
            await this.save(state);
          } catch {
            intent.snapshot = false;
            intent.status = "failed";
            intent.reason = "checkpoint_failed";
          }
        }
        // Stopping the container, not merely its CLI, stops compute charges.
        await this.runtime.destroy();
      }
      if (!intent.endedAt) intent.endedAt = this.now();
      // Delete credentials before touching the database. A DB outage must not
      // leave usable model/Git credentials attached to a stopped run.
      delete state.encrypted;
      await this.save(state);
      state.run = await this.db.call(
        "settle",
        state.run.user_id,
        state.run.id,
        {
          segment: state.run.segment,
          status: intent.status,
          reason: intent.reason,
          ended_at: new Date(intent.endedAt).toISOString(),
        },
      );
      state.phase = intent.snapshot ? "paused" : "terminal";
      delete state.settlement;
      await this.save(state);
      await this.storage.deleteAlarm();
      return state.run;
    } catch (error) {
      await this.save(state);
      await this.arm();
      throw error;
    }
  }
  async tick() {
    const state = await this.state();
    if (state.phase === "settling") return this.settle(state);
    if (["paused", "terminal"].includes(state.phase)) return;
    await this.arm(); // Crash-safe: a rejected I/O call still has a future alarm.
    if (!featureEnabled(this.env))
      return this.finish(state, "blocked", "global_kill_switch");
    let control;
    try {
      control = await this.db.call("control", state.run.user_id, state.run.id);
    } catch {
      return this.finish(state, "blocked", "control_unavailable");
    }
    if (!control.enabled)
      return this.finish(state, "blocked", "global_kill_switch");
    if (state.phase === "queued") {
      state.run = await this.db.call(
        "activate",
        state.run.user_id,
        state.run.id,
      );
      state.phase = "starting";
      await this.save(state);
      try {
        await this.runtime.start(state);
        state.phase = "running";
        await this.save(state);
      } catch {
        return this.finish(state, "failed", "sandbox_start_failed");
      }
      return;
    }
    // Never replay a start after a crash. The original task may have started.
    if (state.phase === "starting")
      return this.finish(state, "failed", "start_interrupted");
    if (this.now() >= Date.parse(state.run.deadline_at))
      return this.finish(state, "blocked", "hour_cap");
    if (!this.runtime.running())
      return this.finish(state, "failed", "sandbox_lost");
    let probe;
    try {
      probe = await this.collect(state);
    } catch {
      return this.finish(state, "failed", "sandbox_probe_failed");
    }
    if (probe.status === "ready_to_push" && state.phase === "running") {
      state.phase = "publishing";
      await this.save(state);
      try {
        await this.runtime.publish(state);
      } catch {
        return this.finish(state, "failed", "publish_start_failed");
      }
    } else if (probe.status === "done")
      return this.finish(state, "done", "completed");
    else if (probe.status === "waiting")
      return this.finish(state, "waiting", "idle_pause", true);
    else if (probe.status === "blocked")
      return this.finish(state, "blocked", "hour_cap");
    else if (probe.status === "failed")
      return this.finish(
        state,
        "failed",
        probe.reason === "push_failed" ? "push_failed" : "agent_failed",
      );
  }
  async reconcile(run) {
    if (await this.storage.get("run")) return this.tick();
    // Reservation succeeded but the request died before DO initialization.
    // There is no credential to recover and no safe task to replay.
    const state = { run, phase: "queued", snapshot: null, logCursor: 0 };
    await this.save(state);
    return this.finish(state, "failed", "initialization_interrupted");
  }
}
