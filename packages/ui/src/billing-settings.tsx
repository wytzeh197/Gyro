import { CreditCard } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  availability?: "coming-soon";
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
  /** The signed-in address, from the verified native session. */
  accountEmail?: string;
  plan?: "lite" | "plus" | "premium";
  scheduledPlan?: "plus" | "premium";
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
  billingIdentity?: string;
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
  autoBackup?: {
    enabled: boolean;
    available: boolean;
    setEnabled: (enabled: boolean) => void;
  };

  requestSignin?: (email: string, remember?: boolean) => Promise<void>;
  verifySignin?: (proof: string) => Promise<void>;
  mockManagedRequest?: () => void;
  subscribe?: (
    plan: "lite" | "plus" | "premium",
    customerUse?: "personal" | "business",
  ) => void;
  cloud?: CloudServicesActions;
  restore?: () => void;
  signOut?: () => void;
  refresh?: () => void | Promise<void>;
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
export const planNames = {
  lite: "Gyro Cloud",
  plus: "Gyro Plus",
  premium: "Gyro Premium",
} as const;
const paidStates: BillingStatus[] = [
  "active",
  "cancellation-scheduled",
  "exhausted",
];
const offers = [
  { id: "plus", name: "Gyro Plus", price: "€15" },
  { id: "premium", name: "Gyro Premium", price: "€49" },
] as const;
const offerLimits = [
  ["Devices", "2 devices", "5 devices"],
  ["Cloud storage", "2 GB", "20 GB"],
  ["Version history", "30 days", "90 days"],
  ["Active report links", "10", "100"],
  ["Managed requests at once", "1", "2"],
  [
    "Managed tasks",
    "Memory drafts, Check planning and failure explanations",
    "Plus tasks, suggested tests, change reviews and Check comparisons",
  ],
] as const;
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
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
  showStatus = true,
  details,
  children,
}: {
  snapshot: BillingSnapshot;
  actions: BillingActions;
  showAccount?: boolean;
  showStatus?: boolean;
  details?: ReactNode;
  children?: ReactNode;
}) {
  const [email, setEmail] = useState("");
  const [proof, setProof] = useState("");
  const [remember, setRemember] = useState(false);
  if (snapshot.availability === "coming-soon") actions = {};
  const modernCloud = snapshot.cloudV2 || snapshot.productionCloud;
  const issue =
    ["payment-problem", "offline"].includes(snapshot.status) ||
    !!snapshot.error;
  return (
    <>
      {showStatus ? (
        <div
          className="gyro-settings-page-status gyro-cloud-overview"
          role={issue ? "alert" : "status"}
        >
          <strong>
            {snapshot.plan && paidStates.includes(snapshot.status)
              ? `${planNames[snapshot.plan]} · ${statusLabels[snapshot.status]}`
              : snapshot.availability === "coming-soon"
                ? "Account & Cloud · Coming soon"
                : statusLabels[snapshot.status]}
          </strong>
          {snapshot.availability === "coming-soon" ? (
            <p>
              Sign-in, subscriptions and hosted features are not enabled yet.
              Local work and your own providers remain available.
            </p>
          ) : null}
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
          {details}
          <div className="gyro-settings-transfer-actions">
            {children}
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
        </div>
      ) : null}
      {showStatus &&
      snapshot.availability !== "coming-soon" &&
      (snapshot.staging || modernCloud) &&
      snapshot.authStage ? (
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
            value={
              (snapshot.accountLabel && snapshot.accountEmail) ||
              (snapshot.accountLabel ?? "Not signed in")
            }
          />
          {(!snapshot.accountLabel && actions.restore) ||
          (snapshot.accountLabel && actions.signOut) ? (
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
          ) : null}
        </SettingsGroup>
      ) : null}
    </>
  );
}

