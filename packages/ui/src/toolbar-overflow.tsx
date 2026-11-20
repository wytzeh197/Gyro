import { SurfacePresence } from "./surface-presence";
import { MoreHorizontal } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useOutsidePointerDismiss } from "./menu-dismiss";

/** A toolbar's secondary actions, using the shared dismissal/keyboard contract. */
export function ToolbarOverflow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useOutsidePointerDismiss<HTMLDivElement>(
    open,
    () => setOpen(false),
    trigger,
  );

  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const element = menu.current;
    const anchor = trigger.current.getBoundingClientRect();
    const gap = Number.parseFloat(
      getComputedStyle(element).getPropertyValue("--gyro-space-compact"),
    );
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(gap, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - gap))}px`;
    element.style.top = `${Math.max(gap, Math.min(anchor.bottom + gap, innerHeight - bounds.height - gap))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = () => setOpen(false);
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [open, menu]);

  return (
    <>
      <button
        aria-label={label}
        title={open ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={13} />
      </button>
      <SurfacePresence portal="body">
        {open ? (
          <div
            className="gyro-explorer-context-menu gyro-toolbar-overflow-menu"
            id={id}
            ref={menu}
            role="menu"
            aria-label={label}
            onClick={(event) => {
              const action = (event.target as Element).closest("button");
              if (action && !action.disabled) setOpen(false);
            }}
          >
            {children}
          </div>
        ) : null}
      </SurfacePresence>
    </>
  );
}
