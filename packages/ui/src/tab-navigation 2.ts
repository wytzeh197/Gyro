import type { KeyboardEvent } from "react";

/** Arrow navigation is shared by content tabs; modified keys retain their shortcuts. */
export function navigateTabList(event: KeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab")
    return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).filter(
    (tab) => !tab.disabled && tab.getAttribute("aria-disabled") !== "true",
  );
  const index = tabs.indexOf(target as HTMLButtonElement);
  if (index < 0 || !tabs.length) return;
  const next =
    event.key === "ArrowRight"
      ? (index + 1) % tabs.length
      : event.key === "ArrowLeft"
        ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  tabs[next]?.focus();
  tabs[next]?.click();
  tabs[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
