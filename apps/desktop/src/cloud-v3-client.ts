/** Renderer-side verification of the actual v3 wire, not entitlement authority. */
export type V3Invoke = (request: Record<string, unknown>) => Promise<any>;
export const SETTINGS_CONTRACT = "3.0.0";
export const SETTINGS_POLICY = "2026-11-07-v2";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ensure(value: unknown): asserts value {
  if (!value)
    throw new Error(
      "Cloud returned an unsupported response. Refresh status before continuing.",
    );
}
function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function integer(value: unknown, positive = false) {
  ensure(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (positive ? 1 : 0),
  );
}
function text(value: unknown, maximum: number, empty = false) {
  ensure(
    typeof value === "string" &&
      value.length <= maximum &&
      (empty || value.length > 0) &&
      !/[\x00-\x1f\x7f]/.test(value),
  );
}
function uuid(value: unknown) {
  ensure(typeof value === "string" && uuidPattern.test(value));
}
function boolean(value: unknown) {
  ensure(typeof value === "boolean");
}
function timestamp(value: unknown, nullable = false) {
  if (nullable && value === null) return;
  ensure(typeof value === "string" && Number.isFinite(Date.parse(value)));
}
function list(value: unknown, maximum = 10000): unknown[] {
  ensure(Array.isArray(value) && value.length <= maximum);
  return value;
}

