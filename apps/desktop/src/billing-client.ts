import type { BillingSnapshot } from "../../../packages/ui/src/billing-settings";
type Fetcher = typeof fetch;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid service response");
  return value as Record<string, unknown>;
}
export async function readBillingSnapshot(
  base: string,
  token: string,
  request: Fetcher = fetch,
): Promise<BillingSnapshot> {
  const get = async (path: string) => {
    const response = await request(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Your Gyro sign-in expired. Local work is still available."
          : "The subscription service could not be reached.",
      );
    return record(await response.json());
  };
  const [account, usage] = await Promise.all([
    get("/v1/account"),
    get("/v1/usage"),
  ]);
  if (
    !["mock", "live"].includes(String(account.mode)) ||
    usage.mode !== account.mode ||
    usage.currency !== "USD" ||
    typeof account.accountId !== "string" ||
    !Array.isArray(usage.wallets) ||
    usage.wallets.length > 12
  )
    throw new Error("Invalid service response");
  const wallets = usage.wallets.map((value) => {
    const w = record(value);
    if (
      typeof w.periodId !== "string" ||
      [
        "grantedMicros",
        "spentMicros",
        "reservedMicros",
        "availableMicros",
      ].some((k) => !Number.isSafeInteger(w[k]) || Number(w[k]) < 0)
    )
      throw new Error("Invalid service usage");
    return w as NonNullable<BillingSnapshot["usage"]>[number];
  });
  const subscription =
    account.subscription === null ? undefined : record(account.subscription);
  if (
    subscription &&
    (!["lite", "plus"].includes(String(subscription.plan)) ||
      typeof subscription.valid_until !== "string" ||
      !Number.isFinite(Date.parse(subscription.valid_until)) ||
      !["test", "billing"].includes(String(subscription.source)))
  )
    throw new Error("Invalid subscription response");
  if (account.mode === "live" && subscription?.source === "test")
    throw new Error("Test subscriptions cannot grant production access.");
  const active =
    subscription && Date.parse(String(subscription.valid_until)) > Date.now();
  return {
    status: !subscription
      ? "no-subscription"
      : !active
        ? "expired"
        : wallets.length > 0 && wallets.every((w) => w.availableMicros === 0)
          ? "exhausted"
          : "active",
    simulation: account.mode === "mock",
    accountLabel: "Signed in to Gyro",
    plan: subscription?.plan as "lite" | "plus" | undefined,
    accessUntil: subscription?.valid_until as string | undefined,
    usage: wallets,
    fetchedAt: new Date().toISOString(),
  };
}
