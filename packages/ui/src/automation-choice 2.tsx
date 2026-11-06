import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

export type AutomationChoiceOption = {
  value: string;
  label: string;
  detail?: string;
};

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
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
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

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 24);
      const roomBelow = window.innerHeight - rect.bottom - 12;
      const above = roomBelow < 220 && rect.top > roomBelow;
      const available = above ? rect.top - 12 : roomBelow;
      setPosition({
        width,
        maxHeight: Math.min(320, Math.max(80, available)),
        left: Math.max(
          12,
          Math.min(rect.right - width, window.innerWidth - width - 12),
        ),
        ...(above
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
        transformOrigin: above ? "bottom right" : "top right",
      });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      focusedRef.current = false;
      return;
    }
    if (!position || focusedRef.current) return;
    focusedRef.current = true;
    if (searchable) {
      searchRef.current?.focus();
    } else {
      (
        menuRef.current?.querySelector<HTMLElement>(
          '[role="option"][aria-selected="true"]',
        ) ?? menuRef.current?.querySelector<HTMLElement>('[role="option"]')
      )?.focus();
    }
  }, [open, position, searchable]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
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
      <button
        ref={triggerRef}
        type="button"
        className={"gyro-automation-choice-trigger" + (open ? " is-open" : "")}
        aria-label={label + ": " + (selected?.label ?? "Choose")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
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
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="gyro-automation-choice-menu"
              style={position}
              onKeyDown={onMenuKeyDown}
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
