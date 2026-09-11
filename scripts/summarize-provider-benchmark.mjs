import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: node scripts/summarize-provider-benchmark.mjs BENCHMARK_ROOT OUTPUT_DIRECTORY",
  );
const root = resolve(input),
  destination = resolve(output);
const names = (await readdir(root))
  .filter((name) => /^benchmark-(xai|openai|anthropic)\.json$/.test(name))
  .sort();
const raw = (
  await Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(join(root, name), "utf8")),
    ),
  )
).flatMap((report) => report.records);
const excluded = raw.filter((r) => r.failureDetail?.includes("safety limit"));
const records = raw
  .filter((r) => !excluded.includes(r))
  .map((r) => {
    // The initial harness predated the underscore spelling in Claude's 401 error.
    const auth = /401 authentication_failed/i.test(r.failureDetail ?? "");
    const { failureDetail, ...safe } = r;
    return {
      ...safe,
      ...(auth
        ? {
            outcome: "unavailable",
            failureClass: "authentication",
            attemptedOutcome: r.outcome,
          }
        : {}),
    };
  });
const timingPath = join(root, "logs", "timings");
const traces = await Promise.all(
  (await readdir(timingPath))
    .filter((n) => n.startsWith("backend-"))
    .map(async (name) =>
      JSON.parse(await readFile(join(timingPath, name), "utf8")),
    ),
);
const byTurn = new Map(traces.map((t) => [t.turnId, t]));
const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
const median = (values) => {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
};
const stats = (values) => ({
  n: values.filter(Number.isFinite).length,
  medianMs: round(median(values)),
  slowestMs: values.some(Number.isFinite)
    ? round(Math.max(...values.filter(Number.isFinite)))
    : null,
});
function stages(trace) {
  const first = (stage) =>
    trace.points.find((p) => p.stage === stage)?.elapsedMs;
  const span = (start, end) =>
    first(start) == null || first(end) == null
      ? null
      : first(end) - first(start);
  const intervals = [],
    active = new Map();
  for (const p of trace.points) {
    const key = `${p.attempt}:${p.toolIndex}`;
    if (p.stage === "tool-start") active.set(key, p.elapsedMs);
    if (p.stage === "tool-end" && active.has(key)) {
      intervals.push([active.get(key), p.elapsedMs]);
      active.delete(key);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return {
    workspaceMs: span("workspace-start", "workspace-ready"),
    processSpawnMs: span("process-start", "process-spawned"),
    protocolReadinessMs: span("process-spawned", "protocol-ready"),
    firstActivityMs: first("first-activity"),
    providerPhaseMs: span("prompt-sent", "provider-complete"),
    finalizationMs: span("provider-complete", "complete"),
    toolCount: trace.points.filter((p) => p.stage === "tool-start").length,
    toolBusyMs: merged.reduce((sum, [a, b]) => sum + b - a, 0),
    openTools: active.size,
    retriesObserved: Math.max(
      0,
      Math.max(0, ...trace.points.map((p) => p.attempt)) - 1,
    ),
  };
}
const selectedTraces = [];
const capabilityTimings = [];
for (const r of records) {
  // The original fresh prompt placed a sentence period directly after the
  // requested line. Accept either punctuation interpretation, but require an
  // exact append to HEAD and no other changed or untracked files. Preserve the
  // original checker result so this methodology correction remains auditable.
  if (r.task === "follow-up" && r.sessionId && Number.isInteger(r.trial)) {
    const workspace = join(
      root,
      "workspaces",
      `${r.provider}-follow-up-${r.resumedRequested ? "resumed" : "fresh"}-${r.trial}`,
    );
    try {
      const git = (...args) =>
        execFileSync("git", args, {
          cwd: workspace,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      const baseline = git("show", "HEAD:README.md");
      const current = await readFile(join(workspace, "README.md"), "utf8");
      r.correctAsInitiallyRecorded = r.correct;
      r.correct =
        ["Mascot: heron\n", "Mascot: heron.\n"].some(
          (line) => current === baseline + line,
        ) &&
        git("diff", "--name-only", "HEAD").trim() === "README.md" &&
        git("ls-files", "--others", "--exclude-standard").trim() === "";
      r.correctnessCheck = "exact-append-rechecked";
    } catch {
      // A missing disposable fixture cannot supply new correctness evidence.
      r.correctnessRecheckUnavailable = true;
    }
  }
  let events = [];
  if (r.sessionId) {
    const text = await readFile(
      join(root, "sessions", `${r.sessionId}.jsonl`),
      "utf8",
    ).catch(() => "");
    events = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const status = events
      .filter(
        (e) =>
          e.payload?.kind === "provider-status" &&
          ["done", "failed", "cancelled"].includes(e.payload.status),
      )
      .at(-1);
    if (!r.turnId && r.outcome === "failed" && status) r.turnId = status.turnId;
    if (status && status.turnId === r.turnId) {
      r.nativeStatus = status.payload.status;
      r.nativeRecoveryKind = status.payload.recoveryKind ?? null;
    }
    // Status envelopes carry default resume/retry fields. The durable provider
    // response is authoritative for the actual runner result.
    const response = events.find(
      (e) => e.turnId === r.turnId && e.payload?.kind === "provider-response",
    );
    r.durableResponsePresent = !!response?.message?.trim();
    if (response) {
      r.resumedActual = response.payload.resumed ?? null;
      r.retryCount = response.payload.retryCount ?? null;
      r.resumeMetadataSource = "provider-response";
      const previous = events
        .filter(
          (e) =>
            e.turnId !== r.turnId && e.payload?.kind === "provider-response",
        )
        .at(-1);
      if (r.resumedRequested && previous)
        r.resumeCursorPreserved =
          !!response.payload.resumeCursor?.sessionId &&
          response.payload.resumeCursor.sessionId ===
            previous.payload.resumeCursor?.sessionId;
    }
    const context = events.find(
      (e) => e.turnId === r.turnId && e.payload?.kind === "workspace-context",
    );
    if (context)
      r.fixtureCleanAtStart =
        context.payload.check?.git?.available === true &&
        context.payload.check.git.dirtyCount === 0 &&
        !context.payload.check.git.conflicted;
    const proposals = new Map();
    for (const e of events.filter(
      (e) => e.turnId === r.turnId && e.payload?.kind === "mutation-approval",
    )) {
      if (e.payload.proposalId)
        proposals.set(e.payload.proposalId, e.payload.status);
    }
    r.pendingProposalCount = [...proposals.values()].filter(
      (status) => status === "pending",
    ).length;
    if (r.outcome === "completed" && !r.correct)
      r.correctnessFailure = r.pendingProposalCount
        ? "pending-workspace-proposal"
        : "verification-failed";
  }
  const t = byTurn.get(r.turnId);
  if (t) {
    r.timing = stages(t);
    r.timing.toolSource = "protocol";
    // Early Codex traces missed MCP item boundaries. Recover those measurements
    // from the existing capability ledger; never interpret missing hooks as zero work.
    if (r.provider === "openai" && r.timing.toolCount === 0) {
      const active = new Map(),
        intervals = [];
      for (const e of events.filter(
        (e) => e.turnId === r.turnId && e.payload?.kind === "capability-call",
      )) {
        const { callId, status } = e.payload;
        if (status === "running") active.set(callId, Date.parse(e.createdAt));
        else if (
          ["completed", "failed", "cancelled", "denied"].includes(status) &&
          active.has(callId)
        ) {
          intervals.push([active.get(callId), Date.parse(e.createdAt)]);
          active.delete(callId);
        }
      }
      intervals.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [start, end] of intervals) {
        const last = merged.at(-1);
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      r.timing.toolCount =
        intervals.length || active.size ? intervals.length + active.size : null;
      r.timing.toolBusyMs = intervals.length
        ? merged.reduce((sum, [a, b]) => sum + b - a, 0)
        : null;
      r.timing.openTools = active.size;
      r.timing.toolSource =
        intervals.length || active.size
          ? "capability-ledger-wall-clock"
          : "unmeasured";
      capabilityTimings.push({
        turnId: r.turnId,
        toolBusyMs: r.timing.toolBusyMs,
        openTools: active.size,
        durationsMs: intervals.map(([a, b]) => b - a),
      });
    }
    selectedTraces.push(t);
  }
}
const groups = [];
for (const provider of ["xai", "openai", "anthropic"])
  for (const task of ["readme", "code", "follow-up"])
    for (const resumed of [false, true]) {
      const rows = records.filter(
        (r) =>
          r.provider === provider &&
          r.task === task &&
          r.resumedRequested === resumed,
      );
      const completed = rows.filter((r) => r.outcome === "completed");
      groups.push({
        provider,
        task,
        session: resumed ? "resumed" : "fresh",
        slots: rows.length,
        completed: completed.length,
        correct: completed.filter((r) => r.correct && r.responsePresent).length,
        unavailable: rows.filter((r) => r.outcome === "unavailable").length,
        failed: rows.filter(
          (r) => r.outcome === "failed" || r.outcome === "setup-failed",
        ).length,
        incorrect: completed.filter((r) => !r.correct || !r.responsePresent)
          .length,
        retries: rows.reduce(
          (sum, r) => sum + (r.retryCount ?? r.timing?.retriesObserved ?? 0),
          0,
        ),
        actualResumes: rows.filter((r) => r.resumedActual === true).length,
        correctTiming: stats(
          completed
            .filter((r) => r.correct && r.responsePresent)
            .map((r) => r.wallMs),
        ),
        ...stats(completed.map((r) => r.wallMs)),
      });
    }
const stageSummary = {};
for (const provider of ["xai", "openai"]) {
  const samples = records
    .filter(
      (r) => r.provider === provider && r.outcome === "completed" && r.timing,
    )
    .map((r) => r.timing);
  stageSummary[provider] = Object.fromEntries(
    [
      "workspaceMs",
      "processSpawnMs",
      "protocolReadinessMs",
      "firstActivityMs",
      "providerPhaseMs",
      "finalizationMs",
      "toolBusyMs",
    ].map((key) => [key, stats(samples.map((s) => s[key]))]),
  );
  stageSummary[provider].tools = {
    median: median(samples.map((s) => s.toolCount)),
    max: samples.length ? Math.max(...samples.map((s) => s.toolCount)) : null,
    open: samples.reduce((sum, s) => sum + s.openTools, 0),
  };
}
await mkdir(destination, { recursive: true });
await writeFile(
  join(destination, "capability-timings.json"),
  JSON.stringify(capabilityTimings, null, 2) + "\n",
);
await writeFile(
  join(destination, "measurements.json"),
  JSON.stringify(
    {
      schema: "gyro.benchmark.summary.v1",
      generatedAt: new Date().toISOString(),
      fixture: "meridian-v1",
      build: "debug",
      frontendMeasured: false,
      expectedSlots: 90,
      recordedSlots: records.length,
      excludedRateGuardRecords: excluded.length,
      groups,
      stageSummary,
      records,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(destination, "backend-traces.json"),
  JSON.stringify(selectedTraces, null, 2) + "\n",
);
const seconds = (n) => (n == null ? "—" : (n / 1000).toFixed(2));
const table = [
  "| Provider | Task | Session | Completed / slots | Correct | Median s | Slowest s | Failed | Unavailable | Retries |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ...groups.map(
    (g) =>
      `| ${g.provider} | ${g.task} | ${g.session} | ${g.completed}/${g.slots} | ${g.correct} | ${seconds(g.medianMs)} | ${seconds(g.slowestMs)} | ${g.failed} | ${g.unavailable} | ${g.retries} |`,
  ),
];
await writeFile(join(destination, "results-table.md"), table.join("\n") + "\n");
console.log(
  JSON.stringify(
    {
      recorded: records.length,
      completed: records.filter((r) => r.outcome === "completed").length,
      unavailable: records.filter((r) => r.outcome === "unavailable").length,
      failed: records.filter(
        (r) => r.outcome === "failed" || r.outcome === "setup-failed",
      ).length,
    },
    null,
    2,
  ),
);
