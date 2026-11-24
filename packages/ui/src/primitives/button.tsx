import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { Spinner } from "./feedback";

export type ButtonVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "prominent"
  | "outline"
  | "primary-outline"
  | "destructive-outline"
  | "ghost"
  | "chrome"
  | "subtle"
  | "link";

export type ButtonSize = "chip" | "xs" | "sm" | "md" | "lg" | "xl";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Fully rounded ends, for send and toolbar capsules. */
  shape?: "default" | "capsule";
  /** Shows a spinner in place of the leading icon and blocks presses. */
  loading?: boolean;
  /** Icon before the label. Rendered at the size's icon size. */
  leading?: ReactNode;
  /** Icon or hint after the label. */
  trailing?: ReactNode;
}

function buttonClassName(
  variant: ButtonVariant,
  size: ButtonSize,
  shape: "default" | "capsule",
  icon: boolean,
  className: string | undefined,
): string {
  return cx(
    "gyro-btn",
    `gyro-btn--${variant}`,
    `gyro-btn--${size}`,
    shape === "capsule" && "gyro-btn--capsule",
    icon && "gyro-btn--icon",
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "default",
      size = "md",
      shape = "default",
      loading = false,
      leading,
      trailing,
      className,
      children,
      disabled,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName(variant, size, shape, false, className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        {...props}
      >
        {loading ? <Spinner decorative /> : leading}
        {children !== undefined && children !== null && children !== false ? (
          <span className="gyro-btn__label">{children}</span>
        ) : null}
        {trailing}
      </button>
    );
  },
);

export interface IconButtonProps
  extends Omit<ButtonProps, "leading" | "trailing" | "children"> {
  /** Accessible name; icon buttons have no visible text. */
  label: string;
  /** Optional when the icon is supplied by a wrapping part's `render`. */
  children?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      variant = "ghost",
      size = "md",
      shape = "default",
      loading = false,
      label,
      disabled,
      className,
      children,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        disabled={disabled || loading}
        className={buttonClassName(variant, size, shape, true, className)}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        {...props}
      >
        {loading ? <Spinner decorative /> : children}
      </button>
    );
  },
);
