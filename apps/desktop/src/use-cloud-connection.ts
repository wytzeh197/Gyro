import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BillingActions } from "../../../packages/ui/src/billing-settings";
import { isTauriRuntime } from "./tauri-runtime";
import {
  cloudBillingView,
  disconnectedCloudView,
  isV2CloudView,
  type CloudView,
} from "./cloud-connection-view";

export function useCloudConnection(
  preferences: Record<string, unknown> = {},
  applySettings: (settings: Record<string, unknown>) => void = () => {},
  continueChat?: (context: string) => Promise<boolean>,
) {
  const [view, setView] = useState(disconnectedCloudView);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const actionRunning = useRef(false);
  const backgroundTask = useRef<Promise<void> | null>(null);
  const v2 = isV2CloudView(view);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    // Reads native memory only. Never authenticates or contacts a service.
    const read = async () => {
      if (actionRunning.current) return;
      const ticket = generation.current;
      try {
        const next = await invoke<CloudView>("cloud_connection_view");
        if (!disposed && ticket === generation.current)
          setView((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
      } catch {
        /* Optional adapter failure cannot block app startup. */
      }
    };
    void read();
    const timer =
      view.state === "connected" ||
      view.state === "offline" ||
      view.revocationPending
        ? window.setInterval(() => void read(), 5000)
        : undefined;
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [view.state, view.revocationPending]);
  const run = async (
    action: string,
    extra?: { email: string; remember?: boolean } | { proof: string },
    background = false,
  ) => {
    if (background && actionRunning.current) return;
    // A foreground click waits for a short status read; sign-out always wins.
    if (!background && action !== "sign-out" && backgroundTask.current)
      await backgroundTask.current;
    const ticket = ++generation.current;
    actionRunning.current = true;
    if (!background) {
      setBusy(true);
      setError(undefined);
      setView((previous) => ({ ...previous, state: "verifying" }));
    }
    try {
      const next = await invoke<CloudView>(
        extra && "email" in extra
          ? "cloud_connection_begin"
          : extra && "proof" in extra
            ? "cloud_connection_verify"
            : "cloud_connection_action",
        extra ?? { action },
      );
      if (ticket === generation.current) setView(next);
    } catch (e) {
      if (ticket === generation.current) {
        setError(String(e));
        try {
          const next = await invoke<CloudView>("cloud_connection_view");
          if (ticket === generation.current) setView(next);
        } catch {
          if (ticket === generation.current) setView(disconnectedCloudView);
        }
      }
    } finally {
      if (ticket === generation.current) {
        actionRunning.current = false;
        if (!background) setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (
      !["staging", "production"].includes(view.environment ?? "") ||
      !view.snapshot
    )
      return;
    // Only an explicitly established session can start status refreshes.
    const timer = window.setInterval(
      () => {
        if (!actionRunning.current) {
          const task = run("refresh", undefined, true);
          backgroundTask.current = task;
          void task.finally(() => {
            if (backgroundTask.current === task) backgroundTask.current = null;
          });
        }
      },
      v2 ? 30000 : 15000,
    );
    return () => clearInterval(timer);
  }, [view.environment, v2, !!view.snapshot]);
  const enabled = view.state !== "unconfigured";
  const connected =
    !!view.snapshot && !["signed-out", "expired"].includes(view.state);
  const actions: BillingActions = enabled
    ? {
        ...(!busy &&
        (!connected ||
          (["staging", "production"].includes(view.environment ?? "") &&
            ["none", "expired", "revoked"].includes(
              view.snapshot?.subscription.state ?? "",
            )))
          ? {
              subscribe: (plan) =>
                void run(
                  plan === "lite"
                    ? "subscribe-lite"
                    : plan === "premium"
                      ? "subscribe-premium"
                      : "subscribe-plus",
                ),
              restore: () => void run("restore"),
            }
          : {}),
        ...(!busy && connected ? { refresh: () => run("refresh") } : {}),
        ...(!busy &&
        !v2 &&
        view.environment !== "staging" &&
        view.state === "connected" &&
        ["active", "cancellation-scheduled"].includes(
          view.snapshot?.subscription.state ?? "",
        )
          ? {
              simulateManagedRequest: () => void run("managed-request"),
              simulateCancellation: () => void run("cancel-renewal"),
              simulateExpiry: () => void run("expire"),
            }
          : {}),
        ...(connected || busy || view.authStage
          ? { signOut: () => void run("sign-out") }
          : {}),
        ...(["staging", "production"].includes(view.environment ?? "")
          ? {
              requestSignin: (email: string, remember?: boolean) =>
                run("begin", { email, remember }),
              verifySignin: (proof: string) => run("verify", { proof }),
              ...(!busy && connected && view.snapshot?.subscription.planId
                ? { manage: () => void run("manage-billing") }
                : {}),
              ...(!v2 &&
              view.environment === "staging" &&
              !busy &&
              view.state === "connected" &&
              view.snapshot?.capabilities.managedAi.allowed
                ? { mockManagedRequest: () => void run("managed-request") }
                : {}),
            }
          : {}),
        ...(v2 && connected
          ? {
              cloud: {
                preferences: () => ({
                  theme: preferences.theme,
                  density: preferences.density,
                  interfaceSize: preferences.interfaceSize,
                  motionSpeed: preferences.motionSpeed,
                }),
                applySettings,
                ...(continueChat ? { continueChat } : {}),
                request: async (request: Record<string, unknown>) => {
                  // A manual control can wait for the periodic status check.
                  if (backgroundTask.current) await backgroundTask.current;
                  if (actionRunning.current)
                    throw new Error("Another Cloud action is running.");
                  const ticket = ++generation.current;
                  actionRunning.current = true;
                  setBusy(true);
                  setError(undefined);
                  try {
                    const result = await invoke<Record<string, unknown>>(
                      "cloud_connection_service",
                      { request },
                    );
                    if (ticket !== generation.current)
                      throw new Error(
                        "This response belongs to an earlier Cloud session.",
                      );
                    try {
                      const next = await invoke<CloudView>(
                        "cloud_connection_view",
                      );
                      if (ticket === generation.current) setView(next);
                    } catch {
                      // The operation already acknowledged success. A failed
                      // status read must not invite a duplicate mutation.
                      if (ticket === generation.current)
                        setError(
                          "The Cloud action completed, but account status could not refresh. Refresh status to check current access.",
                        );
                    }
                    return result;
                  } finally {
                    if (ticket === generation.current) {
                      actionRunning.current = false;
                      setBusy(false);
                    }
                  }
                },
              },
            }
          : {}),
        ...(!busy &&
        !v2 &&
        view.snapshot?.subscription.state === "checkout-pending"
          ? {
              finishCheckout: () => void run("complete-checkout"),
              abandonCheckout: () => void run("sign-out"),
            }
          : {}),
      }
    : {};
  return {
    snapshot: { ...cloudBillingView(view), ...(error ? { error } : {}) },
    actions,
  };
}
