import { CreditCard } from "lucide-react";
import { useState } from "react";
import { SettingsSection } from "./settings-presentation";
import { SettingsGroup, SettingsRow } from "./settings-controls";
import type { CloudServicesActions } from "./cloud-services-settings";
import {
  CLOUD_SIGNIN_PROOF_MAX_LENGTH,
  CLOUD_SIGNIN_PROOF_PATTERN,
  isCloudSignInProof,
} from "./cloud-auth-proof";

export type BillingStatus =
  | "checking"
  | "signed-out"
  | "no-subscription"
  | "checkout-pending"
  | "active"
  | "cancellation-scheduled"
  | "expired"
  | "payment-problem"
  | "disputed"
  | "exhausted"
  | "offline"
  | "unavailable";
export type BillingSnapshot = {
  status: BillingStatus;
  simulation?: boolean;
  staging?: boolean;
  productionCloud?: boolean;
  cloudV2?: boolean;
  rememberSession?: boolean;
  cloudCapabilities?: Partial<
    Record<
      "managedAi" | "selectedSync" | "backup" | "sharing",
      { allowed: boolean; reason: string }
    >
  >;
  authStage?: "email" | "proof";
  accountLabel?: string;
  plan?: "lite" | "plus" | "premium";
  limits?: {
    devices: number;
    storageBytes: number;
    historyDays: number;
    activeLinks: number;
    concurrentJobs: number;
    uploadBytesPerMonth: number;
    downloadBytesPerMonth: number;
  };
  cloudUsage?: {
    managedAi: {
      unit: "percent";
      used: number;
      held: number;
      remaining: number;
      resetAt: string | null;
    };
    storage: { usedBytes: number; reservedBytes: number; limitBytes: number };
  };
  accessUntil?: string;
  renewalAt?: string;
  cancellationAt?: string;
  invoiceAmount?: string;
  usage?: {
    periodId: string;
    grantedMicros: number;
    spentMicros: number;
    reservedMicros: number;
    availableMicros: number;
  }[];
  error?: string;
  fetchedAt?: string;
};
export type BillingActions = {
  requestSignin?: (email: string, remember?: boolean) => Promise<void>;
  verifySignin?: (proof: string) => Promise<void>;
  mockManagedRequest?: () => void;
  subscribe?: (plan: "lite" | "plus" | "premium") => void;
  cloud?: CloudServicesActions;
  restore?: () => void;
  signOut?: () => void;
  refresh?: () => void;
  manage?: () => void;
  finishCheckout?: () => void;
  abandonCheckout?: () => void;
  simulateManagedRequest?: () => void;
  simulateCancellation?: () => void;
  simulateExpiry?: () => void;
};
const statusLabels: Record<BillingStatus, string> = {
  checking: "Checking Cloud connection",
  "signed-out": "Free local app",
  "no-subscription": "No active subscription",
  "checkout-pending": "Checkout pending",
  active: "Subscription active",
  "cancellation-scheduled": "Cancellation scheduled",
  expired: "Subscription expired",
  "payment-problem": "Payment needs attention",
  disputed: "Cloud access paused after a billing dispute",
  exhausted: "Managed allowance used",
  offline: "Cannot refresh subscription",
  unavailable: "Gyro Cloud is not available in this build",
};
const money = (micros: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(micros / 1_000_000);
export function CloudConnectionSettings({
  snapshot,
  actions,
  showAccount = true,
}: {
  snapshot: BillingSnapshot;
  actions: BillingActions;
  showAccount?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [proof, setProof] = useState("");
  const [remember, setRemember] = useState(false);
  const modernCloud = snapshot.cloudV2 || snapshot.productionCloud;
  const issue =
    ["payment-problem", "offline"].includes(snapshot.status) ||
    !!snapshot.error;
  return (
    <>
      <div
        className="gyro-settings-page-status"
        role={issue ? "alert" : "status"}
      >
        <strong>{statusLabels[snapshot.status]}</strong>
        {snapshot.simulation ? (
          <span> · Local simulation — no real payment or allowance</span>
        ) : null}
        {snapshot.staging ? (
          <span>
            {modernCloud
              ? " · Staging — test payments, managed AI disabled"
              : " · Staging — test payments, mock AI"}
          </span>
        ) : null}
        {snapshot.error ? <p>{snapshot.error}</p> : null}
        {snapshot.status === "offline" && snapshot.fetchedAt ? (
          <p>
            Last confirmed {new Date(snapshot.fetchedAt).toLocaleString()}.
            These values are stale; paid access must be rechecked by the
            service.
          </p>
        ) : null}
        {snapshot.status === "checkout-pending" ? (
          <p>Checkout does not grant access until the service confirms it.</p>
        ) : null}
        {actions.refresh ? (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={actions.refresh}
          >
            Refresh status
          </button>
        ) : null}
      </div>
      {(snapshot.staging || modernCloud) && snapshot.authStage ? (
        <SettingsGroup
          id="staging-signin"
          label={
            snapshot.productionCloud
              ? "Sign in to Gyro Cloud"
              : "Sign in to Gyro staging"
          }
          summary="Email verification; no access is granted by signing in"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (snapshot.authStage === "proof") {
                if (!isCloudSignInProof(proof)) return;
                const value = proof;
                setProof("");
                void actions.verifySignin?.(value);
              } else {
                void actions.requestSignin?.(email.trim(), remember);
              }
            }}
          >
            <label>
              Email{" "}
              <input
                type="email"
                aria-label="Gyro email"
                autoComplete="email"
                value={email}
                maxLength={254}
                required
                disabled={
                  snapshot.status === "checking" ||
                  snapshot.authStage === "proof"
                }
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </label>
            {snapshot.authStage === "proof" ? (
              <label>
                Sign-in link or code{" "}
                <input
                  type="password"
                  aria-label="Sign-in link or code"
                  autoComplete="one-time-code"
                  maxLength={CLOUD_SIGNIN_PROOF_MAX_LENGTH}
                  pattern={CLOUD_SIGNIN_PROOF_PATTERN}
                  title="Enter the six- or eight-digit email code, or paste the original sign-in link."
                  required
                  value={proof}
                  onChange={(event) => setProof(event.currentTarget.value)}
                  placeholder="Paste the original link or six- or eight-digit code"
                />
              </label>
            ) : null}
            <p>
              {snapshot.authStage === "proof"
                ? "Enter the six- or eight-digit code from your email, or copy its original link without opening it and paste it here. The native app exchanges it securely; tokens stay out of this page."
                : modernCloud
                  ? "Sign in only when you want optional Cloud services. Local work needs no account."
                  : "Use your Supabase project-team email for this staging test."}
            </p>
            {modernCloud && snapshot.authStage === "email" ? (
              <label>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.currentTarget.checked)}
                />{" "}
                Remember this Cloud session in macOS Keychain
              </label>
            ) : null}
            <div className="gyro-settings-transfer-actions">
              <button
                type="submit"
                className="gyro-primary-button"
                disabled={
                  snapshot.status === "checking" ||
                  (snapshot.authStage === "proof" && !isCloudSignInProof(proof))
                }
              >
                {snapshot.authStage === "proof"
                  ? "Verify sign-in"
                  : "Send sign-in email"}
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.signOut}
              >
                Return to local Gyro
              </button>
            </div>
          </form>
        </SettingsGroup>
      ) : null}
      {showAccount ? (
        <SettingsGroup
          id="gyro-account"
          label="Gyro account"
          summary={snapshot.accountLabel ?? "No account required for local use"}
        >
          <SettingsRow
            label="Account"
            detail="Signing out of Gyro leaves provider logins and local work intact."
            value={snapshot.accountLabel ?? "Not signed in"}
          />
          <div className="gyro-settings-transfer-actions">
            {!snapshot.accountLabel && actions.restore ? (
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.restore}
              >
                Sign in / Restore subscription
              </button>
            ) : null}
            {snapshot.accountLabel && actions.signOut ? (
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.signOut}
              >
                Sign out of Gyro
              </button>
            ) : null}
          </div>
        </SettingsGroup>
      ) : null}
    </>
  );
}

