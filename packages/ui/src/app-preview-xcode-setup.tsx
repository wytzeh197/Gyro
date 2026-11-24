import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  RefreshCw,
  Smartphone,
} from "./icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AppPreviewTarget } from "./app-preview-panel";

export type XcodeDownload =
  | { kind: "app-store" }
  | { kind: "version"; version: string }
  | { kind: "requirements" };

export type XcodeSetup = {
  state:
    | "missing"
    | "incompatible"
    | "first-launch"
    | "runtime"
    | "devices"
    | "ready"
    | "error";
  macos: string | null;
  xcode: string | null;
  detail: string | null;
  download: XcodeDownload;
  devices: AppPreviewTarget[];
};

export type XcodeSetupActions = {
  check(): Promise<XcodeSetup>;
  choose(): Promise<void>;
  open(): Promise<void>;
  download(source: XcodeDownload): Promise<void>;
};

export function ApplePreviewSetup({
  actions,
  onBack,
  onSelect,
}: {
  actions: XcodeSetupActions;
  onBack: () => void;
  onSelect: (target: AppPreviewTarget) => Promise<boolean>;
}) {
  const [setup, setSetup] = useState<XcodeSetup>();
  const [checking, setChecking] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const generation = useRef(0);
  const operation = useRef<"check" | "action" | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  const perform = useCallback(
    async (task?: () => Promise<unknown>, recheck = true) => {
      if (operation.current) return;
      operation.current = task ? "action" : "check";
      const revision = ++generation.current;
      if (task) setWorking(true);
      if (recheck && !task) setChecking(true);
      setError("");
      try {
        await task?.();
        if (revision !== generation.current || !recheck) return;
        if (task) setChecking(true);
        const next = await actions.check();
        if (generation.current === revision) setSetup(next);
      } catch (failure) {
        if (generation.current === revision) setError(String(failure));
      } finally {
        if (generation.current === revision) {
          operation.current = undefined;
          setWorking(false);
          setChecking(false);
        }
      }
    },
    [actions],
  );

  useEffect(() => {
    heading.current?.focus();
    void perform();
    const onFocus = () => void perform();
    window.addEventListener("focus", onFocus);
    return () => {
      generation.current++;
      operation.current = undefined;
      window.removeEventListener("focus", onFocus);
    };
  }, [perform]);

  const state = setup?.state;
  const installCurrent = state === "missing" || state === "incompatible";
  const xcodeInstalled = Boolean(setup?.xcode) && !installCurrent;
  const initialized =
    state === "runtime" || state === "devices" || state === "ready";
  const runtimeInstalled = state === "devices" || state === "ready";
  const device =
    setup?.devices.find((target) => target.id === deviceId) ??
    setup?.devices[0];
  const busy = checking || working;
  const operatingSystem = setup?.macos ? ` on macOS ${setup.macos}` : "";
  const version =
    setup?.download.kind === "version" ? setup.download.version : undefined;
  const getXcodeLabel = version
    ? `Download Xcode ${version}`
    : setup?.download.kind === "requirements"
      ? "View Xcode requirements"
      : "Get Xcode";
  const installText =
    state === "incompatible"
      ? `${setup?.xcode} can’t run on this Mac.`
      : xcodeInstalled
        ? `${setup?.xcode} detected`
        : version
          ? `Xcode ${version} runs${operatingSystem || " on this Mac"}.`
          : "Get a compatible version of Xcode from Apple.";
  const stepIcon = (done: boolean, number: number) => (
    <span className="gyro-apple-setup-step-marker" aria-hidden="true">
      {done ? <Check size={13} /> : number}
    </span>
  );
  const checkLabel = checking ? "Checking…" : "Check again";

  return (
    <section
      className="gyro-app-preview gyro-apple-setup"
      aria-labelledby={headingId}
    >
      <div className="gyro-app-preview-toolbar">
        <button
          className="gyro-apple-setup-back"
          type="button"
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back to Browser
        </button>
      </div>
      <div className="gyro-apple-setup-scroll">
        <div className="gyro-apple-setup-card">
          <header>
            <span className="gyro-apple-setup-icon" aria-hidden="true">
              <Smartphone size={19} />
            </span>
            <div>
              <h2 id={headingId} ref={heading} tabIndex={-1}>
                Set up Apple previews
              </h2>
              <p>
                Build and preview your iPhone and iPad apps in Gyro with Apple’s
                Simulator.
              </p>
            </div>
          </header>
          {setup && (
            <>
              <ol className="gyro-apple-setup-steps">
                <li
                  aria-current={installCurrent ? "step" : undefined}
                  data-step={
                    xcodeInstalled
                      ? "done"
                      : installCurrent
                        ? "current"
                        : "pending"
                  }
                >
                  {stepIcon(xcodeInstalled, 1)}
                  <div>
                    <h3>Install Xcode</h3>
                    <p>{installText}</p>
                    {installCurrent && (
                      <button
                        type="button"
                        data-primary
                        onClick={() =>
                          void perform(
                            () => actions.download(setup.download),
                            false,
                          )
                        }
                        disabled={busy}
                      >
                        {getXcodeLabel}{" "}
                        <ArrowUpRight size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
                <li
                  aria-current={state === "first-launch" ? "step" : undefined}
                  data-step={
                    initialized
                      ? "done"
                      : state === "first-launch"
                        ? "current"
                        : "pending"
                  }
                >
                  {stepIcon(initialized, 2)}
                  <div>
                    <h3>Open Xcode once</h3>
                    <p>
                      {initialized
                        ? "Xcode is ready to build."
                        : "Accept Apple’s terms and finish installing components."}
                    </p>
                    {state === "first-launch" && (
                      <button
                        type="button"
                        data-primary
                        onClick={() => void perform(actions.open, false)}
                        disabled={busy}
                      >
                        Open Xcode <ArrowUpRight size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
                <li
                  aria-current={
                    initialized && state !== "ready" ? "step" : undefined
                  }
                  data-step={
                    state === "ready"
                      ? "done"
                      : initialized
                        ? "current"
                        : "pending"
                  }
                >
                  {stepIcon(state === "ready", 3)}
                  <div>
                    <h3>Install the iOS Simulator runtime</h3>
                    <p>
                      {state === "ready"
                        ? "Choose an available Simulator."
                        : runtimeInstalled
                          ? "The runtime is installed. Add an iPhone or iPad Simulator in Xcode."
                          : "Open Xcode → Settings → Components and download iOS. The same runtime supports iPhone and iPad."}
                    </p>
                    {initialized && state !== "ready" && (
                      <button
                        type="button"
                        data-primary
                        onClick={() => void perform(actions.open, false)}
                        disabled={busy}
                      >
                        Open Xcode <ArrowUpRight size={13} aria-hidden="true" />
                      </button>
                    )}
                    {state === "ready" && device && (
                      <div className="gyro-apple-setup-device">
                        <select
                          aria-label="Simulator device"
                          value={device.id}
                          onChange={(event) => setDeviceId(event.target.value)}
                          disabled={busy}
                        >
                          {setup.devices.map((target) => (
                            <option value={target.id} key={target.id}>
                              {target.title}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          data-primary
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              if (!(await onSelect(device)))
                                throw new Error(
                                  "The Simulator is unavailable. Check again to refresh devices.",
                                );
                            }, false)
                          }
                        >
                          Open preview
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              </ol>
              {(error || setup.detail) && (
                <p className="gyro-apple-setup-error" role="alert">
                  {error || setup.detail}
                </p>
              )}
            </>
          )}
          {!setup && error && (
            <p className="gyro-apple-setup-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <div className="gyro-apple-setup-actions">
              <button
                type="button"
                onClick={() => void perform(actions.choose)}
                disabled={busy}
              >
                Choose Xcode…
              </button>
              <button
                type="button"
                onClick={() => void perform()}
                disabled={busy}
              >
                <RefreshCw size={13} aria-hidden="true" /> {checkLabel}
              </button>
            </div>
            <p role="status">
              {checking
                ? "Checking for Xcode and Simulator…"
                : "Gyro checks again when you return."}
            </p>
          </footer>
        </div>
      </div>
    </section>
  );
}
