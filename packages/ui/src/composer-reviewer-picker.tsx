import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Check, CircleMinus, Search, X } from "./icons";
import { Popover } from "./primitives/popup";
import { ProviderLogo } from "./workspace-sidebar";
import type { ComposerReviewer } from "./composer-inline-draft";

import type { ModelProviderConfig, ProviderId, ProviderStatus } from "./types";
import { formatCompactTokenCount } from "./token-count";
import { isProviderRuntimeUsable } from "./provider-catalog";

/** Text for a picker that chooses something other than a second opinion. */
export type ModelPickerCopy = {
  title: string;
  description: string;
  removeLabel: string;
  emptyLabel?: string;
};

const SECOND_OPINION_COPY: ModelPickerCopy = {
  title: "Choose a reviewer",
  description:
    "After the task finishes, your chosen reviewer gets the original request, captured file changes, and any included project memory.",
  removeLabel: "Remove second opinion",
};

export type ReviewerOption = ComposerReviewer & {
  providerLabel: string;
  connection?: "API" | "Local";
  contextWindowTokens?: number;
};

export function connectedReviewerOptions(
  providers: ModelProviderConfig[],
  statuses?: ProviderStatus[],
): ReviewerOption[] {
  return providers.flatMap((provider) => {
    const kind = provider.capabilities?.executionKind;
    if (
      kind !== "claude-code" &&
      kind !== "ollama-api" &&
      kind !== "openai-compatible-api"
    )
      return [];
    if (
      !isProviderRuntimeUsable(
        provider,
        statuses?.find((status) => status.id === provider.id),
      )
    )
      return [];
    return provider.models.map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: model.displayName,
      providerLabel: provider.displayName,
      connection:
        kind === "ollama-api"
          ? "Local"
          : kind === "openai-compatible-api"
            ? "API"
            : undefined,
      contextWindowTokens: model.contextWindowTokens,
    }));
  });
}

