import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ChevronRight,
  Info,
  LoaderCircle,
  MoreHorizontal,
} from "../../../../packages/ui/node_modules/lucide-react";
import {
  SettingsEmptyState,
  SettingsSelect,
} from "../../../../packages/ui/src/settings-controls";
import { SettingsStatus } from "../../../../packages/ui/src/settings-presentation";
import {
  DeviceIcon,
  setDeviceKind,
  useDeviceKind,
} from "../../../../packages/ui/src/device-kind";
import { useRemoteAccess } from "./context";
import type { Peer, SshOptions } from "./types";

export function SshSettings() {
  const { action, status, selectHost, refreshCatalog } = useRemoteAccess();
  const id = useId();
  const manualInput = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState("");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [authentication, setAuthentication] = useState("config");
  const [identityFile, setIdentityFile] = useState("");
  const [socketPath, setSocketPath] = useState("");
  const hosts = status?.sshHosts ?? [];
  useEffect(() => {
    if (error || notice) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [error, notice]);
  useEffect(() => {
    let disposed = false;
    void action<string[]>({ action: "sshHosts" }).then(
      (values) => {
        if (!disposed) {
          setAliases(values);
          setLoading(false);
        }
      },
      (e) => {
        if (!disposed) {
          setError(String(e));
          setLoading(false);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [action]);
  async function run(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
    }
  }
  async function connect(hostId?: string) {
    const options: SshOptions = {
      host: (manual ? address : host).trim(),
      ...(manual && user.trim() ? { user: user.trim() } : {}),
      ...(port ? { port: Number(port) } : {}),
      ...(authentication === "file"
        ? { identityFile: identityFile.trim() }
        : {}),
      ...(socketPath.trim() ? { socketPath: socketPath.trim() } : {}),
    };
    if (!hostId && !options.host) {
      setError("Choose an SSH host or enter an address to continue.");
      return;
    }
    await run(hostId ?? "new", async () => {
      const peer = await action<Peer>({
        action: "sshConnect",
        ...(hostId ? { hostId } : { options }),
      });
      setNotice(
        `Connected to ${peer.name}. Its projects are available in your sidebar.`,
      );
      void refreshCatalog();
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void connect();
  }
  return (
    <div className="gyro-remote-ssh" aria-label="SSH connections">
      <p className="gyro-remote-method-description">
        Connect using your existing SSH setup.
      </p>
      <section
        className="gyro-remote-ssh-saved"
        aria-labelledby={`${id}-saved`}
      >
        <h2 id={`${id}-saved`}>Saved SSH hosts</h2>
        <div className="gyro-remote-ssh-hosts">
          {hosts.length ? (
            hosts.map((saved) => (
              <div className="gyro-remote-ssh-host" key={saved.id}>
                <SshHostIcon id={saved.id} name={saved.name} />
                <div className="gyro-remote-ssh-host-name">
                  <strong>{saved.name}</strong>
                  <span>
                    {saved.options.user ? `${saved.options.user}@` : ""}
                    {saved.options.host}
                    {saved.options.port ? ` · Port ${saved.options.port}` : ""}
                  </span>
                </div>
                <SettingsStatus status={saved.connected ? "good" : "neutral"}>
                  {busy === saved.id
                    ? "Connecting…"
                    : saved.connected
                      ? "Connected"
                      : "Not connected"}
                </SettingsStatus>
                <details className="gyro-remote-ssh-menu">
                  <summary aria-label={`Options for ${saved.name}`}>
                    <MoreHorizontal size={19} />
                  </summary>
                  <div>
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={(e) => {
                        e.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                        if (saved.connected)
                          selectHost({
                            id: saved.id,
                            name: saved.name,
                            role: "host",
                            transport: "ssh",
                          });
                        else void connect(saved.id);
                      }}
                    >
                      {saved.connected ? "Open projects" : "Connect"}
                    </button>
                    {saved.connected && (
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={(e) => {
                          e.currentTarget
                            .closest("details")
                            ?.removeAttribute("open");
                          void run("manage", async () => {
                            await action({
                              action: "sshDisconnect",
                              hostId: saved.id,
                            });
                            void refreshCatalog();
                          });
                        }}
                      >
                        Disconnect
                      </button>
                    )}
                    <SshHostKindToggle id={saved.id} name={saved.name} />
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={(e) => {
                        e.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                        void run("manage", async () => {
                          await action({
                            action: "sshRemove",
                            hostId: saved.id,
                          });
                          void refreshCatalog();
                        });
                      }}
                    >
                      Remove host
                    </button>
                  </div>
                </details>
              </div>
            ))
          ) : (
            <SettingsEmptyState
              title="No saved SSH hosts"
              description="Connect to a host below to save it here."
            />
          )}
        </div>
      </section>
      <form className="gyro-remote-ssh-form" onSubmit={submit}>
        <h2>New SSH connection</h2>
        <fieldset disabled={Boolean(busy)}>
          {!manual ? (
            <div className="gyro-remote-ssh-fields">
              <label htmlFor={`${id}-host`}>SSH host</label>
              <SettingsSelect
                id={`${id}-host`}
                value={host}
                onChange={(event) => setHost(event.target.value)}
                aria-describedby={`${id}-hosts-help`}
              >
                <option value="">
                  {loading ? "Reading SSH config…" : "Choose from SSH config…"}
                </option>
                {aliases.map((alias) => (
                  <option key={alias} value={alias}>
                    {alias}
                  </option>
                ))}
              </SettingsSelect>
              <button
                type="button"
                className="gyro-remote-text-button"
                onClick={() => {
                  setManual(true);
                  setError(undefined);
                  requestAnimationFrame(() => manualInput.current?.focus());
                }}
              >
                Enter an address manually
              </button>
              <span id={`${id}-hosts-help`} className="gyro-remote-ssh-help">
                {!loading && !aliases.length
                  ? "No named hosts found in your SSH config. Enter an address manually."
                  : "Host settings come from your SSH config."}
              </span>
            </div>
          ) : (
            <div className="gyro-remote-ssh-fields">
              <label>
                Host address
                <input
                  className="gyro-settings-input"
                  ref={manualInput}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="mac-mini.local"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <div className="gyro-remote-ssh-field-pair">
                <label>
                  User
                  <input
                    className="gyro-settings-input"
                    value={user}
                    onChange={(event) => setUser(event.target.value)}
                    placeholder="Default SSH user"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Port
                  <input
                    className="gyro-settings-input"
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder="22"
                  />
                </label>
              </div>
              <button
                type="button"
                className="gyro-remote-text-button"
                onClick={() => setManual(false)}
              >
                Choose from SSH config instead
              </button>
            </div>
          )}
          <details
            className="gyro-remote-ssh-advanced"
            onInvalidCapture={(event) => {
              event.currentTarget.open = true;
            }}
          >
            <summary>
              <ChevronRight size={16} aria-hidden />
              Advanced settings
            </summary>
            <div className="gyro-remote-ssh-fields">
              <label>
                Authentication
                <SettingsSelect
                  value={authentication}
                  onChange={(event) => setAuthentication(event.target.value)}
                >
                  <option value="config">SSH agent or configured key</option>
                  <option value="file">Identity file</option>
                </SettingsSelect>
              </label>
              {authentication === "file" && (
                <label>
                  Identity file
                  <input
                    className="gyro-settings-input"
                    value={identityFile}
                    onChange={(event) => setIdentityFile(event.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    required
                    spellCheck={false}
                  />
                </label>
              )}
              {!manual && (
                <label>
                  Port override
                  <input
                    className="gyro-settings-input"
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder="From SSH config"
                  />
                </label>
              )}
              <label>
                Remote Gyro socket path
                <input
                  className="gyro-settings-input"
                  value={socketPath}
                  onChange={(event) => setSocketPath(event.target.value)}
                  placeholder="Default Gyro data directory"
                  spellCheck={false}
                />
                <span className="gyro-remote-ssh-help">
                  Optional. Use an absolute path for a custom Gyro data
                  directory.
                </span>
              </label>
            </div>
          </details>
        </fieldset>
        <div className="gyro-remote-ssh-connect">
          <div>
            <p>Authentication uses your SSH agent or configured key.</p>
            <p>
              <Info size={15} aria-hidden />
              The host needs Remote Login enabled and Gyro open with remote
              access on.
            </p>
          </div>
          <button
            className="gyro-primary-button"
            type="submit"
            disabled={Boolean(busy) || loading}
          >
            {busy === "new" && (
              <LoaderCircle
                className="gyro-remote-ssh-spinner"
                size={15}
                aria-hidden
              />
            )}
            {busy === "new" ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
      {error && (
        <p ref={feedback} className="gyro-remote-ssh-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p ref={feedback} className="gyro-remote-ssh-notice" role="status">
          {notice}
        </p>
      )}
      <p className="gyro-remote-ssh-footer">
        Connected projects appear in your sidebar.
      </p>
    </div>
  );
}

function SshHostIcon({ id, name }: { id: string; name: string }) {
  return <DeviceIcon kind={useDeviceKind(id, name)} size={20} aria-hidden />;
}

/** The menu offers the other icon, so a Mac mini reached over SSH can show as a desktop. */
function SshHostKindToggle({ id, name }: { id: string; name: string }) {
  const next = useDeviceKind(id, name) === "laptop" ? "desktop" : "laptop";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.currentTarget.closest("details")?.removeAttribute("open");
        setDeviceKind(id, next);
      }}
    >
      {next === "laptop" ? "Show as laptop" : "Show as desktop"}
    </button>
  );
}
