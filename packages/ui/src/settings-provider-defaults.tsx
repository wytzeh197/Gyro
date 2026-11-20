import { Check, ChevronDown } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { GyroConfig, ModelProviderConfig, ProviderId } from "./types";
import { clippingBounds, popoverViewportRect } from "./composer-popover-bounds";
import { useOutsidePointerDismiss } from "./menu-dismiss";
import { providerDetailsPosition } from "./provider-details-position";
import { providerDefaultModelId, providersForConfig } from "./provider-catalog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./settings-controls";

export function ProviderDefaultModelPicker({
  provider,
  selectedId,
  onChange,
}: {
  provider: ModelProviderConfig;
  selectedId: string;
  onChange: (id: ProviderId, model: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const picker = useOutsidePointerDismiss<HTMLDivElement>(
    isOpen,
    () => setIsOpen(false),
    trigger,
  );
  const menuId = useId();
  const modelLabel =
    provider.models.find((model) => model.id === selectedId)?.displayName ??
    selectedId;
  const label = `${provider.displayName} default model`;

  useLayoutEffect(() => {
    const anchor = trigger.current;
    const panel = menu.current;
    if (!isOpen || !anchor || !panel) return;

    const position = (event?: Event) => {
      if (event?.target === panel) return;
      const scrollTop = panel.scrollTop;
      panel.style.maxHeight = "";
      const { top, bottom, zoom } = popoverViewportRect(anchor);
      const bounds = clippingBounds(panel, popoverViewportRect);
      if (bottom <= bounds.top || top >= bounds.bottom) {
        setIsOpen(false);
        return;
      }
      const menuHeight = popoverViewportRect(panel).height;
      const fitted = providerDetailsPosition({
        anchorTop: top,
        anchorBottom: bottom,
        boundsTop: bounds.top,
        boundsBottom: bounds.bottom,
        menuHeight,
        prefersUp: false,
        gap: 4 * zoom,
      });
      panel.style.top = `${(fitted.top - top) / zoom}px`;
      panel.style.maxHeight = `${Math.min(menuHeight, fitted.maxHeight) / zoom}px`;
      panel.scrollTop = scrollTop;
    };

    position();
    const current = panel.querySelector<HTMLElement>('[aria-checked="true"]');
    (current ?? panel.querySelector<HTMLElement>("button"))?.focus();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    const observer = new ResizeObserver(() => position());
    observer.observe(anchor);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [isOpen]);

  return (
    <div className="gyro-provider-default-picker" ref={picker}>
      <button
        aria-controls={isOpen ? menuId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${label}: ${modelLabel}`}
        className="gyro-provider-model-trigger"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setIsOpen(true);
          menu.current
            ?.querySelector<HTMLElement>('[aria-checked="true"]')
            ?.focus();
        }}
        ref={trigger}
        title={modelLabel}
        type="button"
      >
        <span>{modelLabel}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      {isOpen ? (
        <div
          aria-label={label}
          className="gyro-provider-model-menu"
          id={menuId}
          onKeyDown={(event) => {
            const { key } = event;
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
            const items = [...event.currentTarget.querySelectorAll("button")];
            const current = items.findIndex((item) => item === event.target);
            const next =
              key === "Home" ? 0 :
              key === "End" ? items.length - 1 :
              (current + items.length + (key === "ArrowDown" ? 1 : -1)) % items.length;
            event.preventDefault();
            items[next]?.focus();
          }}
          ref={menu}
          role="menu"
        >
          {provider.models.map((model) => (
            <button
              aria-checked={model.id === selectedId}
              key={model.id}
              onClick={() => {
                setIsOpen(false);
                trigger.current?.focus({ preventScroll: true });
                if (model.id !== selectedId) onChange(provider.id, model.id);
              }}
              role="menuitemradio"
              tabIndex={-1}
              title={model.displayName}
              type="button"
            >
              <span>{model.displayName}</span>
              {model.id === selectedId ? <Check aria-hidden="true" size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderModelDefaults({
  config,
  onChange,
  mark,
}: {
  config: GyroConfig;
  onChange?: (id: ProviderId, model: string) => void;
  mark?: (id: ProviderId) => ReactNode;
}) {
  const providers = providersForConfig(config).filter((p) => p.enabled);
  return (
    <SettingsGroup
      id="provider-model-defaults"
      label="Per-provider model defaults"
      summary={
        providers.length
          ? `${providers.length} enabled providers`
          : "No enabled providers"
      }
    >
      {providers.length ? (
        providers.map((p) => (
          <SettingsRow
            key={p.id}
            label={p.displayName}
            detail="Shared by the provider picker and new-chat defaults."
          >
            <span aria-hidden="true">{mark?.(p.id)}</span>
            <SettingsSelect
              aria-label={`${p.displayName} default model`}
              disabled={!onChange || !p.models.length}
              value={providerDefaultModelId(p) ?? ""}
              onChange={(e) => onChange?.(p.id, e.target.value)}
            >
              {!p.models.length ? (
                <option value="">Unavailable</option>
              ) : (
                p.models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.displayName}
                  </option>
                ))
              )}
            </SettingsSelect>
          </SettingsRow>
        ))
      ) : (
        <p>Connect a provider to choose its model default.</p>
      )}
    </SettingsGroup>
  );
}
