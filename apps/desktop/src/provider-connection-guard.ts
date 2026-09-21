import { useCallback, useRef, useState } from "react";
import type { ProviderId } from "@gyro-dev/ui";

export type ProviderConnectionRunner = (
  providerId: ProviderId,
  options?: { forceLogin?: boolean },
) => Promise<boolean>;

/**
 * One connection attempt per provider at a time. A second request for a
 * provider that is already connecting is refused instead of queued, and the
 * in-flight set is what the provider surfaces read to disable their controls.
 */
export function useProviderConnectionGuard(
  runConnection: ProviderConnectionRunner,
) {
  const inFlight = useRef(new Set<ProviderId>());
  const [connectingProviderIds, setConnectingProviderIds] = useState<
    ProviderId[]
  >([]);
  const connectProvider = useCallback(
    async (
      providerId: ProviderId,
      options?: { forceLogin?: boolean },
    ): Promise<boolean> => {
      if (inFlight.current.has(providerId)) return false;
      inFlight.current.add(providerId);
      setConnectingProviderIds([...inFlight.current]);
      try {
        return await runConnection(providerId, options);
      } finally {
        inFlight.current.delete(providerId);
        setConnectingProviderIds([...inFlight.current]);
      }
    },
    [runConnection],
  );
  return { connectProvider, connectingProviderIds };
}
