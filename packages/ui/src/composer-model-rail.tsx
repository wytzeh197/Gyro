import { Check, Plus, Settings2, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { groupModelsByClass } from "./model-classes";

export type ModelRailProvider = {
  id: string;
  label: string;
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

/**
 * Providers down a rail of their own marks, the previewed provider's models
 * beside it. A provider's models show only once its mark is clicked (or
 * arrowed to), so sweeping the pointer across the rail never swaps the list,
 * and the rail keeps its order so a logo is always where the hand remembers it.
 */
export function ComposerModelRail({
  id,
  placement,
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
  const panelRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Keep the panel inside the window when the chip sits near an edge.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const position = () => {
      panel.style.translate = "";
      const rect = panel.getBoundingClientRect();
      const shift = Math.max(
        12 - rect.left,
        Math.min(0, window.innerWidth - 12 - rect.right),
      );
      panel.style.translate = `${shift}px 0`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel.parentElement!);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [placement]);

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
      data-align="end"
      data-placement={placement}
      id={id}
      ref={panelRef}
      role="dialog"
    >
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
              <small>
                {!preview.connected
                  ? "Not connected"
                  : isPreviewInUse
                    ? "In use"
                    : `${preview.models.length} ${preview.models.length === 1 ? "model" : "models"}`}
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
              <div className="gyro-model-rail-empty" ref={listRef}>
                <span aria-hidden="true" className="gyro-model-rail-empty-mark">
                  {renderLogo(preview)}
                </span>
                <p>Connect {preview.label} to use its models here.</p>
                <button
                  className="is-primary"
                  onClick={() => onConnect(preview.id)}
                  type="button"
                >
                  <Plus aria-hidden="true" size={13} />
                  Connect
                </button>
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
