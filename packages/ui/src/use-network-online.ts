import { useEffect, useState } from "react";

/** Browser connection hint; provider reachability still comes from its status. */
export function useNetworkOnline(): boolean {
  const [isOnline, setIsOnline] = useState(
    () => globalThis.navigator?.onLine ?? true,
  );
  useEffect(() => {
    const update = () => setIsOnline(globalThis.navigator?.onLine ?? true);
    window.addEventListener("offline", update);
    window.addEventListener("online", update);
    // Cover a transition between the initial read and subscription.
    update();
    return () => {
      window.removeEventListener("offline", update);
      window.removeEventListener("online", update);
    };
  }, []);
  return isOnline;
}
