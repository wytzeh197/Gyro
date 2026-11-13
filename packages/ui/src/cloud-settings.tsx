import { Cloud } from "lucide-react";
import {
  CloudConnectionSettings,
  type BillingActions,
  type BillingSnapshot,
} from "./billing-settings";
import { CloudServicesSettings } from "./cloud-services-settings";
import {
  SettingsGroup,
  SettingsEmptyState,
  SettingsRow,
  SettingsSwitch,
} from "./settings-controls";
import { SettingsSection, UsageCard } from "./settings-presentation";

/** Optional hosted services use the same settings blocks as the local app. */
export function CloudSettings({
  snapshot = { status: "unavailable" },
  actions = {},
  onOpenBilling,
  workspace = false,
  onManageCloud,
}: {
  snapshot?: BillingSnapshot;
  actions?: BillingActions;
  onOpenBilling?: () => void;
  workspace?: boolean;
  onManageCloud?: () => void;
}) {
  if (snapshot.availability === "coming-soon" || snapshot.status === "unavailable")
    return (
      <SettingsSection
        icon={Cloud}
        title="Gyro Cloud"
        description="Optional cloud services, separate from your local workspace."
      >
        <SettingsEmptyState icon={<Cloud size={40} />}
          title="Cloud is not enabled in this build"
          description="Your local workspace and your own providers remain available." />
        <SettingsGroup id="cloud-release-availability" label="Chat backup">
          <SettingsRow label="Automatically back up chats" value="Unavailable">
            <SettingsSwitch label="Automatically back up chats" checked={false} disabled onChange={() => {}} />
            <span className="gyro-settings-info-value">Unavailable</span>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    );
  const usage = snapshot.cloudUsage;
  const stale = snapshot.status === "offline";
  const storage = usage?.storage;
  const storageLabel =
    storage && storage.limitBytes > 0
      ? `${((storage.usedBytes + storage.reservedBytes) / 1_000_000).toFixed(1)} MB / ${(storage.limitBytes / 1_000_000_000).toFixed(0)} GB`
      : undefined;
  const usageGroup = (
    <SettingsGroup
      id="cloud-managed-usage"
      label="Cloud usage & limits"
      summary={
        stale
          ? "Last confirmed values · offline"
          : storageLabel
            ? `${storageLabel} storage used or reserved`
            : "No current usage reported"
      }
    >
      {snapshot.staging && snapshot.cloudV2 ? (
        <p>
          Managed assistance is unavailable in staging. Storage and transfer
          limits still apply.
        </p>
      ) : (
        <p>
          Managed assistance uses your included monthly allowance. Memory drafts
          count toward it. There are no automatic overages; your local work and
          own providers remain available.
        </p>
      )}
      {usage ? (
        <>
          {snapshot.staging && snapshot.cloudV2 ? null : (
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
            </>
          )}
          <SettingsRow
            label="Cloud storage"
            detail="Includes attachments, retained versions and in-progress uploads."
            value={storageLabel ?? "No storage allowance"}
          />
        </>
      ) : (
        <p>
          Sign in to check server-reported usage. No Cloud allowance is inferred
          from your local provider usage.
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
    </SettingsGroup>
  );
  return (
    <SettingsSection
      icon={Cloud}
      title="Gyro Cloud"
      description="Back up selected work, share reports and manage Cloud access. You choose what leaves this Mac."
    >
      <CloudConnectionSettings
        snapshot={snapshot}
        actions={actions}
        showAccount={false}
      >
        {onOpenBilling ? (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={onOpenBilling}
          >
            Open plan &amp; billing
          </button>
        ) : null}
        {onManageCloud ? (
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={onManageCloud}
          >
            Manage Cloud
          </button>
        ) : null}
      </CloudConnectionSettings>
      {!workspace ? (
        <CloudConnectionSettings
          snapshot={snapshot}
          actions={actions}
          showStatus={false}
        />
      ) : null}
      {!workspace && (snapshot.cloudV2 || snapshot.productionCloud) ? (
        <SettingsGroup
          id="cloud-automatic-backup"
          label="Chat backup"
          summary={
            actions.autoBackup?.enabled
              ? actions.autoBackup.available
                ? "Automatic backup on"
                : "Automatic backup paused"
              : "Automatic backup off"
          }
        >
          <SettingsRow
            label="Automatically back up chats"
            detail="After a chat turn finishes on this Mac, Gyro can upload its text to this Cloud account without asking each time. Attachments, tool actions and provider credentials are excluded. Existing chats aren’t uploaded until you continue them."
          >
            <SettingsSwitch
              label="Automatically back up chats"
              checked={actions.autoBackup?.enabled === true}
              disabled={
                !actions.autoBackup ||
                (!actions.autoBackup.available && !actions.autoBackup.enabled)
              }
              onChange={(enabled) => actions.autoBackup?.setEnabled(enabled)}
            />
          </SettingsRow>
          {!actions.autoBackup?.available ? (
            <p>
              Automatic backup requires an active Cloud plan and a connection.
            </p>
          ) : null}
        </SettingsGroup>
      ) : null}
      {!workspace ? usageGroup : null}
      {(snapshot.cloudV2 || snapshot.productionCloud) && actions.cloud ? (
        <section
          className="gyro-cloud-tools"
          aria-labelledby="gyro-cloud-tools-title"
        >
          <h2 id="gyro-cloud-tools-title">Cloud tools</h2>
          <CloudServicesSettings
            actions={actions.cloud}
            limits={snapshot.limits}
            plan={snapshot.plan}
            managedAi={snapshot.cloudCapabilities?.managedAi}
            staging={snapshot.staging && snapshot.cloudV2}
            accessState={snapshot.status}
            workspace={workspace}
          />
        </section>
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
      {workspace ? usageGroup : null}
    </SettingsSection>
  );
}
