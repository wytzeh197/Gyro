// Imported only by settings-preview.html. No simulator endpoints in the app entry.
import { useRef, useState } from "react";
import type {
  BillingActions,
  BillingSnapshot,
  BillingStatus,
} from "../../../packages/ui/src/billing-settings";
import { readBillingSnapshot } from "./billing-client";
import { BillingPortalPreview } from "./billing-portal-preview";
export const BILLING_SCENES: BillingStatus[] = [
  "signed-out",
  "no-subscription",
  "checkout-pending",
  "active",
  "cancellation-scheduled",
  "expired",
  "payment-problem",
  "exhausted",
  "offline",
  "unavailable",
];
export function billingScene(status: BillingStatus): BillingSnapshot {
  return {
    status,
    simulation: true,
    fetchedAt: status === "offline" ? "2026-10-30T12:00:00Z" : undefined,
    cancellationAt:
      status === "cancellation-scheduled" ? "2026-12-01T00:00:00Z" : undefined,
    accessUntil: status === "active" ? "2026-12-01T00:00:00Z" : undefined,
    accountLabel: ["signed-out", "unavailable"].includes(status)
      ? undefined
      : "preview@example.test",
    plan: [
      "signed-out",
      "unavailable",
      "no-subscription",
      "checkout-pending",
    ].includes(status)
      ? undefined
      : "plus",
    usage: [
      "active",
      "exhausted",
      "offline",
      "cancellation-scheduled",
    ].includes(status)
      ? [
          {
            periodId: "fixture",
            grantedMicros: 50000,
            spentMicros: status === "exhausted" ? 50000 : 10000,
            reservedMicros: status === "exhausted" ? 0 : 5000,
            availableMicros: status === "exhausted" ? 0 : 35000,
          },
        ]
      : undefined,
  };
}
export function useBillingPreview() {
  const [snapshot, setSnapshot] = useState<BillingSnapshot>(
    billingScene("signed-out"),
  );
  const [email, setEmail] = useState("preview@example.test");
  const [flow, setFlow] = useState<"subscribe" | "restore">();
  const [busy, setBusy] = useState(false);
  const [portal, setPortal] = useState(false);
  const token = useRef("");
  const intent = useRef<{ intentId: string; secret: string }>();
  const generation = useRef(0);
  const request = async (path: string, body?: unknown) => {
    const epoch = generation.current;
    if (!import.meta.env.DEV)
      throw new Error("Local simulation is only available in development.");
    const response = await fetch(`/__gyro-cloud${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token.current ? { Authorization: `Bearer ${token.current}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (epoch !== generation.current)
      throw new Error("Discarded outdated simulation response");
    if (!response.ok)
      throw new Error(
        value.error?.message ??
          "Local simulator unavailable. Start gyro-cloud on port 4340.",
      );
    return value;
  };
  const run = async (action: () => Promise<void>) => {
    const epoch = generation.current;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      if (epoch === generation.current)
        setSnapshot((s) => ({
          ...s,
          status: token.current ? "offline" : s.status,
          error: e instanceof Error ? e.message : String(e),
        }));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const refresh = async () => {
    const epoch = generation.current;
    const value = await readBillingSnapshot("/__gyro-cloud", token.current);
    if (epoch === generation.current)
      setSnapshot({ ...value, accountLabel: email });
  };
  const actions: BillingActions = {
    manage: !token.current && snapshot.plan ? () => setPortal(true) : undefined,
    subscribe: (plan) =>
      void run(async () => {
        const created = await request("/v1/subscription-intents", { plan });
        if (
          typeof created.intentId !== "string" ||
          typeof created.secret !== "string"
        )
          throw new Error("Invalid subscription intent");
        intent.current = { intentId: created.intentId, secret: created.secret };
        setSnapshot({ ...billingScene("signed-out"), plan });
        setFlow("subscribe");
      }),
    restore: () => setFlow("restore"),
    refresh: token.current ? () => void run(refresh) : undefined,
    signOut: () => {
      generation.current++;
      setBusy(false);
      token.current = "";
      intent.current = undefined;
      setFlow(undefined);
      setSnapshot(billingScene("signed-out"));
    },
    finishCheckout: () =>
      void run(async () => {
        await request("/_dev/checkout", {});
        await refresh();
      }),
    abandonCheckout: () => {
      generation.current++;
      setBusy(false);
      intent.current = undefined;
      setFlow(undefined);
      setSnapshot((s) => ({
        ...s,
        status: token.current ? "no-subscription" : "signed-out",
      }));
    },
  };
  const accountForm = flow ? (
    <form
      className="gyro-settings-preview-account-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const result = await request("/_dev/identity", {
            email,
            restore: flow === "restore",
          });
          if (typeof result.token !== "string" || result.simulation !== true)
            throw new Error("Invalid simulator identity");
          token.current = result.token;
          if (flow === "restore") {
            await refresh();
          } else {
            const setup = await request("/v1/accounts", intent.current);
            if (setup.next === "account") await refresh();
            else
              setSnapshot({
                ...billingScene("checkout-pending"),
                accountLabel: email,
              });
          }
          setFlow(undefined);
        });
      }}
    >
      <strong>
        Local simulated {flow === "restore" ? "sign-in" : "account setup"}
      </strong>
      <p>Use a synthetic @example.test address. No real account is created.</p>
      <input
        aria-label="Test account email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        required
      />
      <button disabled={busy} type="submit">
        Continue
      </button>
      <button
        type="button"
        onClick={() => {
          generation.current++;
          setBusy(false);
          setFlow(undefined);
          intent.current = undefined;
        }}
      >
        Cancel
      </button>
    </form>
  ) : null;
  return {
    snapshot,
    actions,
    accountForm: (
      <>
        {accountForm}
        {portal ? (
          <BillingPortalPreview
            snapshot={snapshot}
            onClose={() => setPortal(false)}
            onChange={(patch) => setSnapshot((s) => ({ ...s, ...patch }))}
          />
        ) : null}
      </>
    ),
    busy,
    setScene: (status: BillingStatus) => {
      generation.current++;
      setBusy(false);
      setFlow(undefined);
      setPortal(false);
      token.current = "";
      setSnapshot(billingScene(status));
    },
    cancel: () =>
      void run(async () => {
        await request("/_dev/cancel", {});
        await refresh();
      }),
  };
}