const cardNames = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  unknown: "Card",
} as const;
type CardBrand = keyof typeof cardNames;
type PaidCard = { brand: CardBrand; last4: string };
function LastPayment({
  request,
  refreshCount,
  sandbox,
}: {
  request: CloudServicesActions["request"];
  refreshCount: number;
  sandbox?: boolean;
}) {
  const latestRequest = useRef(request);
  useEffect(() => {
    latestRequest.current = request;
  }, [request]);
  const [payment, setPayment] = useState<
    PaidCard | "loading" | "unavailable" | null
  >("loading");
  useEffect(() => {
    let cancelled = false;
    setPayment("loading");
    void latestRequest
      .current({ operation: "service", command: { operation: "last-payment" } })
      .then(({ card, unavailable }) => {
        if (cancelled) return;
        if (
          unavailable ||
          (card !== null && (!card || typeof card !== "object"))
        ) {
          setPayment("unavailable");
          return;
        }
        const data = card as Partial<PaidCard> | null;
        if (
          data &&
          typeof data.last4 === "string" &&
          /^[0-9]{4}$/.test(data.last4)
        ) {
          setPayment({
            brand:
              data.brand && Object.hasOwn(cardNames, data.brand)
                ? data.brand
                : "unknown",
            last4: data.last4,
          });
        } else setPayment(data ? "unavailable" : null);
      })
      .catch(() => {
        if (!cancelled) setPayment("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCount]);
  return (
    <div className="gyro-last-payment" role="status">
      <small>Last payment{sandbox ? " · Sandbox" : ""}</small>
      {payment && typeof payment === "object" ? (
        <span className="gyro-last-payment-card">
          {payment.brand === "mastercard" ? (
            <svg
              className="gyro-card-mark"
              viewBox="0 0 32 22"
              aria-hidden="true"
            >
              <circle cx="12" cy="11" r="7" fill="#eb001b" />
              <circle cx="20" cy="11" r="7" fill="#f79e1b" />
              <path
                d="M16 5.26a7 7 0 0 1 0 11.48 7 7 0 0 1 0-11.48Z"
                fill="#ff5f00"
              />
            </svg>
          ) : payment.brand === "visa" || payment.brand === "amex" ? (
            <span
              className="gyro-card-mark"
              data-brand={payment.brand}
              aria-hidden="true"
            >
              {payment.brand === "visa" ? "VISA" : "AMEX"}
            </span>
          ) : (
            <CreditCard size={18} aria-hidden="true" />
          )}
          <strong>
            {cardNames[payment.brand]}{" "}
            <span aria-label={`ending in ${payment.last4}`}>
              •••• {payment.last4}
            </span>
          </strong>
        </span>
      ) : (
        <span>
          {payment === "loading"
            ? "Checking payment…"
            : payment === "unavailable"
              ? "Card details unavailable"
              : "No card details for the last payment"}
        </span>
      )}
    </div>
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
  if (snapshot.availability === "coming-soon") actions = {};
  const [paymentRefresh, setPaymentRefresh] = useState(0);
  const [planChangeMessage, setPlanChangeMessage] = useState("");
  const [changingPlan, setChangingPlan] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<"plus" | "premium">();
  const modernCloud = snapshot.cloudV2 || snapshot.productionCloud;
  const currentPlan = paidStates.includes(snapshot.status)
    ? snapshot.plan
    : undefined;
  const currentOffer = offers.find((offer) => offer.id === currentPlan);
  const sandbox = snapshot.staging && modernCloud;
  const renderPlanAction = (
    id: NonNullable<BillingSnapshot["plan"]>,
    name: string,
  ) =>
    snapshot.availability === "coming-soon" ? (
      <button
        type="button"
        className="gyro-secondary-button"
        aria-label={`Subscribe to ${name}, coming soon`}
        disabled
      >
        Coming soon
      </button>
    ) : actions.subscribe ? (
      <button
        type="button"
        className="gyro-secondary-button"
        onClick={() =>
          actions.subscribe?.(id, modernCloud ? "personal" : undefined)
        }
      >
        Subscribe to {name}
      </button>
    ) : modernCloud &&
      actions.cloud &&
      snapshot.plan !== id &&
      !snapshot.scheduledPlan &&
      paidStates.includes(snapshot.status) ? (
      <button
        type="button"
        className="gyro-secondary-button"
        disabled={changingPlan}
        onClick={() => {
          if (id === "plus" || id === "premium") setPendingPlan(id);
        }}
      >
        Change at next renewal
      </button>
    ) : modernCloud && currentPlan === id ? null : (
      <span>
        {snapshot.scheduledPlan === id
          ? "Scheduled for next renewal"
          : snapshot.staging && snapshot.plan === id
            ? "Current test plan"
            : snapshot.staging && snapshot.plan
              ? "Plan changes are unavailable in this test"
              : "Not available yet"}
      </span>
    );
  return (
    <SettingsSection
      icon={CreditCard}
      title="Plan & billing"
      description="Your optional Gyro subscription. Local work and your own providers remain available without an account."
    >
      <CloudConnectionSettings
        snapshot={snapshot}
        actions={
          actions.refresh
            ? {
                ...actions,
                refresh: async () => {
                  await actions.refresh?.();
                  setPaymentRefresh((count) => count + 1);
                },
              }
            : actions
        }
        showAccount={false}
        details={
          modernCloud &&
          (currentOffer ||
            snapshot.accessUntil ||
            snapshot.renewalAt ||
            snapshot.cancellationAt) ? (
            <dl className="gyro-billing-facts">
              {currentOffer ? (
                <div>
                  <dt>Listed plan price</dt>
                  <dd>
                    {currentOffer.price}/month
                    <small>
                      {sandbox ? "VAT included · sandbox" : "VAT included"}
                    </small>
                  </dd>
                </div>
              ) : null}
              {snapshot.cancellationAt ? (
                <div>
                  <dt>Access ends</dt>
                  <dd>
                    {dateLabel(snapshot.cancellationAt)}
                    <small>Cancellation confirmed by billing.</small>
                  </dd>
                </div>
              ) : snapshot.accessUntil ? (
                <div>
                  <dt>Access through</dt>
                  <dd>
                    {dateLabel(snapshot.accessUntil)}
                    <small>
                      {currentOffer
                        ? "Current paid period"
                        : "Last confirmed by Gyro Cloud"}
                    </small>
                  </dd>
                </div>
              ) : null}
              {currentOffer && !snapshot.cancellationAt ? (
                <div>
                  <dt>Next renewal</dt>
                  <dd>
                    {snapshot.renewalAt
                      ? dateLabel(snapshot.renewalAt)
                      : actions.manage
                        ? "See billing portal"
                        : "Date not confirmed"}
                    <small>
                      {snapshot.scheduledPlan
                        ? `${planNames[snapshot.scheduledPlan]} scheduled`
                        : actions.manage
                          ? "Exact charges and receipts in billing"
                          : "Reported when billing confirms it"}
                    </small>
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null
        }
      >
        {modernCloud &&
        snapshot.billingIdentity &&
        actions.cloud &&
        snapshot.status !== "offline" ? (
          <LastPayment
            key={snapshot.billingIdentity}
            request={actions.cloud.request}
            refreshCount={paymentRefresh}
            sandbox={sandbox}
          />
        ) : null}
        {actions.manage ? (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={actions.manage}
          >
            Manage billing
          </button>
        ) : null}
      </CloudConnectionSettings>
      <SettingsGroup
        id="subscription"
        label="Subscription"
        summary={currentPlan ? planNames[currentPlan] : "Compare Gyro plans"}
      >
        <p>
          The complete local app stays free.{" "}
          {modernCloud
            ? "Both plans include selected backups, project memory and report sharing. Storage includes retained versions."
            : snapshot.staging
              ? "Test billing only. This is not the launch offer."
              : "Optional services are being prepared; features and included allowances are not final."}
        </p>
        {planChangeMessage ? <p role="status">{planChangeMessage}</p> : null}
        {modernCloud ? (
          <>
            {sandbox ? (
              <p>
                Sandbox prices only. Managed assistance is unavailable in
                staging.
              </p>
            ) : null}
            {actions.subscribe ? (
              <p>
                Gyro Plus and Gyro Premium are currently available for personal
                use.
              </p>
            ) : null}
            <table
              className="gyro-plan-comparison"
              aria-label="Compare Gyro Plus and Premium"
            >
              <thead>
                <tr>
                  <th scope="col">Included</th>
                  {offers.map(({ id, name, price }) => (
                    <th
                      key={id}
                      scope="col"
                      data-current={id === currentPlan || undefined}
                    >
                      {name}
                      {id === currentPlan ? <small>Current plan</small> : null}
                      <small>
                        {price}/month · VAT included
                        {sandbox ? " · sandbox price, no real charge" : ""}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(sandbox ? offerLimits.slice(0, 4) : offerLimits).map(
                  ([label, plus, premium]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td data-current={currentPlan === "plus" || undefined}>
                        {plus}
                      </td>
                      <td data-current={currentPlan === "premium" || undefined}>
                        {premium}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  {offers.map(({ id, name }) => (
                    <td key={id} data-current={id === currentPlan || undefined}>
                      {renderPlanAction(id, name)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </>
        ) : snapshot.staging || snapshot.simulation ? (
          <div className="gyro-billing-plans">
            {(
              [
                { id: "lite", name: "Gyro Cloud", price: "$10" },
                { id: "plus", name: "Gyro Plus", price: "$40" },
              ] as const
            ).map(({ id, name, price }) => (
              <article key={id}>
                <h3>{name}</h3>
                <p>
                  <strong>
                    {snapshot.staging ? (id === "lite" ? "$1" : "$2") : price}
                    /month
                  </strong>
                  {snapshot.staging
                    ? " · sandbox fixture"
                    : " · planning value"}
                </p>
                {renderPlanAction(id, name)}
              </article>
            ))}
          </div>
        ) : null}
        {pendingPlan &&
        !snapshot.scheduledPlan &&
        currentPlan &&
        currentPlan !== pendingPlan &&
        actions.cloud ? (
          <div className="gyro-billing-confirm">
            <p>
              Switch to {planNames[pendingPlan]} at your next renewal? The new
              plan price is{" "}
              {offers.find((offer) => offer.id === pendingPlan)?.price}/month,
              VAT included{sandbox ? " (sandbox)" : ""}. Your current plan stays
              active until then.
            </p>
            <div className="gyro-settings-transfer-actions">
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={changingPlan}
                onClick={() => setPendingPlan(undefined)}
              >
                Keep current plan
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={changingPlan}
                onClick={() => {
                  const id = pendingPlan;
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
                    .finally(() => {
                      setChangingPlan(false);
                      setPendingPlan(undefined);
                    });
                }}
              >
                Confirm plan change
              </button>
            </div>
          </div>
        ) : null}
        {!modernCloud ? (
          <>
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
          </>
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
        <p>
          {actions.manage
            ? "Manage billing opens Stripe, where you can see your payment method, actual charges and receipts, or cancel renewal. Your paid access runs through the date confirmed by billing."
            : "Payment methods, invoices and cancellation appear here when billing management is available."}
        </p>
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
