import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchPreferences } from "@gyro-dev/ui";

export type AppearanceSaveStatus = "saving" | "saved" | "error";
type AppearancePreferences = Pick<
  WorkbenchPreferences,
  | "theme"
  | "interfaceSize"
  | "density"
  | "motionSpeed"
  | "mainColor"
  | "secondaryColor"
>;

export function appearanceSaveKey(preferences: AppearancePreferences) {
  return JSON.stringify([
    preferences.theme,
    preferences.interfaceSize,
    preferences.density,
    preferences.motionSpeed,
    preferences.mainColor,
    preferences.secondaryColor,
  ]);
}

/** An older write must never acknowledge newer appearance changes. */
export function createAppearanceSaveTracker(initial: AppearancePreferences) {
  let requestedKey = appearanceSaveKey(initial);
  let pendingKey: string | undefined;
  return {
    changed(
      preferences: AppearancePreferences,
    ): AppearanceSaveStatus | undefined {
      const nextKey = appearanceSaveKey(preferences);
      if (nextKey === requestedKey) return undefined;
      requestedKey = nextKey;
      pendingKey = nextKey;
      return "saving";
    },
    persisted(
      preferences: AppearancePreferences,
      saved: boolean,
    ): AppearanceSaveStatus | undefined {
      if (!pendingKey || appearanceSaveKey(preferences) !== pendingKey)
        return undefined;
      if (saved) pendingKey = undefined;
      return saved ? "saved" : "error";
    },
  };
}

export function useAppearanceSaveFeedback(preferences: AppearancePreferences) {
  const tracker = useRef<ReturnType<typeof createAppearanceSaveTracker>>();
  tracker.current ??= createAppearanceSaveTracker(preferences);
  const [appearanceSaveStatus, setStatus] = useState<AppearanceSaveStatus>();
  useEffect(() => {
    const next = tracker.current!.changed(preferences);
    if (next) setStatus(next);
  }, [preferences]);
  const onAppearancePersisted = useCallback(
    (saved: AppearancePreferences, succeeded: boolean) => {
      const next = tracker.current!.persisted(saved, succeeded);
      if (next) setStatus(next);
    },
    [],
  );
  const retryAppearanceSave = useCallback(() => setStatus("saving"), []);
  return { appearanceSaveStatus, onAppearancePersisted, retryAppearanceSave };
}
