import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ReadOnlyChatMessage,
  RefreshIcon,
  SettingsGroup,
  SettingsRow,
  TrashIcon,
} from "@gyro-dev/ui";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./gyro-cloud.css";

export type CloudStatus = {
  enabled: boolean;
  signedIn?: boolean;
  unlocked?: boolean;
  backupExists?: boolean;
  /** Set when a reset signed the account in but its new password was refused. */
  passwordError?: string | null;
  profile?: {
    email: string;
    displayName: string | null;
    plan: string | null;
  } | null;
};
type Status = CloudStatus;
type Chat = { id: string; title: string | null; uploadedAt?: string };
type Page = { items: Chat[]; cursor: string | null };
type Archive = {
  title: string;
  createdAt: string;
  model: string | null;
  messages: {
    kind: "user" | "assistant" | "tool";
    text: string;
    timestamp: string;
    model?: string;
  }[];
};
type Upload = { status: "uploaded" | "unchanged" | "conflict"; etag?: string };

export function cloud<T>(type: string, fields: Record<string, unknown> = {}) {
  return invoke<T>("gyro_cloud", { action: { type, ...fields } });
}

const cloudDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
function formatCloudDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : cloudDate.format(date);
}

/** Progress and failures float over the page, so they never shift its rows. */
export function CloudNotice({
  message,
  failed,
}: {
  message: string;
  failed?: boolean;
}) {
  return (
    <p
      aria-live="polite"
      className={`gyro-cloud-notice${failed ? " is-failed" : ""}`}
      role="status"
    >
      {message}
    </p>
  );
}

type AuthMode =
  | "sign-up"
  | "sign-in"
  | "email-link"
  | "enter-proof"
  | "confirm"
  | "reset-request"
  | "reset-verify";
type AuthResult =
  | CloudStatus
  | { confirmationRequired: true }
  | { accountExists: true };

export function AuthField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="gyro-auth-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function PasswordInput({
  value,
  onChange,
  disabled,
  isNew,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  isNew?: boolean;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="gyro-auth-password">
      {/* Read-only while busy keeps focus here if the attempt fails. */}
      <input
        autoComplete={isNew ? "new-password" : "current-password"}
        autoFocus={autoFocus}
        className="gyro-cloud-input"
        minLength={isNew ? 8 : undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={isNew ? "At least 8 characters" : undefined}
        readOnly={disabled}
        required
        spellCheck={false}
        type={visible ? "text" : "password"}
        value={value}
      />
      <button
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="gyro-cloud-icon-button"
        onClick={() => setVisible((current) => !current)}
        type="button"
      >
        {visible ? (
          <EyeOffIcon aria-hidden="true" size={14} />
        ) : (
          <EyeIcon aria-hidden="true" size={14} />
        )}
      </button>
    </span>
  );
}

const noNotice = { message: "", failed: false };

/**
 * New accounts give a name, email and password. Returning accounts use their
 * password, or an emailed link or code when they have none or forgot it. Every
 * screen offers a way out, so a wrong address or a lost email is never a dead end.
 */
