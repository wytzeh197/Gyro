import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ProviderId,
  ProviderSignIn,
  ProviderSignInState,
  WorkbenchAction,
} from "@gyro-dev/ui";
import type {
  ProviderConnectionOptions,
  ProviderConnectionRunner,
} from "./provider-connection-guard";
import { isTauriRuntime } from "./tauri-runtime";

/**
 * Sign-ins started from the model popover run their login CLI out of sight;
 * the popover reads this state instead of a terminal pane.
 */
export function useProviderSignIn({
  dispatchWorkbench,
  terminalOutputRevisionRef,
}: {
  dispatchWorkbench: (action: WorkbenchAction) => void;
  terminalOutputRevisionRef: { current: Record<string, number> };
}) {
  const [signIns, setSignIns] = useState<
    Partial<Record<string, ProviderSignIn>>
  >({});
  const panesRef = useRef<Partial<Record<string, string>>>({});
  const cancelledRef = useRef(new Set<string>());

  const patch = useCallback(
    (providerId: ProviderId, update: Partial<ProviderSignIn> | null) => {
      setSignIns((current) => {
        if (update === null) {
          if (!current[providerId]) return current;
          const next = { ...current };
          delete next[providerId];
          return next;
        }
        const previous = current[providerId];
        const merged: ProviderSignIn = {
          providerId,
          phase: "starting",
          ...previous,
          ...update,
        };
        if (
          previous &&
          (Object.keys(merged) as (keyof ProviderSignIn)[]).every(
            (key) => previous[key] === merged[key],
          )
        ) {
          return current;
        }
        return { ...current, [providerId]: merged };
      });
    },
    [],
  );

  const dismissPane = useCallback(
    (providerId: ProviderId, options?: { stop?: boolean }) => {
      const paneId = panesRef.current[providerId];
      if (!paneId) return;
      delete panesRef.current[providerId];
      dispatchWorkbench({ type: "remove-terminal-pane", paneId });
      delete terminalOutputRevisionRef.current[paneId];
      if (!isTauriRuntime()) return;
      void (async () => {
        if (options?.stop) {
          await invoke("stop_terminal_pane", { paneId }).catch(() => undefined);
        }
        await invoke("close_terminal_pane", { paneId }).catch(() => undefined);
      })();
    },
    [dispatchWorkbench, terminalOutputRevisionRef],
  );

  const isCancelled = useCallback(
    (providerId: ProviderId) => cancelledRef.current.has(providerId),
    [],
  );

  return {
    signIns,
    setSignIns,
    panesRef,
    cancelledRef,
    patch,
    dismissPane,
    isCancelled,
  };
}

type ProviderSignInControls = ReturnType<typeof useProviderSignIn>;

/**
 * Inline sign-ins end in one of three ways: connected (the popover lists the
 * models), cancelled (nothing to show), or stuck, which keeps the reason the
 * run recorded and offers a retry.
 */
export function useInlineSignInRunner(
  { setSignIns, cancelledRef, patch, dismissPane }: ProviderSignInControls,
  run: ProviderConnectionRunner,
): ProviderConnectionRunner {
  return useCallback(
    async (providerId: ProviderId, options?: ProviderConnectionOptions) => {
      if (!options?.inline) return run(providerId, options);
      cancelledRef.current.delete(providerId);
      dismissPane(providerId, { stop: true });
      setSignIns((current) => ({
        ...current,
        [providerId]: { providerId, phase: "starting" },
      }));
      const connected = await run(providerId, options).catch(() => false);
      const cancelled = cancelledRef.current.delete(providerId);
      if (connected || cancelled) {
        patch(providerId, null);
        return connected;
      }
      setSignIns((current) => {
        const signIn = current[providerId];
        if (signIn?.phase === "failed" || signIn?.phase === "not-installed") {
          return current;
        }
        return {
          ...current,
          [providerId]: {
            providerId,
            phase: "failed",
            message: signIn?.message,
          },
        };
      });
      return false;
    },
    [cancelledRef, dismissPane, patch, run, setSignIns],
  );
}

/** The popover's actions on a sign-in in progress. */
export function useProviderSignInActions(
  {
    signIns,
    panesRef,
    cancelledRef,
    patch,
    dismissPane,
  }: ProviderSignInControls,
  {
    connectProvider,
    dispatchWorkbench,
    isProviderId,
    notify,
    openProviderSettings,
  }: {
    connectProvider: ProviderConnectionRunner;
    dispatchWorkbench: (action: WorkbenchAction) => void;
    isProviderId: (value: string) => value is ProviderId;
    notify: (kind: "command-failed", title: string, body: string) => void;
    openProviderSettings: () => void;
  },
): ProviderSignInState {
  return useMemo(
    () => ({
      signIns,
      openLink: (providerId) => {
        const url = signIns[providerId]?.url;
        if (!url) return;
        if (isTauriRuntime()) {
          void openUrl(url).catch((error) =>
            notify("command-failed", "Could not open link", String(error)),
          );
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
      submitCode: (providerId, code) => {
        const paneId = panesRef.current[providerId];
        if (!paneId || !isTauriRuntime()) return;
        void invoke("write_terminal_input", {
          paneId,
          input: `${code}\r`,
        }).catch((error) =>
          notify("command-failed", "Could not send the code", String(error)),
        );
      },
      cancel: (providerId) => {
        if (!isProviderId(providerId)) return;
        cancelledRef.current.add(providerId);
        dismissPane(providerId, { stop: true });
        patch(providerId, null);
        dispatchWorkbench({
          type: "set-provider-status",
          providerId,
          status: "disconnected",
        });
      },
      showDetails: (providerId) => {
        const paneId = panesRef.current[providerId];
        if (!paneId) {
          openProviderSettings();
          return;
        }
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "terminal-grid",
        });
        dispatchWorkbench({ type: "open-tool-panel", tab: "terminal" });
        dispatchWorkbench({ type: "select-terminal-pane", paneId });
      },
      install: (providerId) => {
        if (!isProviderId(providerId)) return;
        void connectProvider(providerId, { inline: true, install: true });
      },
    }),
    [
      cancelledRef,
      connectProvider,
      dismissPane,
      dispatchWorkbench,
      isProviderId,
      notify,
      openProviderSettings,
      panesRef,
      patch,
      signIns,
    ],
  );
}