export function ComposerReviewerPicker({
  options,
  selected,
  textarea,
  onChoose,
  onRemove,
  onDismiss,
  normalChat,
  inline = false,
  copy = SECOND_OPINION_COPY,
}: {
  normalChat: boolean;
  inline?: boolean;
  copy?: ModelPickerCopy;
  options: ReviewerOption[];
  selected?: ComposerReviewer;
  textarea: RefObject<HTMLTextAreaElement>;
  onChoose: (option: ComposerReviewer) => void;
  onRemove: () => void;
  onDismiss: () => void;
}) {
  const descriptionId = useId();
  const pane = textarea.current?.closest(
    ".gyro-chat-surface.is-tiled, .gyro-chat-companion",
  );
  const search = useRef<HTMLInputElement>(null);
  const [providerStrip, setProviderStrip] = useState<HTMLDivElement | null>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProviderId | "all">(
    selected?.providerId ?? "all",
  );

  const providers = new Map(
    options.map((option) => [option.providerId, option.providerLabel]),
  );
  const provider = filter !== "all" && providers.has(filter) ? filter : "all";
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const groups = new Map<ProviderId, ReviewerOption[]>();
  const matches = options.filter((option) => {
    if (provider !== "all" && option.providerId !== provider) return false;
    const text = [
      option.label,
      option.modelId,
      option.providerLabel,
      option.providerId,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  for (const option of matches) {
    const group = groups.get(option.providerId);
    if (group) group.push(option);
    else groups.set(option.providerId, [option]);
  }
  const current = matches.find(
    (option) =>
      option.providerId === selected?.providerId &&
      option.modelId === selected.modelId,
  );
  const preferred = current ?? matches[0];

  useLayoutEffect(() => {
    if (list) (search.current ?? remove.current)?.focus({ preventScroll: true });
  }, [list]);

  useLayoutEffect(() => {
    const active = providerStrip?.querySelector<HTMLElement>(
      '[aria-pressed="true"]',
    );
    if (!providerStrip || !active) return;
    const bounds = providerStrip.getBoundingClientRect();
    const chip = active.getBoundingClientRect();
    if (chip.left < bounds.left || chip.right > bounds.right) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [provider, providerStrip]);
  useLayoutEffect(() => {
    if (!list) return;
    list.scrollTop = 0;
    const active = list.querySelector<HTMLElement>(
      '[aria-current="true"]',
    );
    if (active && !query) active.scrollIntoView({ block: "nearest" });
  }, [query, provider, list]);

  function choose({ providerId, modelId, label }: ComposerReviewer) {
    onChoose({ providerId, modelId, label });
  }

  function navigateResults(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.target === search.current
    ) {
      return;
    }
    const { key } = event;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
    const rows = Array.from(
      list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (!rows.length) return;
    const current = rows.findIndex((row) => row === event.target);
    const step = key === "ArrowDown" ? 1 : -1;
    let next = (current + step + rows.length) % rows.length;
    if (key === "Home") next = 0;
    if (key === "End" || (current === -1 && key === "ArrowUp")) {
      next = rows.length - 1;
    }
    event.preventDefault();
    event.stopPropagation();
    rows[next]?.focus();
  }

  return (
    <Popover.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        const editor = textarea.current;
        if (
          editor &&
          ((details.reason === "outside-press" &&
            details.event.target === editor) ||
            (details.reason === "focus-out" &&
              details.event instanceof FocusEvent &&
              details.event.relatedTarget === editor))
        ) {
          details.cancel();
          return;
        }
        onDismiss();
        if (details.reason === "escape-key") {
          editor?.focus({ preventScroll: true });
        }
      }}
    >
      <Popover.Content
        inline={inline}
        anchor={() =>
          textarea.current?.closest(".gyro-composer-shell") ?? textarea.current
        }
        side="top"
        align="start"
        sideOffset={8}
        alignOffset={8}
        collisionBoundary={pane ?? undefined}
        aria-label={copy.title}
        aria-describedby={options.length ? descriptionId : undefined}
        initialFocus={options.length ? search : remove}
        finalFocus={false}
        className="gyro-reviewer-menu"
        onKeyDown={navigateResults}
      >
        <header className="gyro-reviewer-controls">
          <div className="gyro-reviewer-title">
            <strong>{copy.title}</strong>
            {options.length > 0 && (
              <span className="gyro-sr-only" role="status">
                {matches.length} {matches.length === 1 ? "model" : "models"}
              </span>
            )}
          </div>
          {options.length > 0 && (
            <>
              <p className="gyro-reviewer-description" id={descriptionId}>
                {copy.description}
              </p>
              <div className="gyro-reviewer-search">
                <Search aria-hidden="true" size={15} />
                <input
                  ref={search}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Search reviewer models"
                  placeholder="Search models…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (preferred) choose(preferred);
                    } else if (
                      event.key === "ArrowDown" ||
                      event.key === "ArrowUp"
                    ) {
                      event.preventDefault();
                      const rows =
                      list?.querySelectorAll<HTMLButtonElement>(
                          '[role="menuitem"]',
                        );
                      const next =
                        event.key === "ArrowUp"
                          ? rows?.[rows.length - 1]
                        : list?.querySelector<HTMLButtonElement>(
                              '[tabindex="0"]',
                            );
                      next?.focus();
                    }
                  }}
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear model search"
                    onClick={() => {
                      setQuery("");
                      search.current?.focus();
                    }}
                  >
                    <X aria-hidden="true" size={13} />
                  </button>
                )}
              </div>
              <div
                ref={setProviderStrip}
                className="gyro-reviewer-providers"
                role="group"
                aria-label="Filter by provider"
              >
                <button
                  type="button"
                  aria-pressed={provider === "all"}
                  onClick={() => setFilter("all")}
                >
                  All
                </button>
                {Array.from(providers, ([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={provider === id}
                    onClick={() => setFilter(id)}
                  >
                    <ProviderLogo providerId={id} label={label} />
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </header>
        <div
          ref={setList}
          className="gyro-reviewer-results"
          role="menu"
          aria-label="Reviewer models"
        >
          {Array.from(groups, ([id, models]) => (
            <div
              className="gyro-reviewer-group"
              key={id}
              role="group"
              aria-label={providers.get(id)}
            >
              <div className="gyro-reviewer-group-heading" aria-hidden="true">
                <span>
                  <ProviderLogo providerId={id} label={providers.get(id)} />
                  {providers.get(id)}
                  {models[0]?.connection && <em>{models[0].connection}</em>}
                </span>
              </div>
              {models.map((option) => (
                <button
                  key={option.modelId}
                  type="button"
                  role="menuitem"
                  className="gyro-reviewer-option"
                  tabIndex={option === preferred ? 0 : -1}
                  aria-current={option === current || undefined}
                  onClick={() => choose(option)}
                >
                  <span className="gyro-reviewer-check" aria-hidden="true">
                    {option === current && <Check size={13} strokeWidth={2.5} />}
                  </span>
                  <span className="gyro-reviewer-model-name">{option.label}</span>
                  {option.contextWindowTokens !== undefined &&
                    option.contextWindowTokens > 0 && (
                      <small
                        aria-label={
                          option.contextWindowTokens + " context tokens"
                        }
                      >
                        {formatCompactTokenCount(option.contextWindowTokens)}
                      </small>
                    )}
                </button>
              ))}
            </div>
          ))}
          {matches.length === 0 && (
            <p className="gyro-reviewer-empty" role="status">
              {options.length
                ? "No matching models"
                : copy.emptyLabel ?? (normalChat
                  ? "Set up Claude Code, an API provider, or Ollama in Settings → Models & accounts."
                  : "Switch to normal chat to send with a reviewer.")}
            </p>
          )}
        </div>
        <footer>
          <button ref={remove} type="button" onClick={onRemove}>
            <CircleMinus aria-hidden="true" size={14} />
            {copy.removeLabel}
          </button>
        </footer>
      </Popover.Content>
    </Popover.Root>
  );
}
