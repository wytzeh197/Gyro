import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Trash2 } from "lucide-react";

export function ScmFileActions({
  path,
  onDiscard,
}: {
  path: string;
  onDiscard?: (path: string) => void | Promise<void>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const close = () => setPosition(undefined);
  const toggle = () => {
    if (position) {
      close();
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 204)),
      top:
        rect.bottom + 48 <= window.innerHeight - 8
          ? rect.bottom + 4
          : Math.max(8, rect.top - 44),
    });
  };
  useLayoutEffect(() => {
    if (!position) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const next = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 204)),
      top: rect.bottom + 48 <= window.innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - 44),
    };
    if (next.left !== position.left || next.top !== position.top) setPosition(next);
  }, [position]);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const pointer = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        trigger.current?.focus();
      }
      if (event.key === "Tab") close();
    };
    window.addEventListener("pointerdown", pointer);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", pointer);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="gyro-scm-file-actions-trigger"
        aria-label={`Actions for ${path}`}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={toggle}
      >
        <MoreHorizontal size={14} />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            className="gyro-scm-file-actions-menu"
            style={position}
            role="menu"
            aria-label={`Actions for ${path}`}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!onDiscard}
              onClick={() => {
                close();
                trigger.current?.focus();
                if (
                  window.confirm(
                    `Discard all local changes in ${path}? This cannot be undone.`,
                  )
                )
                  void onDiscard?.(path);
              }}
            >
              <Trash2 size={14} />
              <span>Discard local changes</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
