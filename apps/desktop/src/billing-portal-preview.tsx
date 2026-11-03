// Design-only hosted management journey. Imported exclusively by the preview.
import { useEffect, useRef, useState } from "react";
import type { BillingSnapshot } from "../../../packages/ui/src/billing-settings";

export function BillingPortalPreview({
  snapshot,
  onClose,
  onChange,
}: {
  snapshot: BillingSnapshot;
  onClose: () => void;
  onChange: (patch: Partial<BillingSnapshot>) => void;
}) {
  const [page, setPage] = useState("overview");
  const [message, setMessage] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="gyro-settings-preview-portal-backdrop">
      <div
        ref={panel}
        className="gyro-settings-preview-account-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-portal-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Tab") {
            const controls = Array.from(
              panel.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input, select, a[href]",
              ),
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          ref={close}
          type="button"
          className="gyro-secondary-button"
          onClick={onClose}
        >
          Return to Gyro
        </button>
        <h2 id="billing-portal-title">Billing management</h2>
        <p>
          Design fixture only. This previews a future hosted billing service; no
          payment details or real changes are sent.
        </p>
        <nav
          aria-label="Billing management preview"
          className="gyro-settings-transfer-actions"
        >
          {([
            ["overview", "Subscription"],
            ["payment", "Payment method"],
            ["invoices", "Invoices"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className="gyro-secondary-button"
              aria-pressed={page === id}
              onClick={() => {
                setPage(id);
                setMessage("");
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        {page === "overview" ? (
          <>
            <h3>{snapshot.plan === "lite" ? "Gyro Cloud" : "Gyro Plus"}</h3>
            <p>Plan prices and dates below are synthetic planning values.</p>
            <button
              className="gyro-secondary-button"
              onClick={() => setPage("change")}
            >
              Change plan
            </button>{" "}
            <button
              className="gyro-secondary-button"
              onClick={() => setPage("cancel")}
            >
              Cancel subscription
            </button>
          </>
        ) : null}
        {page === "payment" ? (
          <>
            <h3>Payment method</h3>
            <p>Example card •••• 4242 · Expires 12/2028</p>
            <p>
              Card entry will happen on the hosted service. Gyro will never
              collect the card number.
            </p>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                setMessage(
                  "Preview: the hosted service confirms the replacement payment method, then returns you to this page.",
                )
              }
            >
              Preview replacement confirmation
            </button>
          </>
        ) : null}
        {page === "invoices" ? (
          <>
            <h3>Invoices</h3>
            <p>Example invoice · 1 October 2026 · $40 · Paid</p>
            <button
              className="gyro-secondary-button"
              onClick={() =>
                setMessage(
                  "Preview: the hosted service opens or downloads the selected invoice. No invoice exists in this simulator.",
                )
              }
            >
              Preview invoice action
            </button>
          </>
        ) : null}
        {page === "change" ? (
          <>
            <h3>Review plan change</h3>
            <p>
              {snapshot.plan === "lite"
                ? "Gyro Plus · $40/month"
                : "Gyro Cloud · $10/month"}{" "}
              — planning value.
            </p>
            <p>
              The hosted service must quote the effective date, amount due and
              any proration before confirmation. Those capabilities are
              unavailable today.
            </p>
            <button
              className="gyro-primary-button"
              onClick={() => {
                onChange({ plan: snapshot.plan === "lite" ? "plus" : "lite" });
                setPage("overview");
                setMessage(
                  "Synthetic plan changed. Real access changes only after server confirmation.",
                );
              }}
            >
              Simulate confirmed plan change
            </button>
          </>
        ) : null}
        {page === "cancel" ? (
          <>
            <h3>Cancel at the end of the period?</h3>
            <p>
              Fixture access ends 1 December 2026. Local work and your own
              providers stay available.
            </p>
            <button
              className="gyro-secondary-button"
              onClick={() => setPage("overview")}
            >
              Keep subscription
            </button>{" "}
            <button
              className="gyro-primary-button"
              onClick={() => {
                onChange({
                  status: "cancellation-scheduled",
                  cancellationAt: "2026-12-01T00:00:00Z",
                });
                setPage("overview");
                setMessage(
                  "Synthetic cancellation scheduled. Nothing was changed in a billing service.",
                );
              }}
            >
              Simulate cancellation
            </button>
          </>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </div>
  );
}
