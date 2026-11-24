import { Toast as BaseToast } from "@base-ui/react/toast";
import { X } from "../icons";
import { type HTMLAttributes, type ReactNode } from "react";
import { IconButton } from "./button";
import { cx } from "./cx";

/**
 * Transient notices. A toast is a floating surface: `--gyro-shadow-toast`,
 * radius lg, at most 28rem wide, entering over .5s with the out ease.
 */
export type ToastTone = "neutral" | "info" | "success" | "warning" | "danger";

/** A persistent notice whose lifetime belongs to the calling surface. */
export function ToastSurface({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: ToastTone }) {
  return <div className={cx("gyro-toast", className)} data-tone={tone} {...props} />;
}

export interface ToastProviderProps {
  children?: ReactNode;
  /** Milliseconds before a toast closes itself. `0` keeps it until dismissed. */
  timeout?: number;
  /** Toasts shown at once; older ones queue behind. */
  limit?: number;
  closeLabel?: string;
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts } = BaseToast.useToastManager();
  return (
    <>
      {toasts.map((toast) => (
        <BaseToast.Root
          key={toast.id}
          toast={toast}
          className="gyro-toast"
          data-tone={toast.type ?? "neutral"}
        >
          <BaseToast.Content className="gyro-toast__content">
            {toast.title ? (
              <BaseToast.Title className="gyro-toast__title" />
            ) : null}
            {toast.description ? (
              <BaseToast.Description className="gyro-toast__description" />
            ) : null}
            {toast.actionProps ? (
              <BaseToast.Action className="gyro-btn gyro-btn--outline gyro-btn--xs gyro-toast__action" />
            ) : null}
          </BaseToast.Content>
          <BaseToast.Close
            className="gyro-toast__close"
            aria-label={closeLabel}
            render={<IconButton label={closeLabel} size="xs" />}
          >
            <X aria-hidden size={12} />
          </BaseToast.Close>
        </BaseToast.Root>
      ))}
    </>
  );
}

/** Mount once near the root. `useToast()` works anywhere beneath it. */
export function ToastProvider({
  children,
  timeout = 5000,
  limit = 3,
  closeLabel = "Dismiss",
}: ToastProviderProps) {
  return (
    <BaseToast.Provider timeout={timeout} limit={limit}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="gyro-toast-viewport">
          <ToastList closeLabel={closeLabel} />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

export interface ToastOptions {
  title?: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  timeout?: number;
  action?: { label: ReactNode; onClick: () => void };
}

/** Shows and dismisses toasts. */
export function useToast() {
  const manager = BaseToast.useToastManager();
  return {
    toasts: manager.toasts,
    close: manager.close,
    show: ({ tone = "neutral", action, ...options }: ToastOptions) =>
      manager.add({
        ...options,
        type: tone,
        actionProps: action
          ? { children: action.label, onClick: action.onClick }
          : undefined,
      }),
  };
}
