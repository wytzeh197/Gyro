import { Cloud } from "lucide-react";
import {
  CloudConnectionSettings,
  type BillingActions,
  type BillingSnapshot,
} from "./billing-settings";
import { CloudServicesSettings } from "./cloud-services-settings";
import { SettingsGroup, SettingsRow } from "./settings-controls";
import { SettingsSection, UsageCard } from "./settings-presentation";

/** Optional hosted services use the same settings blocks as the local app. */
export function CloudSettings({
  snapshot = { status: "unavailable" },
  actions = {},
  onOpenBilling,
}: {
  snapshot?: BillingSnapshot;
  actions?: BillingActions;
  onOpenBilling?: () => void;
}) {
  const usage = snapshot.cloudUsage;
  const stale = snapshot.status === "offline";
  return (
    <SettingsSection
      icon={Cloud}
      title="Gyro Cloud"
      description="Selected backups, project memory and optional assistance. You choose what leaves this Mac."
    >
      <CloudConnectionSettings snapshot={snapshot} actions={actions} />
      <SettingsGroup
        id="cloud-managed-usage"
        label="Cloud usage & limits"
        summary={
          stale
            ? "Last confirmed values · offline"
            : usage
              ? "Reported by Gyro Cloud"
              : "No current usage reported"
        }
      >
        <p>
          Managed assistance uses your included monthly allowance. Memory drafts
          count toward it. There are no automatic overages; your local work and
          own providers remain available.
        </p>
        {usage ? (
          <>
            <UsageCard
              visualization="bars"
              window={{
                id: "gyro-cloud-monthly",
                label: stale
                  ? "Managed allowance · last confirmed"
                  : "Monthly managed allowance",
                usedPercent: 100 - usage.managedAi.remaining,
                status:
                  usage.managedAi.remaining <= 0
                    ? "exhausted"
                    : usage.managedAi.remaining <= 20
                      ? "warning"
                      : "ok",
                resetsAt: usage.managedAi.resetAt ?? undefined,
              }}
            />
            <SettingsRow
              label="Allowance being resolved"
              detail="Held for accepted requests until their usage is known. It is included in the used amount above."
              value={`${usage.managedAi.held.toFixed(1)}%`}
            />
            <SettingsRow
              label="Cloud storage"
              detail="Includes attachments, retained versions and in-progress uploads."
              value={`${((usage.storage.usedBytes + usage.storage.reservedBytes) / 1_000_000).toFixed(1)} MB / ${(usage.storage.limitBytes / 1_000_000_000).toFixed(0)} GB`}
            />
          </>
        ) : (
          <p>
            Sign in to check server-reported usage. No Cloud allowance is
            inferred from your local provider usage.
          </p>
        )}
        {snapshot.limits ? (
          <>
            <SettingsRow
              label="Monthly uploads"
              detail="A hard transfer limit for each billing month; includes attachment uploads."
              value={`${(snapshot.limits.uploadBytesPerMonth / 1_000_000_000).toLocaleString()} GB`}
            />
            <SettingsRow
              label="Monthly downloads"
              detail="A hard transfer limit for ordinary Cloud downloads. Account export has a separate recovery window."
              value={`${(snapshot.limits.downloadBytesPerMonth / 1_000_000_000).toLocaleString()} GB`}
            />
          </>
        ) : null}
        {onOpenBilling ? (
          <div className="gyro-settings-transfer-actions">
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={onOpenBilling}
            >
              Open plan & billing
            </button>
          </div>
        ) : null}
      </SettingsGroup>
      {(snapshot.cloudV2 || snapshot.productionCloud) && actions.cloud ? (
        <CloudServicesSettings
          actions={actions.cloud}
          limits={snapshot.limits}
          plan={snapshot.plan}
          managedAi={snapshot.cloudCapabilities?.managedAi}
          accessState={snapshot.status}
        />
      ) : (
        <SettingsGroup
          id="cloud-services"
          label="Cloud services"
          summary="No Cloud connection established"
        >
          <p>
            Nothing uploads automatically. Selected backups, memory, report
            links and device controls appear after a supported Cloud connection
            is established.
          </p>
          <p>
            The complete local app remains available without a Cloud account.
          </p>
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
