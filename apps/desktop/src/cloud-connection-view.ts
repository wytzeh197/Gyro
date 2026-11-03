import type { BillingSnapshot } from "../../../packages/ui/src/billing-settings";

export type CloudView = {
  environment?: "staging" | "local" | "production";
  contractVersion?: "2.0.0";
  rememberSession?: boolean;
  authStage?: "email" | "proof" | null;
  state:
    | "unconfigured"
    | "signed-out"
    | "verifying"
    | "connected"
    | "offline"
    | "expired";
  lastVerified: string | null;
  revocationPending: boolean;
  snapshot: null | {
    expiresAt: string;
    account: {
      id: string;
      emailVerified: boolean;
      status: "enabled" | "disabled";
    };
    subscription: {
      state:
        | "none"
        | "checkout-pending"
        | "active"
        | "cancellation-scheduled"
        | "payment-problem"
        | "expired"
        | "revoked"
        | "disputed";
      planId: string | null;
      scheduledPlan?: string | null;
      periodId?: string | null;
      paidThrough: string | null;
      renewalAt: string | null;
      cancellationAt: string | null;
    };
    capabilities: Record<
      "managedAi" | "selectedSync" | "backup" | "sharing",
      { allowed: boolean; reason: string }
    >;
    currentPeriod?: null | {
      id: string;
      grantedMicros: number;
      spentMicros: number;
      reservedMicros: number;
      availableMicros: number;
    };
    limits?: {
      devices: number;
      storageBytes: number;
      historyDays: number;
      activeLinks: number;
      concurrentJobs: number;
      uploadBytesPerMonth: number;
      downloadBytesPerMonth: number;
    };
    usage?: {
      managedAi: {
        unit: "percent";
        used: number;
        held: number;
        remaining: number;
        resetAt: string | null;
      };
      storage: { usedBytes: number; reservedBytes: number; limitBytes: number };
    };
  };
};
export const disconnectedCloudView: CloudView = {
  state: "unconfigured",
  lastVerified: null,
  revocationPending: false,
  snapshot: null,
};
export const isV2CloudView = (view: CloudView) =>
  view.contractVersion === "2.0.0" &&
  (view.environment === "production" || view.environment === "staging");

// Display only. Native validation owns freshness and identity; the server owns
// every paid request. No browser wallet arithmetic or local capability gate.
export function cloudBillingView(view: CloudView): BillingSnapshot {
  const snapshot = view.state === "expired" ? null : view.snapshot,
    sub = snapshot?.subscription;
  let status: BillingSnapshot["status"] = "unavailable";
  if (view.state === "signed-out") status = "signed-out";
  else if (view.state === "verifying") status = "checking";
  else if (view.state === "offline") status = "offline";
  else if (view.state === "expired") status = "signed-out";
  else if (view.state === "connected" && sub) {
    status =
      sub.state === "none"
        ? "no-subscription"
        : sub.state === "revoked"
          ? "expired"
          : sub.state;
    if (
      status === "active" &&
      snapshot?.capabilities.managedAi.reason === "exhausted"
    )
      status = "exhausted";
  }
  return {
    status,
    simulation:
      view.state !== "unconfigured" &&
      view.environment !== "staging" &&
      view.environment !== "production",
    productionCloud:
      view.contractVersion === "2.0.0" && view.environment === "production",
    cloudV2: isV2CloudView(view),
    ...(isV2CloudView(view) && snapshot && sub?.planId
      ? {
          billingIdentity: `${snapshot.account.id}:${sub.periodId ?? sub.paidThrough ?? sub.planId}`,
        }
      : {}),
    rememberSession: view.rememberSession,
    ...(isV2CloudView(view) && snapshot
      ? { cloudCapabilities: snapshot.capabilities }
      : {}),
    ...(isV2CloudView(view) && snapshot?.limits
      ? { limits: snapshot.limits, cloudUsage: snapshot.usage }
      : {}),
    staging: view.environment === "staging",
    ...(view.authStage ? { authStage: view.authStage } : {}),
    ...(view.state === "verifying"
      ? {
          accountLabel:
            view.environment === "production"
              ? "Connecting to Gyro Cloud"
              : view.environment === "staging" && isV2CloudView(view)
                ? "Connecting to Gyro Cloud staging"
                : view.environment === "staging"
                  ? "Connecting to Gyro staging"
                  : "Connecting to local simulation",
        }
      : snapshot && view.state !== "expired"
        ? {
            accountLabel:
              view.environment === "production"
                ? "Signed in to Gyro Cloud"
                : view.environment === "staging" && isV2CloudView(view)
                  ? "Signed in to Gyro Cloud staging"
                  : view.environment === "staging"
                    ? "Signed in to Gyro staging"
                    : "Synthetic account · local simulation",
          }
        : {}),
    ...(sub?.planId === "lite" ||
    sub?.planId === "plus" ||
    sub?.planId === "premium"
      ? { plan: sub.planId }
      : {}),
    ...(sub?.scheduledPlan === "plus" || sub?.scheduledPlan === "premium"
      ? { scheduledPlan: sub.scheduledPlan }
      : {}),
    ...(sub?.paidThrough ? { accessUntil: sub.paidThrough } : {}),
    ...(sub?.renewalAt ? { renewalAt: sub.renewalAt } : {}),
    ...(sub?.state === "cancellation-scheduled" && sub.paidThrough
      ? { cancellationAt: sub.paidThrough }
      : {}),
    ...(snapshot?.currentPeriod
      ? {
          usage: [
            { ...snapshot.currentPeriod, periodId: snapshot.currentPeriod.id },
          ],
        }
      : {}),
    ...(view.lastVerified ? { fetchedAt: view.lastVerified } : {}),
    ...(view.revocationPending
      ? {
          error:
            view.state === "signed-out" ||
            view.state === "expired" ||
            view.state === "unconfigured"
              ? "Signed out locally. Remote session revocation is not confirmed."
              : "Remote revocation of an earlier Cloud session is not confirmed.",
        }
      : {}),
  };
}
