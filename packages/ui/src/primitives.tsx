import { Check, ChevronDown, X } from "lucide-react";
import { createPortal } from "react-dom";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/*
 * Gyro's shared controls. Each concept has exactly one implementation here and
 * one rule set in the "Primitives" section at the end of styles.css; surfaces
 * compose these instead of styling their own buttons, menus, badges and
 * dialogs.
 */

const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ Button */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "small" | "medium";

/** Class string for elements that must stay native (e.g. <summary>, <a>). */
export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ControlSize = "medium",
  extra?: string,
) {
  return cx(
    "gyro-button",
    `is-${variant}`,
    size === "small" && "is-small",
    extra,
  );
}

export function Button({
  variant = "secondary",
  size = "medium",
  icon,
  className,
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      className={buttonClass(variant, size, className)}
      type={type}
    >
      {icon}
      {children}
    </button>
  );
}

export function iconButtonClass(size: ControlSize = "medium", extra?: string) {
  return cx("gyro-icon-button", size === "small" && "is-small", extra);
}

export function IconButton({
  label,
  size = "medium",
  className,
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Accessible name; icon buttons have no visible text. */
  label: string;
  size?: ControlSize;
}) {
  return (
    <button
      {...props}
      aria-label={props["aria-label"] ?? label}
      className={iconButtonClass(size, className)}
      title={props.title ?? label}
      type={type}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- Segmented */

export type SegmentedOption<T extends string> = {
  label: ReactNode;
  value: T;
  title?: string;
  disabled?: boolean;
};

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "medium",
  className,
}: {
  label: string;
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: ControlSize;
  className?: string;
}) {
  return (
    <div
      aria-label={label}
      className={cx("gyro-segmented", size === "small" && "is-small", className)}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={value === option.value ? "is-active" : undefined}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- SelectMenu */

export type SelectMenuOption = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

/**
 * The one dropdown. A button that opens a portaled listbox with keyboard
 * navigation, type-ahead, optional search, and flip-above placement.
 */
export function SelectMenu({
  label,
  value,
  options,
  onChange,
  searchable = false,
  disabled = false,
  placeholder,
  size = "medium",
  className,
  menuWidth = 240,
  showLabel = false,
}: {
  label: string;
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  disabled?: boolean;
  placeholder?: string;
  size?: ControlSize;
  className?: string;
  menuWidth?: number;
  /** Prefix the trigger with the label, e.g. "Minimap: On". */
  showLabel?: boolean;
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
      const width = Math.min(
        Math.max(menuWidth, rect.width),
        window.innerWidth - 24,
      );
      const roomBelow = window.innerHeight - rect.bottom - 12;
      const above = roomBelow < 220 && rect.top > roomBelow;
      const available = above ? rect.top - 12 : roomBelow;
      setPosition({
        width,
        maxHeight: Math.min(320, Math.max(80, available)),
        // Hang from the trigger's left edge when the menu fits there;
        // otherwise align right edges so it never leaves the window.
        left:
          rect.left + width <= window.innerWidth - 12
            ? Math.max(12, rect.left)
            : Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        ...(above
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
        transformOrigin: above ? "bottom left" : "top left",
      });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, menuWidth]);

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
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const trigger = triggerRef.current;
      const scope = trigger?.closest("form, section, [role='dialog']") ?? document;
      const fields = Array.from(
        scope.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
        ),
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
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ) ?? [],
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
      items
        .find((item) =>
          item.textContent
            ?.trim()
            .toLowerCase()
            .startsWith(event.key.toLowerCase()),
        )
        ?.focus();
    }
  };

  const triggerText =
    selected?.label ?? placeholder ?? "Choose " + label.toLowerCase();
  return (
    <div className={cx("gyro-select", className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cx(
          "gyro-select-trigger",
          size === "small" && "is-small",
          open && "is-open",
        )}
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
        <span>
          {showLabel ? <em>{label}</em> : null}
          {triggerText}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="gyro-select-menu"
              style={position}
              onKeyDown={onMenuKeyDown}
            >
              {searchable ? (
                <input
                  ref={searchRef}
                  className="gyro-select-search"
                  type="search"
                  aria-label={"Search " + label.toLowerCase()}
                  placeholder={"Search " + label.toLowerCase()}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : null}
              <div
                id={listId}
                className="gyro-select-list"
                role="listbox"
                aria-label={label}
              >
                {visible.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={cx(
                      "gyro-select-option",
                      option.value === value && "is-selected",
                    )}
                    disabled={option.disabled}
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
                  <p className="gyro-select-empty">No matches</p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function optionText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(optionText).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return optionText(node.props.children);
  return "";
}

/** Reads `<option>` children the way a native <select> would. */
export function optionsFromChildren(children: ReactNode): SelectMenuOption[] {
  const options: SelectMenuOption[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<{
        value?: string | number;
        children?: ReactNode;
        disabled?: boolean;
      }>(child))
        return;
      if (child.type === "option") {
        const label = optionText(child.props.children).replace(/\s+/g, " ").trim();
        options.push({
          value: String(child.props.value ?? label),
          label,
          disabled: child.props.disabled,
        });
      } else if (child.props.children) {
        visit(child.props.children);
      }
    });
  visit(children);
  return options;
}

/**
 * SelectMenu with a native-select call shape: `<option>` children and an
 * onChange that receives `{ target: { value } }`, so existing <select>
 * markup moves over without rewriting its handlers.
 */
export function OptionSelect({
  label,
  "aria-label": ariaLabel,
  value,
  onChange,
  children,
  disabled,
  className,
  size,
  showLabel,
}: {
  label?: string;
  "aria-label"?: string;
  value: string | number | undefined;
  onChange?: (event: { target: { value: string } }) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  size?: ControlSize;
  showLabel?: boolean;
}) {
  return (
    <SelectMenu
      className={className}
      disabled={disabled}
      label={label ?? ariaLabel ?? "Choose"}
      onChange={(next) => onChange?.({ target: { value: next } })}
      options={optionsFromChildren(children)}
      showLabel={showLabel}
      size={size}
      value={String(value ?? "")}
    />
  );
}

/* ------------------------------------------------------------ Badge & Dot */

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

export function Badge({
  tone = "neutral",
  className,
  children,
  title,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cx("gyro-badge", className)} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Dot({
  tone = "neutral",
  pulse = false,
  label,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  /** Screen-reader text; omit when the dot repeats visible text. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cx("gyro-dot", pulse && "is-pulsing", className)}
      data-tone={tone}
      role={label ? "img" : undefined}
    />
  );
}

/* ------------------------------------------- Empty, loading, and skeletons */

export function EmptyState({
  icon,
  title,
  detail,
  action,
  compact = false,
  className,
  role,
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  /** Inline one-liner for lists and panels instead of a centred block. */
  compact?: boolean;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div
      className={cx("gyro-empty-state", compact && "is-compact", className)}
      role={role}
    >
      {icon ? (
        <span aria-hidden="true" className="gyro-empty-state-icon">
          {icon}
        </span>
      ) : null}
      <div className="gyro-empty-state-copy">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {action ? <div className="gyro-empty-state-action">{action}</div> : null}
    </div>
  );
}

export function Spinner({
  size = 14,
  label,
  className,
}: {
  size?: number;
  /** Screen-reader text; omit when visible text already says "Loading…". */
  label?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cx("gyro-spinner", className)}
      role={label ? "status" : undefined}
      style={{ "--gyro-spinner-size": `${size}px` } as CSSProperties}
    />
  );
}

/** Placeholder rows while a list or panel loads. */
export function Skeleton({
  lines = 3,
  label = "Loading",
  className,
}: {
  lines?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cx("gyro-skeleton", className)}
      role="status"
    >
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} style={{ width: `${92 - ((index * 23) % 40)}%` }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Dialog */

/**
 * The one modal shell: native <dialog> in the top layer (so nothing can stack
 * over it), Escape and backdrop click to dismiss, focus moved in on open and
 * restored on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  tone,
  actions,
  children,
  className,
  role = "dialog",
  closeLabel = "Close",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: "danger";
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: "dialog" | "alertdialog";
  closeLabel?: string;
  /** Show the close button and allow Escape / backdrop to dismiss. */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    const first = dialog.querySelector<HTMLElement>(
      "[data-autofocus], input:not([type='hidden']):not(:disabled), textarea:not(:disabled), .gyro-dialog-actions .is-primary:not(:disabled), .gyro-dialog-actions .is-danger:not(:disabled), .gyro-dialog-actions button:not(:disabled)",
    );
    first?.focus();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={cx("gyro-dialog", tone && `is-${tone}`, className)}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onCloseRef.current();
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget)
          onCloseRef.current();
      }}
      ref={ref}
      role={role}
    >
      <div className="gyro-dialog-panel">
        <header className="gyro-dialog-header">
          {icon ? (
            <span aria-hidden="true" className="gyro-dialog-icon">
              {icon}
            </span>
          ) : null}
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          {dismissible ? (
            <IconButton
              className="gyro-dialog-close"
              label={closeLabel}
              onClick={() => onCloseRef.current()}
              size="small"
            >
              <X size={14} />
            </IconButton>
          ) : null}
        </header>
        {children ? <div className="gyro-dialog-body">{children}</div> : null}
        {actions ? <footer className="gyro-dialog-actions">{actions}</footer> : null}
      </div>
    </dialog>,
    document.body,
  );
}
