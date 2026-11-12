import { useEffect, useState } from "react";
import {
  CloudIcon,
  SettingsGroup,
  SettingsEmptyState,
  SettingsRow,
  SettingsSection,
  UserRoundIcon,
  type SettingsSectionId,
} from "@gyro-dev/ui";
import {
  AuthField,
  cloud,
  CloudNotice,
  CloudSignIn,
  GyroCloud,
  PasswordInput,
  type CloudStatus,
} from "./gyro-cloud";
import "./account-settings.css";

export function useGyroAccount() {
  const [status, setStatus] = useState<CloudStatus>();
  const [error, setError] = useState("");
  async function refresh() {
    try {
      setStatus(await cloud<CloudStatus>("status"));
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return { status, setStatus, error, refresh };
}
type Account = ReturnType<typeof useGyroAccount>;

function AccountAvatar({ status }: { status?: CloudStatus }) {
  const profile = status?.signedIn ? status.profile : undefined;
  const initial = (profile?.displayName?.trim() || profile?.email || "")
    .slice(0, 1)
    .toUpperCase();
  return (
    <span className="gyro-account-profile-avatar" aria-hidden="true">
      {initial || <UserRoundIcon size={15} />}
    </span>
  );
}

export function AccountNavigation({
  account,
  selected,
  onSelect,
}: {
  account: Account;
  selected: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
}) {
  const status = account.status;
  // Builds without Gyro Cloud have nothing to sign in to.
  if (status && !status.enabled) return null;
  const profile = status?.profile;
  const name = profile?.displayName?.trim();
  return (
    <div className="gyro-account-navigation">
      <button
        type="button"
        className={selected === "account" ? "is-active" : ""}
        aria-current={selected === "account" ? "page" : undefined}
        onClick={() => onSelect("account")}
      >
        <AccountAvatar status={status} />
        <span className="gyro-account-navigation-text">
          <strong>
            {status?.signedIn ? name || profile?.email : "Gyro Account"}
          </strong>
          {status?.signedIn ? (
            !name ? (
              <small>Add your name</small>
            ) : profile?.plan ? (
              <small>{profile.plan}</small>
            ) : null
          ) : status ? (
            <small>Sign in</small>
          ) : null}
        </span>
      </button>

    </div>
  );
}

function UnloadedAccount({ account }: { account: Account }) {
  if (!account.error) return <p className="gyro-settings-page-status" role="status">Loading account…</p>;
  return (
    <SettingsGroup id="account-connection" label="Connection" defaultOpen>
      <SettingsRow label="Couldn’t load your account" detail={account.error}>
        <button
          className="gyro-secondary-button"
          onClick={() => void account.refresh()}
          type="button"
        >
          Try again
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Sets a first password on a code-only account, or replaces an existing one. */
function PasswordRow({
  onNotice,
}: {
  onNotice: (message: string, failed: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  function close() {
    setEditing(false);
    setPassword("");
  }
  function cancel() {
    close();
    onNotice("", false);
  }
  return editing ? (
    <form
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) cancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        onNotice("", false);
        cloud("changePassword", { password })
          .then(() => {
            close();
            onNotice("Password updated.", false);
          })
          .catch((reason) => onNotice(String(reason), true))
          .finally(() => setBusy(false));
      }}
    >
      <AuthField label="New password">
        <PasswordInput
          autoFocus
          disabled={busy}
          isNew
          onChange={setPassword}
          value={password}
        />
      </AuthField>
      <div className="gyro-auth-footer is-end">
        <button
          className="gyro-secondary-button"
          disabled={busy}
          onClick={cancel}
          type="button"
        >
          Cancel
        </button>
        <button className="gyro-primary-button" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </button>
      </div>
    </form>
  ) : (
    <SettingsRow label="Password">
      <button
        className="gyro-secondary-button"
        onClick={() => {
          onNotice("", false);
          setEditing(true);
        }}
        type="button"
      >
        Change
      </button>
    </SettingsRow>
  );
}

const unavailable = (
  <SettingsGroup id="account-availability" label="Availability" defaultOpen>
    <SettingsRow
      label="Not available in this build"
    />
  </SettingsGroup>
);

export function AccountSettings({ account }: { account: Account }) {
  const { status } = account;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState({
    message: "",
    failed: false,
  });
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  const displayName = status?.profile?.displayName?.trim();
  return (
    <SettingsSection
      icon={UserRoundIcon}
      title="Account"
      description={
        status?.enabled && !status.signedIn
          ? "Optional. Use it to back up and restore chats with Gyro Cloud."
          : "Manage your Gyro profile and sign-in."
      }
    >
      {!status ? (
        <UnloadedAccount account={account} />
      ) : !status.enabled ? (
        unavailable
      ) : !status.signedIn ? (
        <CloudSignIn onSignedIn={account.setStatus} />
      ) : (
        <>
          <SettingsGroup id="account-profile" label="Profile" defaultOpen>
            {editing ? (
              <form
                className="gyro-account-identity"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !busy) setEditing(false);
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const profile = await cloud<
                      NonNullable<CloudStatus["profile"]>
                    >("updateProfile", { displayName: name.trim() });
                    account.setStatus({ ...status, profile });
                    setEditing(false);
                  });
                }}
              >
                <AccountAvatar status={status} />
                <input
                  aria-label="Display name"
                  autoFocus
                  className="gyro-cloud-input"
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                  value={name}
                />
                <div className="gyro-cloud-actions">
                  <button
                    className="gyro-secondary-button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setError("");
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button className="gyro-primary-button" disabled={busy}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>
            ) : (
              <div
                className="gyro-account-identity"
                data-setting-key="display-name"
              >
                <AccountAvatar status={status} />
                <div className="gyro-account-identity-text">
                  <strong className={displayName ? "" : "is-placeholder"}>
                    {displayName || "Add your name"}
                    {status.profile?.plan && (
                      <span className="gyro-account-plan">
                        {status.profile.plan}
                      </span>
                    )}
                  </strong>
                  <small>{status.profile?.email}</small>
                </div>
                <button
                  className="gyro-secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setName(displayName || "");
                    setEditing(true);
                  }}
                  type="button"
                >
                  {displayName ? "Edit" : "Add name"}
                </button>
              </div>
            )}
          </SettingsGroup>
          <SettingsGroup
            id="account-sign-in"
            label="Sign-in"
            summary="Password and sign out"
          >
            <PasswordRow
              onNotice={(message, failed) => {
                setPasswordNotice({ message, failed });
                // A password saved here settles a refusal left over from a reset.
                if (status.passwordError) {
                  account.setStatus({ ...status, passwordError: null });
                }
              }}
            />
            <SettingsRow label="Signed in on this device">
              <button
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    account.setStatus(await cloud<CloudStatus>("signOut"));
                    setEditing(false);
                    setName("");
                    setPasswordNotice({ message: "", failed: false });
                  })
                }
                type="button"
              >
                Sign out
              </button>
            </SettingsRow>
          </SettingsGroup>
          <CloudNotice
            failed={Boolean(
              error ||
                status.passwordError ||
                passwordNotice.failed ||
                account.error,
            )}
            message={
              error ||
              status.passwordError ||
              passwordNotice.message ||
              account.error
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

export function CloudSettings({
  account,
  onAccount,
}: {
  account: Account;
  onAccount: () => void;
}) {
  const status = account.status;
  return (
    <SettingsSection
      icon={CloudIcon}
      title="Gyro Cloud"
      description="Optional cloud services, separate from your local workspace."
    >
      {!status ? (
        <UnloadedAccount account={account} />
      ) : !status.enabled ? (
        <SettingsEmptyState icon={<CloudIcon size={40} />} title="Cloud is not enabled in this build" description="Your local workspace remains available." />
      ) : !status.signedIn ? (
        <SettingsGroup id="cloud-sign-in" label="Chat backup" defaultOpen>
          <SettingsRow
            label="Sign in to use Cloud"
          >
            <button
              className="gyro-primary-button"
              onClick={onAccount}
              type="button"
            >
              Go to Account
            </button>
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <GyroCloud inline initialStatus={status} onStatus={account.setStatus} />
      )}
    </SettingsSection>
  );
}