export function CloudSignIn({
  onSignedIn,
}: {
  onSignedIn: (status: CloudStatus) => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<AuthMode>("sign-up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(noNotice);
  // Recovery routes wait behind one link until they're asked for or needed.
  const [showHelp, setShowHelp] = useState(false);
  const address = email.trim();

  // Each screen starts on its first field still needing an answer.
  useEffect(() => {
    const fields = form.current?.querySelectorAll("input") ?? [];
    [...fields].find((field) => !field.value)?.focus({ preventScroll: true });
  }, [mode]);

  function switchTo(next: AuthMode) {
    setMode(next);
    setShowHelp(false);
    setPassword("");
    setProof("");
    setNotice(noNotice);
  }
  function edit(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setNotice((current) => (current.message ? noNotice : current));
    };
  }
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setNotice(noNotice);
    try {
      await task();
    } catch (reason) {
      setNotice({ message: String(reason), failed: true });
      setShowHelp(true);
      // Retrying starts on the answer that was just refused, not the first field.
      const fields = form.current?.querySelectorAll("input");
      fields?.[fields.length - 1]?.select();
    } finally {
      setBusy(false);
    }
  }
  function finish(status: CloudStatus) {
    setPassword("");
    setProof("");
    onSignedIn(status);
  }
  function submit() {
    return run(async () => {
      if (mode === "sign-up") {
        const result = await cloud<AuthResult>("signUp", {
          name: name.trim(),
          email: address,
          password,
        });
        if ("accountExists" in result) {
          switchTo("sign-in");
          setNotice({
            message: "You already have an account with this email. Sign in instead.",
            failed: false,
          });
        } else if ("confirmationRequired" in result) {
          switchTo("confirm");
        } else {
          finish(result);
        }
      } else if (mode === "sign-in") {
        const result = await cloud<AuthResult>("passwordSignIn", {
          email: address,
          password,
        });
        if ("confirmationRequired" in result) {
          switchTo("confirm");
          setShowHelp(true);
          setNotice({
            message: "Confirm your email to finish signing in.",
            failed: false,
          });
        } else if (!("accountExists" in result)) {
          finish(result);
        }
      } else if (mode === "email-link") {
        await cloud("sendCode", { email: address });
        switchTo("enter-proof");
      } else if (mode === "reset-request") {
        await cloud("sendPasswordReset", { email: address });
        switchTo("reset-verify");
      } else if (mode === "reset-verify") {
        finish(
          await cloud<CloudStatus>("resetPassword", {
            email: address,
            proof,
            password,
          }),
        );
      } else {
        finish(await cloud<CloudStatus>("signIn", { email: address, proof }));
      }
    });
  }
  function sendAgain() {
    return run(async () => {
      await cloud(
        mode === "reset-verify"
          ? "sendPasswordReset"
          : mode === "confirm"
            ? "resendConfirmation"
            : "sendCode",
        { email: address },
      );
      setNotice({ message: `Sent again to ${address}.`, failed: false });
    });
  }

  const emailField = (
    <AuthField label="Email">
      <input
        autoComplete="email"
        className="gyro-cloud-input"
        onChange={(event) => edit(setEmail)(event.target.value)}
        placeholder="you@example.com"
        readOnly={busy}
        required
        spellCheck={false}
        type="email"
        value={email}
      />
    </AuthField>
  );
  const passwordField = (
    <AuthField label={mode === "reset-verify" ? "New password" : "Password"}>
      <PasswordInput
        disabled={busy}
        isNew={mode === "sign-up" || mode === "reset-verify"}
        key={mode}
        onChange={edit(setPassword)}
        value={password}
      />
    </AuthField>
  );
  const proofField = (
    <AuthField label={mode === "confirm" ? "Confirmation" : "Link or code"}>
      <input
        autoComplete="one-time-code"
        className="gyro-cloud-input"
        onChange={(event) => edit(setProof)(event.target.value)}
        placeholder="Paste the link, or enter the code"
        readOnly={busy}
        required
        spellCheck={false}
        value={proof}
      />
    </AuthField>
  );
  const link = (label: string, next: AuthMode) => (
    <button
      className="gyro-auth-link"
      disabled={busy}
      onClick={() => switchTo(next)}
      type="button"
    >
      {label}
    </button>
  );
  const helpToggle = (label: string) => (
    <button
      className="gyro-auth-link"
      disabled={busy}
      onClick={() => setShowHelp(true)}
      type="button"
    >
      {label}
    </button>
  );
  const sendAgainLink = (
    <button
      className="gyro-auth-link"
      disabled={busy}
      onClick={() => void sendAgain()}
      type="button"
    >
      Send again
    </button>
  );
  const { title, action, progress } = {
    "sign-up": {
      title: "Create your account",
      action: "Create account",
      progress: "Creating account…",
    },
    "sign-in": { title: "Sign in", action: "Sign in", progress: "Signing in…" },
    "email-link": {
      title: "Sign in with email",
      action: "Send sign-in email",
      progress: "Sending…",
    },
    "enter-proof": {
      title: "Check your inbox",
      action: "Sign in",
      progress: "Signing in…",
    },
    confirm: {
      title: "Confirm your email",
      action: "Confirm",
      progress: "Confirming…",
    },
    "reset-request": {
      title: "Reset your password",
      action: "Send reset email",
      progress: "Sending…",
    },
    "reset-verify": {
      title: "Choose a new password",
      action: "Set password",
      progress: "Setting password…",
    },
  }[mode];
  const description =
    mode === "enter-proof" || mode === "confirm"
      ? `Sent to ${address}.`
      : mode === "reset-verify"
        ? `Sent to ${address}, if it has an account. Copy the link without opening it.`
        : undefined;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void submit();
      }}
      ref={form}
    >
      {/* A form you must fill in, so unlike Settings groups it never collapses. */}
      <section aria-labelledby="gyro-auth-title" className="gyro-auth-card">
        <h2 id="gyro-auth-title">{title}</h2>
        {description ? <p>{description}</p> : null}
        {mode === "sign-up" && (
          <AuthField label="Name">
            <input
              autoComplete="name"
              className="gyro-cloud-input"
              maxLength={80}
              onChange={(event) => edit(setName)(event.target.value)}
              placeholder="Your name"
              readOnly={busy}
              required
              value={name}
            />
          </AuthField>
        )}
        {(mode === "sign-up" ||
          mode === "sign-in" ||
          mode === "email-link" ||
          mode === "reset-request") &&
          emailField}
        {(mode === "enter-proof" ||
          mode === "confirm" ||
          mode === "reset-verify") &&
          proofField}
        {(mode === "sign-up" || mode === "sign-in" || mode === "reset-verify") &&
          passwordField}
        <div className="gyro-auth-footer">
          <div className="gyro-auth-links">
            {mode === "sign-up" && (
              <>
                <span>Already have an account?</span>
                {link("Sign in", "sign-in")}
              </>
            )}
            {mode === "sign-in" && (
              <>
                {link("Create account", "sign-up")}
                {showHelp ? (
                  <>
                    {link("Reset password", "reset-request")}
                    {link("Email me a code", "email-link")}
                  </>
                ) : (
                  helpToggle("Trouble signing in?")
                )}
              </>
            )}
            {(mode === "email-link" || mode === "reset-request") && (
              <>
                {link("Back to sign in", "sign-in")}
                {link("Create account", "sign-up")}
              </>
            )}
            {mode === "confirm" &&
              (showHelp ? (
                <>
                  {link("Use another email", "sign-up")}
                  {sendAgainLink}
                  {link("Sign in", "sign-in")}
                </>
              ) : (
                <>
                  {helpToggle("Didn’t get it?")}
                  <span>Confirmed in your browser?</span>
                  {link("Sign in", "sign-in")}
                </>
              ))}
            {(mode === "enter-proof" || mode === "reset-verify") &&
              (showHelp ? (
                <>
                  {link(
                    "Use another email",
                    mode === "reset-verify" ? "reset-request" : "email-link",
                  )}
                  {sendAgainLink}
                  {link("Back to sign in", "sign-in")}
                </>
              ) : (
                helpToggle("Didn’t get it?")
              ))}
          </div>
          <button className="gyro-primary-button" disabled={busy}>
            {busy ? progress : action}
          </button>
        </div>
      </section>
      <CloudNotice failed={notice.failed} message={notice.message} />
    </form>
  );
}

