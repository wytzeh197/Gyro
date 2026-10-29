import {
  Check,
  CircleDashed,
  Copy,
  ExternalLink,
  Plus,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { groupModelsByClass } from "./model-classes";
import { clippingBounds } from "./composer-popover-bounds";
import {
  ProviderSignInContext,
  type ProviderSignIn,
} from "./provider-sign-in-context";

export type ModelRailProvider = {
  id: string;
  label: string;
  /** The connection this catalog entry launches. CLI and API are not one list. */
  connection: "CLI" | "API" | "Local";
  connected: boolean;
  models: {
    id: string;
    displayName: string;
    description?: string;
    contextWindowTokens?: number;
  }[];
};

/** "1M", "400K": the only size worth reading at a glance. */
function contextLabel(tokens?: number) {
  if (!tokens || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** Marks which ends of a scroller hide content, so CSS fades only those ends. */
function useScrollEdges(
  ref: { current: HTMLElement | null },
  contentKey?: string,
) {
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const update = () => {
      scroller.dataset.overflowStart = String(scroller.scrollTop > 1);
      scroller.dataset.overflowEnd = String(
        scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1,
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref, contentKey]);
}

/** Whose account a CLI provider signs in with, in the words its sign-in page uses. */
const SIGN_IN_ACCOUNTS: Record<string, string> = {
  anthropic: "Claude",
  cursor: "Cursor",
  gemini: "Google",
  kimi: "Kimi",
  openai: "ChatGPT",
  xai: "xAI",
};

function connectPrompt(provider: ModelRailProvider) {
  if (provider.connection === "API") {
    return `Add a ${provider.label} API key to use its models here.`;
  }
  if (provider.connection === "Local") {
    return `Start ${provider.label} on this computer to use its models here.`;
  }
  const account = SIGN_IN_ACCOUNTS[provider.id];
  return account
    ? `Sign in with your ${account} account to use ${provider.label} models here.`
    : `Sign in to ${provider.label} to use its models here.`;
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

/**
 * Sign-in progress for a provider that is not connected yet. The login CLI
 * runs out of sight; this shows only what the person has to do next, and the
 * terminal stays one click away for anything the parse did not catch.
 */
function SignInProgress({
  provider,
  signIn,
  onConnect,
}: {
  provider: ModelRailProvider;
  signIn: ProviderSignIn;
  onConnect: (providerId: string) => void;
}) {
  const actions = useContext(ProviderSignInContext);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState<string>();
  const copy = (key: string, value: string) => {
    copyText(value);
    setCopied(key);
    window.setTimeout(
      () => setCopied((current) => (current === key ? undefined : current)),
      1600,
    );
  };
  const secondary = (
    <div className="gyro-model-rail-signin-links">
      {signIn.phase === "failed" || signIn.phase === "not-installed" ? null : (
        <button onClick={() => actions.cancel(provider.id)} type="button">
          Cancel
        </button>
      )}
      <button onClick={() => actions.showDetails(provider.id)} type="button">
        Show details
      </button>
    </div>
  );

  if (signIn.phase === "not-installed") {
    return (
      <>
        <p>
          {signIn.message ?? `${provider.label} needs its CLI installed first.`}
        </p>
        {signIn.installCommand ? (
          <>
            <button
              className="gyro-model-rail-signin-command"
              onClick={() => copy("install", signIn.installCommand ?? "")}
              title={`Copy: ${signIn.installCommand}`}
              type="button"
            >
              <code>{signIn.installCommand}</code>
              {copied === "install" ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button
              className="is-primary"
              onClick={() => actions.install(provider.id)}
              type="button"
            >
              Install and sign in
            </button>
          </>
        ) : (
          <button onClick={() => onConnect(provider.id)} type="button">
            Try again
          </button>
        )}
      </>
    );
  }

  if (signIn.phase === "failed") {
    return (
      <>
        <p>{signIn.message ?? `${provider.label} sign-in didn't finish.`}</p>
        <button
          className="is-primary"
          onClick={() => onConnect(provider.id)}
          type="button"
        >
          Try again
        </button>
        {secondary}
      </>
    );
  }

  if (signIn.phase === "starting" || signIn.phase === "installing") {
    return (
      <>
        <p className="gyro-model-rail-signin-status" role="status">
          <CircleDashed aria-hidden="true" className="is-spinning" size={13} />
          {signIn.phase === "installing"
            ? "Installing…"
            : "Checking for an existing sign-in…"}
        </p>
        {signIn.phase === "installing" ? secondary : null}
      </>
    );
  }

  return (
    <>
      <p className="gyro-model-rail-signin-status" role="status">
        <CircleDashed aria-hidden="true" className="is-spinning" size={13} />
        {signIn.deviceCode
          ? "Enter this code on the sign-in page"
          : "Waiting for browser sign-in"}
      </p>
      {signIn.deviceCode ? (
        <button
          aria-label={`Copy code ${signIn.deviceCode}`}
          className="gyro-model-rail-signin-code"
          onClick={() => copy("code", signIn.deviceCode ?? "")}
          type="button"
        >
          <code>{signIn.deviceCode}</code>
          {copied === "code" ? <Check size={13} /> : <Copy size={13} />}
        </button>
      ) : null}
      {signIn.url ? (
        <div className="gyro-model-rail-signin-row">
          <button onClick={() => actions.openLink(provider.id)} type="button">
            <ExternalLink aria-hidden="true" size={12} />
            {signIn.deviceCode ? "Open page" : "Reopen page"}
          </button>
          <button onClick={() => copy("url", signIn.url ?? "")} type="button">
            {copied === "url" ? (
              <Check aria-hidden="true" size={12} />
            ) : (
              <Copy aria-hidden="true" size={12} />
            )}
            {copied === "url" ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
      {signIn.acceptsCode ? (
        <form
          className="gyro-model-rail-signin-paste"
          onSubmit={(event) => {
            event.preventDefault();
            const value = code.trim();
            if (!value) return;
            actions.submitCode(provider.id, value);
            setCode("");
          }}
        >
          <input
            aria-label="Authorization code"
            autoComplete="off"
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste code"
            spellCheck={false}
            value={code}
          />
          <button disabled={!code.trim()} type="submit">
            Submit
          </button>
        </form>
      ) : null}
      {secondary}
    </>
  );
}

/**
 * Providers down a rail of their own marks, the previewed provider's models
 * beside it. A provider's models show only once its mark is clicked (or
 * arrowed to), so sweeping the pointer across the rail never swaps the list,
 * and the rail keeps its order so a logo is always where the hand remembers it.
 */
export function ComposerModelRail({
  id,
  placement,
  align = "end",
  providers,
  activeProviderId,
  activeModelId,
  warning,
  renderLogo,
  onSelectModel,
  onConnect,
  onManageProviders,
}: {
  id: string;
  placement: "up" | "down";
  /** Which chip edge the panel hangs from; a chip on the left opens rightward. */
  align?: "start" | "end";
  providers: ModelRailProvider[];
  activeProviderId?: string;
  activeModelId?: string;
  /** Shown above the list while the provider in use needs attention. */
  warning?: string;
  renderLogo: (provider: ModelRailProvider) => ReactNode;
  onSelectModel: (providerId: string, modelId: string) => void;
  onConnect: (providerId: string) => void;
  onManageProviders: () => void;
}) {
  const connected = providers.filter((provider) => provider.connected);
  const available = providers.filter((provider) => !provider.connected);
  const [previewId, setPreviewId] = useState(
    () =>
      connected.find((provider) => provider.id === activeProviderId)?.id ??
      connected[0]?.id ??
      providers[0]?.id,
  );
  const preview = providers.find((provider) => provider.id === previewId);
  const { signIns } = useContext(ProviderSignInContext);
  const previewSignIn =
    preview && !preview.connected ? signIns[preview.id] : undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const [resolvedPlacement, setResolvedPlacement] = useState(placement);
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useScrollEdges(railRef);
  useScrollEdges(listRef, previewId);

  // Land on the model in use so Enter re-confirms and arrows start from it.
  useEffect(() => {
    const target =
      listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]') ??
      railRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    target?.focus({ preventScroll: false });
    // Only on open: later previews must not steal focus from the rail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anchor to this composer's chip, then fit inside its split pane or clipping
  // container. Re-measure on pane resize, not only when the window resizes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const control = panel?.parentElement;
    if (!panel || !control) return;
    const position = (event?: Event) => {
      if (event?.target instanceof Node && panel.contains(event.target)) return;
      const listScroll = listRef.current?.scrollTop ?? 0;
      const railScroll = railRef.current?.scrollTop ?? 0;
      const bounds = clippingBounds(panel);
      const pad = 12;
      const gap = 6;
      const anchor = control.getBoundingClientRect();
      // Gyro's interface zoom scales CSS pixels; bounds are viewport pixels.
      const controlStyle = window.getComputedStyle(control);
      const scaleX = anchor.width / parseFloat(controlStyle.width) || 1;
      const scaleY = anchor.height / parseFloat(controlStyle.height) || 1;
      const availableWidth =
        Math.max(0, bounds.right - bounds.left - pad * 2) / scaleX;
      panel.style.maxWidth = `${availableWidth}px`;
      panel.style.maxHeight = "";
      const above = Math.max(0, anchor.top - bounds.top - pad - gap);
      const below = Math.max(0, bounds.bottom - anchor.bottom - pad - gap);
      const preferred = placement === "up" ? above : below;
      const opposite = placement === "up" ? below : above;
      const direction =
        panel.offsetHeight * scaleY > preferred && opposite > preferred
          ? placement === "up"
            ? "down"
            : "up"
          : placement;
      panel.style.top = direction === "down" ? "calc(100% + 6px)" : "auto";
      panel.style.bottom = direction === "up" ? "calc(100% + 6px)" : "auto";
      panel.style.maxHeight = `${(direction === "up" ? above : below) / scaleY}px`;
      // Use layout dimensions so the opening animation cannot skew the anchor.
      const width = panel.offsetWidth * scaleX;
      const naturalLeft = align === "start" ? anchor.left : anchor.right - width;
      const left = Math.min(
        Math.max(naturalLeft, bounds.left + pad),
        bounds.right - pad - width,
      );
      panel.style.translate = `${(left - naturalLeft) / scaleX}px 0`;
      setResolvedPlacement(direction);
      if (listRef.current) listRef.current.scrollTop = listScroll;
      if (railRef.current) railRef.current.scrollTop = railScroll;
    };
    position();
    const observer = new ResizeObserver(() => position());
    // A companion dock can resize an inner container while the pane and chip
    // keep their dimensions. Observe the whole layout path to the window.
    for (
      let ancestor: HTMLElement | null = control;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor);
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [placement, align]);

  const focusIn = (container: HTMLElement | null, selector: string) =>
    Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? []);

  const onRailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = focusIn(railRef.current, '[role="tab"]');
    const index = tabs.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      const tab = tabs[(next + tabs.length) % tabs.length];
      tab?.focus();
      if (tab?.dataset.providerId) setPreviewId(tab.dataset.providerId);
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(tabs.length - 1);
    else if (event.key === "ArrowRight") {
      const items = focusIn(listRef.current, '[role="menuitemradio"], button');
      (
        items.find((item) => item.getAttribute("aria-checked") === "true") ??
        items[0]
      )?.focus();
    } else return;
    event.preventDefault();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = focusIn(listRef.current, '[role="menuitemradio"]');
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") items[(index + 1) % items.length]?.focus();
    else if (event.key === "ArrowUp")
      items[(index - 1 + items.length) % items.length]?.focus();
    else if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowLeft")
      railRef.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
    else return;
    event.preventDefault();
  };

  const railTile = (provider: ModelRailProvider) => {
    const selected = provider.id === previewId;
    const inUse = provider.connected && provider.id === activeProviderId;
    return (
      <button
        aria-controls={`${id}-models`}
        aria-label={
          provider.connected
            ? provider.label
            : `${provider.label}, not connected`
        }
        aria-selected={selected}
        className={[
          "gyro-model-rail-tile",
          selected ? "is-selected" : "",
          inUse ? "is-in-use" : "",
          provider.connected ? "" : "is-disconnected",
        ]
          .filter(Boolean)
          .join(" ")}
        data-provider-id={provider.id}
        key={provider.id}
        onClick={() => setPreviewId(provider.id)}
        role="tab"
        tabIndex={selected ? 0 : -1}
        title={provider.label}
        type="button"
      >
        {renderLogo(provider)}
      </button>
    );
  };

  // Each class keeps its models together (every Opus by Opus), in the order
  // the class first appears in the provider's catalog.
  const previewClasses = groupModelsByClass(
    preview?.models ?? [],
    (model) => model.displayName,
  );
  const modelRow = (model: ModelRailProvider["models"][number]) => {
    if (!preview) return null;
    const checked =
      preview.id === activeProviderId && model.id === activeModelId;
    const context = contextLabel(model.contextWindowTokens);
    return (
      <button
        aria-checked={checked}
        className={`gyro-model-rail-model${checked ? " is-active" : ""}`}
        key={model.id}
        onClick={() => onSelectModel(preview.id, model.id)}
        role="menuitemradio"
        tabIndex={checked ? 0 : -1}
        title={model.description}
        type="button"
      >
        <span className="gyro-model-rail-model-name">{model.displayName}</span>
        {context ? (
          <span
            className="gyro-model-rail-context"
            title={`${model.contextWindowTokens?.toLocaleString()} token context`}
          >
            {context}
          </span>
        ) : null}
        <span aria-hidden="true" className="gyro-model-rail-check">
          {checked ? <Check size={14} /> : null}
        </span>
      </button>
    );
  };

  const showWarning = Boolean(warning && preview?.id === activeProviderId);
  const isPreviewInUse = preview?.connected && preview.id === activeProviderId;

  return (
    <div
      aria-label="Choose a model"
      className="gyro-composer-popover gyro-model-rail"
      data-align={align}
      data-placement={resolvedPlacement}
      id={id}
      ref={panelRef}
      role="dialog"
    >
      <div className="gyro-model-rail-side">
        <div
          aria-label="Providers"
          aria-orientation="vertical"
          className="gyro-model-rail-providers"
          onKeyDown={onRailKeyDown}
          ref={railRef}
          role="tablist"
        >
          {connected.map(railTile)}
          {available.length > 0 ? (
            <>
              {connected.length > 0 ? (
                <span aria-hidden="true" className="gyro-model-rail-divider" />
              ) : null}
              {available.map(railTile)}
            </>
          ) : null}
        </div>
        {/* Outside the scroller, so the gear never sits on half a logo. */}
        <button
          aria-label="Manage providers"
          className="gyro-model-rail-tile is-utility"
          onClick={onManageProviders}
          tabIndex={-1}
          title="Manage providers"
          type="button"
        >
          <Settings2 size={15} />
        </button>
      </div>

      <div
        aria-labelledby={`${id}-heading`}
        className="gyro-model-rail-pane"
        id={`${id}-models`}
        role="tabpanel"
      >
        {preview ? (
          <>
            <header className="gyro-model-rail-head">
              <strong id={`${id}-heading`}>{preview.label}</strong>
              <small className="gyro-model-rail-status">
                <span className="gyro-model-rail-connection">
                  {preview.connected
                    ? preview.connection
                    : previewSignIn?.phase === "installing"
                      ? "Installing…"
                      : previewSignIn?.phase === "starting" ||
                          previewSignIn?.phase === "waiting"
                        ? "Signing in…"
                        : "Not connected"}
                </span>
                {preview.connected ? (
                  <span className={isPreviewInUse ? "is-in-use" : undefined}>
                    {isPreviewInUse
                      ? "In use"
                      : `${preview.models.length} ${preview.models.length === 1 ? "model" : "models"}`}
                  </span>
                ) : null}
              </small>
            </header>
            {showWarning ? (
              <p className="gyro-model-rail-warning" role="status">
                <TriangleAlert aria-hidden="true" size={13} />
                <span>{warning}</span>
              </p>
            ) : null}
            {preview.connected && preview.models.length > 0 ? (
              <div
                aria-label={`${preview.label} models`}
                className="gyro-model-rail-list"
                key={preview.id}
                onKeyDown={onListKeyDown}
                ref={listRef}
                role="menu"
              >
                {previewClasses.headed
                  ? previewClasses.groups.map((modelClass) => (
                      <div
                        aria-labelledby={`${id}-class-${modelClass.id}`}
                        className="gyro-model-rail-class"
                        key={modelClass.id}
                        role="group"
                      >
                        <span
                          className="gyro-model-rail-class-label"
                          id={`${id}-class-${modelClass.id}`}
                        >
                          {modelClass.label}
                        </span>
                        {modelClass.models.map(modelRow)}
                      </div>
                    ))
                  : previewClasses.groups.flatMap((modelClass) =>
                      modelClass.models.map(modelRow),
                    )}
              </div>
            ) : preview.connected ? (
              <div className="gyro-model-rail-empty" ref={listRef}>
                <p>No models found for {preview.label}.</p>
                <button onClick={onManageProviders} type="button">
                  Open provider settings
                </button>
              </div>
            ) : (
              <div
                className="gyro-model-rail-empty"
                key={preview.id}
                ref={listRef}
              >
                <span aria-hidden="true" className="gyro-model-rail-empty-mark">
                  {renderLogo(preview)}
                </span>
                {previewSignIn ? (
                  <SignInProgress
                    onConnect={onConnect}
                    provider={preview}
                    signIn={previewSignIn}
                  />
                ) : (
                  <>
                    <p>{connectPrompt(preview)}</p>
                    <button
                      className="is-primary"
                      onClick={() => onConnect(preview.id)}
                      type="button"
                    >
                      <Plus aria-hidden="true" size={13} />
                      Connect
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="gyro-model-rail-empty" ref={listRef}>
            <p>No providers available yet.</p>
            <button onClick={onManageProviders} type="button">
              Open provider settings
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
