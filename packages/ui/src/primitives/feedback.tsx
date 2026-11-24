import {
  forwardRef,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Loader, Loader2 } from "../icons";
import { cx } from "./cx";
import { useTimelineSynchronizedAnimations } from "./animation-timeline-sync";

export type SpinnerSize = "inherit" | "xs" | "sm" | "md" | "lg";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /** Accessible status text. Ignored when `decorative`. */
  label?: string;
  /** Hide from assistive tech, for spinners inside a control that already reports busy. */
  decorative?: boolean;
}

/** An indeterminate loading indicator. One spin keyframe for the whole app. */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(
  function Spinner(
    { size = "inherit", label = "Loading", decorative = false, className, ...props },
    ref,
  ) {
    return (
      <span
        ref={ref}
        className={cx("gyro-spinner", `gyro-spinner--${size}`, className)}
        role={decorative ? undefined : "status"}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative || undefined}
        {...props}
      >
        <Loader2 aria-hidden="true" />
      </span>
    );
  },
);

export interface LiveStatusSpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /** A slower cadence for long-running background work. */
  pace?: "default" | "slow";
}

/**
 * The spinner for running agent turns. Every instance is phase-locked to the
 * document timeline, so a column of running rows ticks in unison instead of
 * each spinner starting from its own mount time.
 *
 * Ported from Synara (MIT, © 2026 T3 Tools Inc., Emanuele Di Pietro).
 * See THIRD_PARTY_NOTICES.md.
 */
export function LiveStatusSpinner({
  size = "inherit",
  pace = "default",
  className,
  ...props
}: LiveStatusSpinnerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useTimelineSynchronizedAnimations(ref);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cx("gyro-spinner", "gyro-spinner--live", `gyro-spinner--${size}`, className)}
      data-pace={pace === "slow" ? "slow" : undefined}
      {...props}
    >
      <Loader aria-hidden="true" />
    </span>
  );
}

export interface ShimmerProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

/** Text that sweeps while work is in progress, phase-locked like the live spinner. */
export function Shimmer({ className, children, ...props }: ShimmerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useTimelineSynchronizedAnimations(ref);
  return (
    <span ref={ref} className={cx("gyro-shimmer", className)} {...props}>
      {children}
    </span>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** Width as any CSS length. Defaults to the full line. */
  width?: string;
  /** Height as any CSS length. Defaults to one line of UI text. */
  height?: string;
  shape?: "line" | "block" | "circle";
}

/** A placeholder for content that is still loading. */
export function Skeleton({
  width,
  height,
  shape = "line",
  className,
  style,
  ...props
}: SkeletonProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useTimelineSynchronizedAnimations(ref);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cx("gyro-skeleton", className)}
      data-shape={shape}
      style={{ ...style, width, height }}
      {...props}
    />
  );
}

export interface EmptyProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The icon shown in the tile above the title. */
  icon?: ReactNode;
  /** Two optional flanking icons, tilted either side of the main tile. */
  sideIcons?: [ReactNode, ReactNode];
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links below the description. */
  actions?: ReactNode;
  size?: "default" | "compact";
}

/** The one empty state: a quiet icon tile, a title, an explanation and actions. */
export const Empty = forwardRef<HTMLDivElement, EmptyProps>(function Empty(
  { icon, sideIcons, title, description, actions, size = "default", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx("gyro-empty-view", className)}
      data-size={size === "compact" ? "compact" : undefined}
      {...props}
    >
      {icon ? (
        <div className="gyro-empty-view__media" aria-hidden="true">
          {sideIcons ? (
            <span className="gyro-empty-view__side" data-side="start">
              {sideIcons[0]}
            </span>
          ) : null}
          <span className="gyro-empty-view__tile">{icon}</span>
          {sideIcons ? (
            <span className="gyro-empty-view__side" data-side="end">
              {sideIcons[1]}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="gyro-empty-view__title">{title}</div>
      {description ? (
        <div className="gyro-empty-view__description">{description}</div>
      ) : null}
      {actions ? <div className="gyro-empty-view__actions">{actions}</div> : null}
    </div>
  );
});

export type ChipTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** Show the leading status dot. */
  dot?: boolean;
  /** Pulse the dot, for live states. */
  pulse?: boolean;
}

/** A compact status label with an optional live dot. */
export const StatusChip = forwardRef<HTMLSpanElement, StatusChipProps>(
  function StatusChip(
    { tone = "neutral", dot = false, pulse = false, className, children, ...props },
    ref,
  ) {
    return (
      <span
        ref={ref}
        className={cx("gyro-chip", className)}
        data-tone={tone}
        {...props}
      >
        {dot ? (
          <span
            className="gyro-chip__dot"
            data-pulse={pulse || undefined}
            aria-hidden="true"
          />
        ) : null}
        {children}
      </span>
    );
  },
);

export type KbdProps = HTMLAttributes<HTMLElement>;

/** One key of a keyboard shortcut. */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd(
  { className, ...props },
  ref,
) {
  return <kbd ref={ref} className={cx("gyro-kbd", className)} {...props} />;
});

export function Keycap({ className, ...props }: KbdProps) {
  return <Kbd className={cx("gyro-keycap", className)} {...props} />;
}

export interface ShortcutPillProps extends HTMLAttributes<HTMLSpanElement> {
  /** Keys in order, for example `["⌘", "K"]`. */
  keys: readonly string[];
}

/** A full shortcut in a soft pill, for menus, tooltips and composer hints. */
export function ShortcutPill({ keys, className, ...props }: ShortcutPillProps) {
  return (
    <span
      className={cx("gyro-shortcut", className)}
      aria-label={keys.join(" ")}
      {...props}
    >
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className="gyro-shortcut__key" aria-hidden="true">
          {key}
        </kbd>
      ))}
    </span>
  );
}