export function GyroCloud({
  uploadId,
  onClose,
  inline = false,
  initialStatus,
  onStatus,
}: {
  uploadId?: string;
  onClose?: () => void;
  inline?: boolean;
  initialStatus?: CloudStatus;
  onStatus?: (status: CloudStatus) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const archiveRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const [status, setStatus] = useState<Status | undefined>(initialStatus);
  const [page, setPage] = useState<Page>();
  const [restored, setRestored] = useState<string[]>([]);
  const [archive, setArchive] = useState<Archive>();
  const [code, setCode] = useState("");
  const [generated, setGenerated] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const [conflict, setConflict] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  async function refresh() {
    const current = await cloud<Status>("status");
    setStatus(current);
    onStatus?.(current);
    if (current.unlocked) {
      setRestored(await cloud<string[]>("history"));
      setPage(await cloud<Page>("list"));
    }
  }

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setMessage("");
    setFailed(false);
    try {
      await task();
    } catch (error) {
      setMessage(String(error));
      setFailed(true);
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (!inline && !dialog.current?.open) dialog.current?.showModal();
    if (loaded.current) return;
    loaded.current = true;
    void run("Opening Gyro Cloud…", refresh);
  }, []);

  useEffect(() => {
    if (archive) archiveRef.current?.scrollIntoView({ block: "nearest" });
  }, [archive]);

  async function upload(replace?: string) {
    const result = await cloud<Upload>("upload", { id: uploadId, replace });
    setConflict(result.etag);
    if (result.status === "conflict") {
      setMessage(
        "There is a newer cloud copy. Review it in the library before replacing it.",
      );
    } else {
      setMessage(
        result.status === "unchanged"
          ? "This chat is already backed up."
          : "Chat uploaded.",
      );
      setPage(await cloud<Page>("list"));
    }
  }

  function chatTitle(id: string) {
    return page?.items.find((chat) => chat.id === id)?.title ?? "Encrypted chat";
  }

  const content = (
    <>
      <fieldset className="gyro-cloud-fieldset" disabled={!!busy}>
        {!status ? (
          <SettingsGroup id="cloud-connection" label="Connection" defaultOpen>
            <SettingsRow
              label={busy ? "Loading Cloud…" : "Couldn’t load Cloud"}
              detail="Cloud needs a connection to your Gyro Account."
            >
              <button
                className="gyro-secondary-button"
                onClick={() => void run("Loading Cloud…", refresh)}
                type="button"
              >
                Try again
              </button>
            </SettingsRow>
          </SettingsGroup>
        ) : !status.signedIn ? (
          <CloudSignIn
            onSignedIn={(next) => {
              setStatus(next);
              onStatus?.(next);
              void run("Opening Gyro Cloud…", refresh);
            }}
          />
        ) : (
          <>
            {message.includes("sign-in expired") && (
              <SettingsGroup id="cloud-expired" label="Sign-in" defaultOpen>
                <SettingsRow
                  label="Your sign-in expired"
                  detail="Sign in again to keep using Cloud."
                >
                  <button
                    className="gyro-primary-button"
                    onClick={() =>
                      void run("Resetting sign-in…", async () => {
                        setPage(undefined);
                        setRestored([]);
                        setArchive(undefined);
                        setConflict(undefined);
                        setRemoving(undefined);
                        setGenerated("");
                        setCode("");
                        const signedOut = await cloud<Status>("signOut");
                        setStatus(signedOut);
                        onStatus?.(signedOut);
                      })
                    }
                    type="button"
                  >
                    Sign in again
                  </button>
                </SettingsRow>
              </SettingsGroup>
            )}
            {!status.unlocked ? (
              generated ? (
                <SettingsGroup
                  id="cloud-recovery-setup"
                  defaultOpen
                  label="Save your recovery code"
                  description="You’ll need it to unlock backups on another device. Account recovery alone cannot unlock your chats."
                >
                  <div className="gyro-cloud-recovery">
                    <code>{generated}</code>
                    <button
                      className="gyro-secondary-button"
                      onClick={() =>
                        void run("Copying recovery code…", async () => {
                          await navigator.clipboard.writeText(generated);
                          setCopied(true);
                        })
                      }
                      type="button"
                    >
                      {copied ? (
                        <CheckIcon aria-hidden="true" size={13} />
                      ) : (
                        <CopyIcon aria-hidden="true" size={13} />
                      )}
                      {copied ? "Copied" : "Copy code"}
                    </button>
                  </div>
                  <SettingsRow
                    label="Saved somewhere safe?"
                  >
                    <button
                      className="gyro-primary-button"
                      onClick={() =>
                        void run("Saving recovery key…", async () => {
                          await cloud("confirm");
                          setGenerated("");
                          setCopied(false);
                          await refresh();
                        })
                      }
                      type="button"
                    >
                      I saved the code
                    </button>
                  </SettingsRow>
                </SettingsGroup>
              ) : status.backupExists ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run("Verifying recovery code…", async () => {
                      await cloud("recover", { code });
                      setCode("");
                      await refresh();
                    });
                  }}
                >
                  <SettingsGroup id="cloud-backup" label="Chat backup" defaultOpen>
                    <SettingsRow
                      label="Unlock your backups"
                    >
                      <div className="gyro-cloud-actions">
                        <input
                          aria-label="Recovery code"
                          autoComplete="off"
                          className="gyro-cloud-input"
                          onChange={(event) => setCode(event.target.value)}
                          placeholder="Recovery code"
                          type="password"
                          value={code}
                        />
                        <button
                          className="gyro-primary-button"
                          disabled={!code.trim()}
                        >
                          Unlock
                        </button>
                      </div>
                    </SettingsRow>
                  </SettingsGroup>
                </form>
              ) : (
                <SettingsGroup id="cloud-backup" label="Chat backup" defaultOpen>
                  <SettingsRow
                    label="Set up encrypted backup"
                    detail="Save a recovery code to get started."
                  >
                    <button
                      className="gyro-primary-button"
                      onClick={() =>
                        void run("Generating recovery code…", async () => {
                          setGenerated(
                            (await cloud<{ code: string }>("generate")).code,
                          );
                        })
                      }
                      type="button"
                    >
                      Set up backup
                    </button>
                  </SettingsRow>
                </SettingsGroup>
              )
            ) : (
              <>
                {uploadId && (
                  <SettingsGroup id="cloud-this-chat" label="This chat" defaultOpen>
                    <SettingsRow
                      label="Save an encrypted copy"
                    >
                      <div className="gyro-cloud-actions">
                        {conflict && (
                          <button
                            className="gyro-secondary-button"
                            onClick={() =>
                              void run("Replacing encrypted chat…", () =>
                                upload(conflict),
                              )
                            }
                            type="button"
                          >
                            Replace cloud copy
                          </button>
                        )}
                        <button
                          className="gyro-primary-button"
                          onClick={() =>
                            void run("Uploading encrypted chat…", () => upload())
                          }
                          type="button"
                        >
                          Back up
                        </button>
                      </div>
                    </SettingsRow>
                  </SettingsGroup>
                )}
                <SettingsGroup
                  id="cloud-chats"
                  defaultOpen
                  label="Cloud chats"
                  actions={
                    <button
                      aria-label="Refresh cloud chats"
                      className="gyro-cloud-icon-button"
                      onClick={() => void run("Refreshing library…", refresh)}
                      title="Refresh"
                      type="button"
                    >
                      <RefreshIcon aria-hidden="true" size={14} />
                    </button>
                  }
                >
                  {!page ? (
                    <p className="gyro-cloud-empty">Loading your chats…</p>
                  ) : page.items.length === 0 ? (
                    <p className="gyro-cloud-empty">
                      No cloud chats yet. Choose “Back up to Cloud” from a
                      chat’s menu.
                    </p>
                  ) : null}
                  {page?.items.map((chat) =>
                    removing === chat.id ? (
                      <SettingsRow
                        key={chat.id}
                        label={`Delete the cloud copy of “${chat.title ?? "Encrypted chat"}”?`}
                        detail="Downloaded history stays on this device."
                      >
                        <div className="gyro-cloud-actions">
                          <button
                            className="gyro-secondary-button"
                            onClick={() => setRemoving(undefined)}
                            type="button"
                          >
                            Cancel
                          </button>
                          <button
                            className="gyro-danger-button"
                            onClick={() =>
                              void run("Removing cloud copy…", async () => {
                                await cloud("delete", { id: chat.id });
                                setRemoving(undefined);
                                await refresh();
                                setMessage("Cloud copy removed.");
                              })
                            }
                            type="button"
                          >
                            Delete cloud copy
                          </button>
                        </div>
                      </SettingsRow>
                    ) : (
                      <SettingsRow
                        key={chat.id}
                        label={chat.title ?? "Encrypted chat"}
                        detail={
                          chat.uploadedAt
                            ? `Backed up ${formatCloudDate(chat.uploadedAt)}`
                            : "Backed up"
                        }
                      >
                        <div className="gyro-cloud-actions">
                          <button
                            aria-label={`Delete cloud copy of ${chat.title ?? "Encrypted chat"}`}
                            className="gyro-cloud-icon-button"
                            onClick={() => setRemoving(chat.id)}
                            title="Delete cloud copy"
                            type="button"
                          >
                            <TrashIcon aria-hidden="true" size={14} />
                          </button>
                          <button
                            className="gyro-secondary-button"
                            onClick={() =>
                              void run(
                                "Downloading and verifying chat…",
                                async () => {
                                  setArchive(
                                    await cloud<Archive>("download", {
                                      id: chat.id,
                                    }),
                                  );
                                  setRestored((current) =>
                                    current.includes(chat.id)
                                      ? current
                                      : [...current, chat.id],
                                  );
                                  setMessage("Chat restored.");
                                },
                              )
                            }
                            type="button"
                          >
                            Restore
                          </button>
                        </div>
                      </SettingsRow>
                    ),
                  )}
                  {page?.cursor && (
                    <div className="gyro-cloud-more">
                      <button
                        className="gyro-secondary-button"
                        onClick={() =>
                          void run("Loading more chats…", async () => {
                            const next = await cloud<Page>("list", {
                              cursor: page.cursor,
                            });
                            setPage({
                              ...next,
                              items: [...page.items, ...next.items],
                            });
                          })
                        }
                        type="button"
                      >
                        Load more
                      </button>
                    </div>
                  )}
                </SettingsGroup>
                {restored.length > 0 && (
                  <SettingsGroup
                    id="cloud-downloaded"
                    label="Downloaded history"
                    summary={`${restored.length} on this device`}
                  >
                    {restored.map((id) => (
                      <SettingsRow key={id} label={chatTitle(id)}>
                        <button
                          className="gyro-secondary-button"
                          onClick={() =>
                            void run("Opening history…", async () => {
                              setArchive(await cloud<Archive>("open", { id }));
                            })
                          }
                          type="button"
                        >
                          Open
                        </button>
                      </SettingsRow>
                    ))}
                  </SettingsGroup>
                )}
                {inline && (
                  <SettingsGroup
                    id="cloud-recovery-code"
                    label="Recovery code"
                    summary="Keep it safe"
                  >
                    <p className="gyro-cloud-note">
                      You’ll need it to unlock backups on another device, even
                      after signing in.
                    </p>
                  </SettingsGroup>
                )}
                {archive && (
                  <div ref={archiveRef}>
                    <SettingsGroup
                      id="cloud-archive"
                      defaultOpen
                      label={archive.title}
                      description={`Read-only history · ${formatCloudDate(archive.createdAt)}${archive.model ? ` · ${archive.model}` : ""}`}
                      actions={
                        <button
                          className="gyro-secondary-button"
                          onClick={() => setArchive(undefined)}
                          type="button"
                        >
                          Close
                        </button>
                      }
                    >
                      {archive.messages.map((entry, index) => (
                        <article className="gyro-cloud-message" key={index}>
                          <header>
                            <strong>
                              {
                                {
                                  user: "You",
                                  assistant: "Assistant",
                                  tool: "Tool output",
                                }[entry.kind]
                              }
                            </strong>
                            <small>
                              {formatCloudDate(entry.timestamp)}
                              {entry.model && ` · ${entry.model}`}
                            </small>
                          </header>
                          <ReadOnlyChatMessage
                            kind={entry.kind}
                            text={entry.text}
                          />
                        </article>
                      ))}
                    </SettingsGroup>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </fieldset>
      <CloudNotice failed={failed} message={busy || message} />
    </>
  );
  return inline ? (
    <div className="gyro-cloud-panel">{content}</div>
  ) : (
    <dialog
      ref={dialog}
      className="gyro-cloud-dialog"
      aria-labelledby="gyro-cloud-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose?.();
      }}
    >
      <header>
        <h2 id="gyro-cloud-title">Gyro Cloud</h2>
        <button
          aria-label="Close"
          className="gyro-cloud-icon-button"
          disabled={!!busy}
          onClick={onClose}
          type="button"
        >
          <CloseIcon aria-hidden="true" size={15} />
        </button>
      </header>
      {/* Reuses the Settings surface so groups and rows look the same here. */}
      <div className="gyro-settings-surface gyro-cloud-panel">{content}</div>
    </dialog>
  );
}
