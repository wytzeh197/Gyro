import {
  CloudIcon,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  UserRoundIcon,
  type SettingsSectionId,
} from "@gyro-dev/ui";
import {
  CloudConnectionSettings,
  type BillingActions,
  type BillingSnapshot,
} from "../../../packages/ui/src/billing-settings";
import "./account-settings.css";

type Account = { snapshot: BillingSnapshot; actions: BillingActions };
export function AccountNavigation({
  account,
  selected,
  onSelect,
}: {
  account: Account;
  selected: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
}) {
  const signedIn = Boolean(
    account.snapshot.accountLabel &&
    !["signed-out", "checking", "unavailable"].includes(
      account.snapshot.status,
    ),
  );
  return (
    <div className="gyro-account-navigation">
      <button
        type="button"
        className={selected === "account" ? "is-active" : ""}
        aria-current={selected === "account" ? "page" : undefined}
        onClick={() => onSelect("account")}
      >
        <span className="gyro-account-profile-avatar" aria-hidden="true">
          <UserRoundIcon size={15} />
        </span>
        <span className="gyro-account-navigation-text">
          <strong>Gyro Account</strong>
          <small>{signedIn ? "Signed in" : "Optional"}</small>
        </span>
      </button>
      {signedIn && (
        <button
          type="button"
          className={`is-compact${selected === "cloud" ? " is-active" : ""}`}
          aria-current={selected === "cloud" ? "page" : undefined}
          onClick={() => onSelect("cloud")}
        >
          <CloudIcon aria-hidden="true" size={15} />
          <strong>Cloud</strong>
        </button>
      )}
    </div>
  );
}
export function AccountSettings({ account }: { account: Account }) {
  return (
    <SettingsSection
      icon={UserRoundIcon}
      title="Account"
      description="Optional. Local work and your own providers work without an account."
    >
      <CloudConnectionSettings
        snapshot={account.snapshot}
        actions={account.actions}
      />
      {account.snapshot.status === "unavailable" && (
        <SettingsGroup
          id="account-availability"
          label="Availability"
          defaultOpen
        >
          <SettingsRow
            label="Cloud is not configured in this build"
            detail="Local work remains available. A production Cloud connection needs the published service configuration."
          />
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