/** Returns the verified value unchanged: units and counters are never reinterpreted. */
export function validateV3Result(
  request: Record<string, unknown>,
  value: unknown,
): any {
  const command =
    request.operation === "service" ? record(request.command) : request;
  const operation = command.operation;
  if (operation === "pending") {
    for (const item of list(value)) {
      const p = record(item);
      uuid(p.requestId);
      text(p.label, 120);
      ensure(["project", "chat", "report", "handoff"].includes(String(p.kind)));
      boolean(p.localRunning);
      boolean(p.cancelRequested);
      if (p.cloudStatus !== undefined && p.cloudStatus !== null)
        ensure(["active", "verifying", "committed", "conflict", "cancelled", "expired", "failed"].includes(String(p.cloudStatus)));
    }
    return value;
  }
  if (operation === "phone-devices") {
    for (const item of list(value)) record(item);
    return value;
  }
  const v = record(value);
  switch (operation) {
    case "view":
      ensure(
        v.contractVersion === SETTINGS_CONTRACT &&
          v.policyVersion === SETTINGS_POLICY,
      );
      boolean(v.configured);
      boolean(v.connected);
      if (v.configured) boolean(v.registered);
      if (v.accountId !== null) uuid(v.accountId);
      break;
    case "profile":
    case "update-profile":
      uuid(v.accountId);
      uuid(v.deviceId);
      text(v.email, 320);
      ensure(String(v.email).includes("@"));
      text(v.displayName, 160, true);
      ensure(Array.from(String(v.displayName)).length <= 80);
      break;
    case "policy": {
      ensure(
        [SETTINGS_POLICY, "2026-11-06-v1"].includes(String(v.policyVersion)),
      );
      const catalog = record(v.plans);
      ensure(Object.keys(catalog).sort().join(",") === "cloud,max,plus");
      for (const id of ["cloud", "plus", "max"]) {
        const p = record(catalog[id]);
        ensure(
          p.id === id &&
            p.currency === "USD" &&
            p.priceUnit === "minor" &&
            p.taxAdded === true,
        );
        for (const field of [
          "priceMinor",
          "devices",
          "storageBytes",
          "uploadBytes",
          "downloadBytes",
          "operationsPerPeriod",
          "metadataPerMinute",
          "chunksPerMinute",
          "uploads",
        ])
          integer(p[field], true);
        for (const field of ["aiMicros", "jobs"]) integer(p[field]);
      }
      if (v.serviceLimits !== undefined) {
        const s = record(v.serviceLimits), r = record(s.recoveryOperations);
        text(s.version, 100); ensure(s.reset === "calendar-month-utc");
        for (const id of ["cloud", "plus", "max"]) integer(r[id], true);
        ensure(s.securityControlsExempt === true && s.accountExportSeparate === true);
      }
      boolean(v.proposed);
      break;
    }
    case "usage": {
      const p = record(v.policy),
        s = record(v.storage),
        t = record(v.transfer);
      ensure(
        ["cloud", "plus", "max"].includes(String(p.id)) && p.currency === "USD",
      );
      for (const field of [
        "devices",
        "storageBytes",
        "uploadBytes",
        "downloadBytes",
      ])
        integer(p[field], true);
      if (p.aiMicros !== undefined) integer(p.aiMicros);
      if (p.operationsPerPeriod !== undefined)
        integer(p.operationsPerPeriod, true);
      if (v.operations !== undefined) integer(v.operations);
      if (v.recoveryRequests !== undefined) {
        const r = record(v.recoveryRequests);
        text(r.version, 100); integer(r.used); integer(r.limit, true); timestamp(r.resetAt);
      }
      boolean(v.active);
      timestamp(v.resetAt, true);
      timestamp(v.exportUntil, true);
      for (const field of ["used", "reserved"]) integer(s[field]);
      for (const field of ["uploaded", "reserved", "downloaded"])
        integer(t[field]);
      break;
    }
    case "wallet": {
      ensure(v.currency === "USD");
      for (const field of [
        "includedMicros",
        "availableMicros",
        "spentMicros",
        "heldMicros",
      ])
        integer(v[field]);
      ensure(
        v.availableMicros ===
          Math.max(
            0,
            Number(v.includedMicros) -
              Number(v.spentMicros) -
              Number(v.heldMicros),
          ),
      );
      boolean(v.usable);
      boolean(v.checkAllowed);
      boolean(v.qualified);
      boolean(v.topUpsAvailable);
      ensure(v.topUpsAvailable === false);
      timestamp(v.resetAt, true);
      text(v.model, 200);
      break;
    }
    case "devices":
      for (const item of list(v.items)) {
        const d = record(item);
        uuid(d.id);
        text(d.label, 120);
        timestamp(d.lastSeenAt);
        timestamp(d.revokedAt, true);
      }
      break;
    case "versions":
      for (const item of list(v.items, 100)) {
        const r = record(item);
        uuid(r.id);
        uuid(r.object_id);
        if (r.head_id !== null) uuid(r.head_id);
        text(r.label, 120);
        boolean(r.conflict);
        timestamp(r.created_at);
        ensure(
          ["project", "chat", "report", "handoff"].includes(String(r.kind)),
        );
        const bytes =
          typeof r.size_bytes === "string" && /^\d+$/.test(r.size_bytes)
            ? Number(r.size_bytes)
            : r.size_bytes;
        integer(bytes, true);
        ensure(Number(bytes) <= 2e9);
        ensure(
          typeof r.sha256 === "string" && /^[0-9a-f]{64}$/i.test(r.sha256),
        );
      }
      if (v.nextCursor !== null) uuid(v.nextCursor);
      break;
    case "capabilities":
      boolean(v.phone);
      boolean(v.plusPurchase);
      if (v.cloudPurchase !== undefined) boolean(v.cloudPurchase);
      if (v.iosCompanion !== undefined) boolean(v.iosCompanion);
      break;
  }
  return value;
}

export function verifiedV3Client(call: V3Invoke): V3Invoke {
  return async (request) => validateV3Result(request, await call(request));
}

/** Local native sign-out may succeed even when a remote revocation fails. */
export async function signOutAndRefresh(
  call: V3Invoke,
  refresh: () => Promise<void>,
  changed: () => void,
) {
  let failed = false;
  try {
    await call({ operation: "sign-out" });
  } catch {
    failed = true;
  } finally {
    changed();
    await refresh();
  }
  if (failed)
    throw new Error(
      "Sign-out could not be fully confirmed. Check the connection and credential status before reconnecting.",
    );
}
