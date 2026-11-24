import { Check, ChevronDown } from "./icons";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "./primitives";

export type AutomationChoiceOption = {
  value: string;
  label: string;
  detail?: string;
};

/** A listbox choice on the shared popover surface, with optional search. */
export function AutomationChoice({
  label,
  value,
  options,
  onChange,
  searchable = false,
  disabled = false,
}: {
  label: string;
  value: string;
  options: AutomationChoiceOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const visible =
    searchable && query.trim()
      ? options.filter((option) =>
          (option.label + " " + (option.detail ?? ""))
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
      : options;

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      // Tab leaves the choice for the next form field, as a native select does.
      event.preventDefault();
      const trigger = triggerRef.current;
      const fields = Array.from(
        trigger
          ?.closest("form")
          ?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
          ) ?? [],
      ).filter((field) => field.getClientRects().length > 0);
      const index = trigger ? fields.indexOf(trigger) : -1;
      fields[index + (event.shiftKey ? -1 : 1)]?.focus();
      setOpen(false);
      return;
    }
    if (
      event.key === "Enter" &&
      event.target === searchRef.current &&
      visible[0]
    ) {
      event.preventDefault();
      choose(visible[0].value);
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    if (!items.length) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1) % items.length
              : current < 0
                ? items.length - 1
                : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (
      !searchable &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const match = items.find((item) =>
        item.textContent
          ?.trim()
          .toLowerCase()
          .startsWith(event.key.toLowerCase()),
      );
      match?.focus();
    }
  };

  return (
    <div className="gyro-automation-choice">
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (next) setQuery("");
          setOpen(next);
        }}
      >
        <Popover.Trigger
          ref={triggerRef}
          className={
            "gyro-automation-choice-trigger" + (open ? " is-open" : "")
          }
          aria-label={label + ": " + (selected?.label ?? "Choose")}
          aria-haspopup="listbox"
          disabled={disabled || options.length === 0}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setQuery("");
              setOpen(true);
            }
          }}
        >
          <span>{selected?.label ?? "Choose " + label.toLowerCase()}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Content
          ref={menuRef}
          align="end"
          className="gyro-automation-choice-menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          initialFocus={() =>
            searchable
              ? searchRef.current
              : (menuRef.current?.querySelector<HTMLElement>(
                  '[role="option"][aria-selected="true"]',
                ) ??
                menuRef.current?.querySelector<HTMLElement>('[role="option"]') ??
                true)
          }
        >
          {searchable ? (
            <input
              ref={searchRef}
              className="gyro-automation-choice-search"
              type="search"
              aria-label={"Search " + label.toLowerCase()}
              placeholder={"Search " + label.toLowerCase()}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <div
            id={listId}
            className="gyro-automation-choice-list"
            role="listbox"
            aria-label={label}
          >
            {visible.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={
                  "gyro-automation-choice-option" +
                  (option.value === value ? " is-selected" : "")
                }
                onClick={() => choose(option.value)}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.detail ? <small>{option.detail}</small> : null}
                </span>
                {option.value === value ? (
                  <Check size={14} aria-hidden="true" />
                ) : null}
              </button>
            ))}
            {visible.length === 0 ? (
              <p className="gyro-automation-choice-empty">No matches</p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}