export function BillingSettings({
  snapshot = { status: "unavailable" },
  actions = {},
  onOpenCloud,
}: {
  snapshot?: BillingSnapshot;
  actions?: BillingActions;
  onOpenCloud?: () => void;
}) {
  const [planChangeMessage, setPlanChangeMessage] = useState("");
  const [changingPlan, setChangingPlan] = useState(false);
  const modernCloud = snapshot.cloudV2 || snapshot.productionCloud;
  const modernOffer =
    modernCloud || (!snapshot.staging && !snapshot.simulation);
  return (
    <SettingsSection
      icon={CreditCard}
      title="Plan & billing"
      description="Your optional Gyro subscription. Local work and your own providers remain available without an account."
    >
      <CloudConnectionSettings
        snapshot={snapshot}
        actions={actions}
        showAccount={false}
      />
      <SettingsGroup
        id="subscription"
        label="Subscription"
        summary={
          snapshot.plan === "premium"
            ? "Gyro Premium"
            : snapshot.plan === "plus"
              ? "Gyro Plus"
              : snapshot.plan === "lite"
                ? "Gyro Cloud"
                : "Free local app"
        }
      >
        <p>
          The complete local app stays free.{" "}
          {modernCloud
            ? "Cloud services are optional. Availability and remaining limits are verified by the service."
            : "Optional services are being prepared; features and included allowances are not final."}
        </p>
        {planChangeMessage ? <p role="status">{planChangeMessage}</p> : null}
        <div className="gyro-billing-plans">
          {(modernOffer
            ? [
                { id: "plus", name: "Gyro Plus", price: "€15" },
                { id: "premium", name: "Gyro Premium", price: "€49" },
              ]
            : [
                { id: "lite", name: "Gyro Cloud", price: "$10" },
                { id: "plus", name: "Gyro Plus", price: "$40" },
              ]
          ).map(({ id, name, price }) => (
            <article key={id}>
              <h3>{name}</h3>
              {modernCloud ? (
                <p>
                  <strong>{price}/month</strong> · VAT included
                  {snapshot.staging ? " · sandbox price, no real charge" : ""}
                </p>
              ) : snapshot.staging ? (
                <p>
                  <strong>{id === "lite" ? "$1" : "$2"}/month</strong> · sandbox
                  fixture
                </p>
              ) : snapshot.simulation ? (
                <p>
                  <strong>{price}/month</strong> · planning value
                </p>
              ) : null}
              <p>
                {modernOffer
                  ? id === "plus"
                    ? "2 devices · 2 GB including retained versions · 30 days of history · 10 active report links · 1 managed request at a time."
                    : "5 devices · 20 GB including retained versions · 90 days of history · 100 active report links · 2 managed requests at a time."
                  : snapshot.staging
                    ? "Test billing and a $0.05 mock AI balance. This is not the launch offer. Sync, backup and sharing are unavailable."
                    : id === "lite"
                      ? "Optional continuity, selected-data backup and report sharing."
                      : "Cloud services and a larger managed AI allowance for supported Gyro tasks."}
              </p>
              {actions.subscribe ? (
                <button
                  type="button"
                  className="gyro-secondary-button"
                  onClick={() =>
                    actions.subscribe!(id as "lite" | "plus" | "premium")
                  }
                >
                  Subscribe to {name}
                </button>
              ) : modernCloud &&
                actions.cloud &&
                snapshot.plan !== id &&
                ["active", "cancellation-scheduled", "exhausted"].includes(
                  snapshot.status,
                ) ? (
                <button
                  type="button"
                  className="gyro-secondary-button"
                  disabled={changingPlan}
                  onClick={() => {
                    setChangingPlan(true);
                    setPlanChangeMessage(
                      "Scheduling the change for your next renewal…",
                    );
                    void actions
                      .cloud!.request({
                        operation: "service",
                        command: {
                          operation: "schedule-plan",
                          planId: id,
                          requestId: crypto.randomUUID(),
                        },
                      })
                      .then(() =>
                        setPlanChangeMessage(
                          "Plan change scheduled for the next renewal. Your current plan and usage remain in place until then.",
                        ),
                      )
                      .catch((error) =>
                        setPlanChangeMessage(
                          `Could not confirm the plan change. Refresh status before trying again. ${String(error)}`,
                        ),
                      )
                      .finally(() => setChangingPlan(false));
                  }}
                >
                  Change at next renewal
                </button>
              ) : (
                <span>
                  {modernCloud && snapshot.plan === id
                    ? "Current plan"
                    : snapshot.staging && snapshot.plan === id
                      ? "Current test plan"
                      : snapshot.staging && snapshot.plan
                        ? "Plan changes are unavailable in this test"
                        : "Not available yet"}
                </span>
              )}
            </article>
          ))}
        </div>
        {snapshot.accessUntil ? (
          <SettingsRow
            label="Access valid until"
            detail="Reported by the service; this is not a renewal date."
            value={new Date(snapshot.accessUntil).toLocaleString()}
          />
        ) : null}
        {snapshot.renewalAt ? (
          <SettingsRow
            label="Next renewal"
            detail="Reported by billing."
            value={new Date(snapshot.renewalAt).toLocaleDateString()}
          />
        ) : null}
        {snapshot.cancellationAt ? (
          <SettingsRow
            label="Access ends"
            detail="Cancellation confirmed by billing."
            value={new Date(snapshot.cancellationAt).toLocaleDateString()}
          />
        ) : null}
        {snapshot.status === "checkout-pending" ? (
          <div className="gyro-settings-transfer-actions">
            {actions.finishCheckout ? (
              <button
                type="button"
                className="gyro-primary-button"
                onClick={actions.finishCheckout}
              >
                {snapshot.productionCloud
                  ? "Open secure checkout"
                  : snapshot.staging
                    ? "Open test checkout"
                    : "Complete simulated checkout"}
              </button>
            ) : null}
            {actions.abandonCheckout ? (
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.abandonCheckout}
              >
                Return to local Gyro
              </button>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>
      {!modernCloud ? (
        <SettingsGroup
          id="managed-usage"
          label="Managed usage"
          summary={
            snapshot.usage?.length
              ? `${snapshot.usage.length === 1 ? `${money(snapshot.usage[0]!.availableMicros)} available` : `${snapshot.usage.length} service periods reported`}${snapshot.status === "offline" ? " · stale" : ""}`
              : "No managed usage reported"
          }
        >
          <p>
            Gyro-managed usage is separate from your own provider subscriptions
            and local token estimates.
          </p>
          {snapshot.staging && actions.mockManagedRequest ? (
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={actions.mockManagedRequest}
            >
              Run mock AI request
            </button>
          ) : null}
          {snapshot.usage?.length ? (
            snapshot.usage.map((wallet) => (
              <div key={wallet.periodId}>
                {snapshot.usage!.length > 1 ? (
                  <h3>Service period: {wallet.periodId}</h3>
                ) : null}
                <SettingsRow
                  label="Included allowance"
                  detail="Reported for this service period."
                  value={money(wallet.grantedMicros)}
                />
                <SettingsRow
                  label="Settled usage"
                  detail="Usage confirmed by the service."
                  value={money(wallet.spentMicros)}
                />
                <SettingsRow
                  label="Pending reservations"
                  detail="Held while requests are being resolved."
                  value={money(wallet.reservedMicros)}
                />
                <SettingsRow
                  label="Available"
                  detail="Reported by the service; never calculated from the local ledger."
                  value={money(wallet.availableMicros)}
                />
              </div>
            ))
          ) : (
            <p>
              Unavailable. Sign in when subscriptions become available to view
              server-reported usage.
            </p>
          )}
        </SettingsGroup>
      ) : null}
      {snapshot.simulation &&
      (actions.simulateManagedRequest ||
        actions.simulateCancellation ||
        actions.simulateExpiry) ? (
        <SettingsGroup
          id="cloud-connection-test"
          label="Local connection test"
          summary="Synthetic state only"
        >
          <p>
            These controls exercise the disposable local service. They make no
            payment or AI call and do not define plan allowances.
          </p>
          <div className="gyro-settings-transfer-actions">
            {actions.simulateManagedRequest ? (
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.simulateManagedRequest}
              >
                Simulate managed usage
              </button>
            ) : null}
            {actions.simulateCancellation ? (
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.simulateCancellation}
              >
                Simulate renewal cancellation
              </button>
            ) : null}
            {actions.simulateExpiry ? (
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={actions.simulateExpiry}
              >
                Simulate expiry
              </button>
            ) : null}
          </div>
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        id="billing-details"
        label="Billing details"
        summary={
          actions.manage
            ? "Payment method, invoices and subscription changes"
            : "Billing management is not available yet"
        }
      >
        {actions.manage ? (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={actions.manage}
          >
            Manage billing
          </button>
        ) : (
          <p>
            Payment methods, invoices, plan changes and cancellation will be
            managed through the billing service when it is available.
          </p>
        )}
      </SettingsGroup>
      {onOpenCloud ? (
        <SettingsGroup
          id="cloud-settings-shortcut"
          label="Gyro Cloud"
          summary="Usage, selected backups, memory and connected devices"
        >
          <p>
            Review what you send, manage hosted data and check your Cloud
            limits.
          </p>
          <div className="gyro-settings-transfer-actions">
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={onOpenCloud}
            >
              Open Gyro Cloud settings
            </button>
          </div>
        </SettingsGroup>
      ) : null}
    </SettingsSection>
  );
}
