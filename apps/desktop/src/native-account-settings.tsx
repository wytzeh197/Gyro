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
  planNames,
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
  // Signed in, the rail names the account the way the Account page does:
  // the verified address, its initial, and the plan when there is one.
  const email = signedIn ? account.snapshot.accountEmail?.trim() : undefined;
  const plan = account.snapshot.plan;
  return (
    <div className="gyro-account-navigation">
      <button
        type="button"
        className={selected === "account" ? "is-active" : ""}
        aria-current={selected === "account" ? "page" : undefined}
        onClick={() => onSelect("account")}
      >
        <span className="gyro-account-profile-avatar" aria-hidden="true">
          {email ? email.slice(0, 1).toUpperCase() : <UserRoundIcon size={15} />}
        </span>
        <span className="gyro-account-navigation-text">
          <strong title={email}>{email || "Gyro Account"}</strong>
          <small>
            {account.snapshot.availability === "coming-soon"
              ? "Coming soon"
              : signedIn
                ? plan
                  ? planNames[plan]
                  : "Signed in"
                : "Optional"}
          </small>
        </span>
      </button>
      {(signedIn || account.snapshot.availability === "coming-soon") && (
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
      {/* In the coming-soon release the status notice above already says
          this; repeating it as a card made the page say it three times. */}
      {account.snapshot.status === "unavailable" &&
        account.snapshot.availability !== "coming-soon" && (
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
