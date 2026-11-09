import { createElement, memo, useRef, type ComponentType } from "react";

type Callback = (...args: unknown[]) => unknown;

/**
 * Memoizes a component whose parent recreates its callback props on every
 * render. Each top-level function prop is swapped for a proxy that keeps its
 * identity for the life of the element and always calls the latest handler, so
 * the memoized component re-renders only when data props change, without ever
 * running a stale closure. A prop that becomes undefined is passed through as
 * undefined, so components that branch on a handler's presence stay correct.
 * Functions nested inside object props are not proxied: memoize those objects
 * at the call site.
 */
export function memoWithStableCallbacks<P extends object>(
  component: ComponentType<P>,
): ComponentType<P> {
  const Memoized = memo(component) as unknown as ComponentType<P>;
  function StableCallbacks(props: P) {
    const latest = useRef(props);
    // Assigned during render so a child effect or handler that runs before
    // this component's own effects still reaches the newest handler.
    latest.current = props;
    const proxies = useRef(new Map<string, Callback>());
    const stable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value !== "function") {
        stable[key] = value;
        continue;
      }
      let proxy = proxies.current.get(key);
      if (!proxy) {
        proxy = (...args: unknown[]) =>
          (latest.current as Record<string, Callback | undefined>)[key]?.(
            ...args,
          );
        proxies.current.set(key, proxy);
      }
      stable[key] = proxy;
    }
    return createElement(Memoized, stable as P);
  }
  StableCallbacks.displayName = `Stable(${component.displayName ?? component.name ?? "Component"})`;
  return StableCallbacks;
}
