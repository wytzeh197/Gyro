import { invoke } from "@tauri-apps/api/core";
import type { NotificationKind } from "@gyro-dev/ui";

type AutoCompactSettingDeps = {
  notify: (kind: NotificationKind, title: string, detail: string) => void;
  /** Re-reads native config so Settings shows the share that was stored. */
  refreshConfig: () => Promise<void>;
};

/**
 * Persist the share of the window at which a tool loop compacts itself.
 *
 * The usage guard is native-owned -- `save_config` preserves whatever the guard
 * file holds -- so this setting crosses its own command rather than a
 * whole-config write, and the config the surface renders is re-read afterwards
 * instead of assumed.
 */
export async function persistAutoCompactPercent(
  percent: number,
  deps: AutoCompactSettingDeps,
): Promise<void> {
  try {
    await invoke("set_auto_compact_percent", { percent });
    await deps.refreshConfig();
  } catch (error) {
    deps.notify(
      "provider",
      "Could not save context compaction",
      error instanceof Error ? error.message : String(error),
    );
  }
}
