import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { updateProgressPercent, type UpdateState } from "@gyro-dev/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { isUpdateVersionNewer } from "./update-version";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
const UPDATE_CHECK_POLL_INTERVAL_MS = 60 * 1_000;
const UPDATE_RETRY_DELAYS_MS = [
  5 * 60 * 1_000,
  30 * 60 * 1_000,
  2 * 60 * 60 * 1_000,
];
const LAST_UPDATE_CHECK_STORAGE_KEY = "gyro.update.last-checked-at.v1";

export type GyroUpdateController = {
  state: UpdateState;
  checkForUpdate: (userInitiated?: boolean) => Promise<UpdateCheckResult>;
  downloadUpdate: () => Promise<void>;
  restartAndInstallUpdate: () => Promise<void>;
};

export type UpdateCheckResult =
  | { status: "available"; currentVersion: string; nextVersion: string }
  | { status: "current"; currentVersion: string }
  | { status: "failed"; currentVersion: string; error: string }
  | { status: "skipped" };

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * `latest.json` carries a `size` per platform that the updater itself ignores.
 * Reading it lets the sidebar show the download weight before it starts.
 */
async function updateArchiveSize(update: Update): Promise<number | undefined> {
  try {
    const platforms = update.rawJson.platforms;
    if (!platforms || typeof platforms !== "object") {
      return undefined;
    }
    const platformKey = await invoke<string>("updater_platform_key");
    const entry =
      (platforms as Record<string, { size?: unknown }>)[platformKey] ??
      (platforms as Record<string, { size?: unknown }>)[`${platformKey}-app`];
    const size = entry?.size;
    return typeof size === "number" && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

export function useGyroUpdater({
  automaticChecks,
}: {
  automaticChecks: boolean;
}): GyroUpdateController {
  const [state, setState] = useState<UpdateState>({
    status: import.meta.env.DEV ? "development" : "checking",
    currentVersion: import.meta.env.DEV ? "development" : "unknown",
  });
  const stateRef = useRef(state);
  const updateRef = useRef<Update | null>(null);
  const currentVersionRef = useRef("unknown");
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number>();
  const checkingRef = useRef(false);

  const checkForUpdate = useCallback(
    async (userInitiated = true): Promise<UpdateCheckResult> => {
      const currentStatus = stateRef.current.status;
      if (
        import.meta.env.DEV ||
        !isTauriRuntime() ||
        checkingRef.current ||
        (!userInitiated && updateRef.current !== null) ||
        ["downloading", "ready", "installing"].includes(currentStatus) ||
        (!userInitiated && currentStatus === "available")
      ) {
        return { status: "skipped" };
      }
      checkingRef.current = true;
      setState((current) => ({
        status: "checking",
        currentVersion: current.currentVersion,
        lastCheckedAt: current.lastCheckedAt,
      }));
      try {
        const [{ check }, currentVersion] = await Promise.all([
          import("@tauri-apps/plugin-updater"),
          getVersion(),
        ]);
        currentVersionRef.current = currentVersion;
        const update = await check({
          allowDowngrades: false,
          timeout: 15_000,
        });
        const checkedAt = new Date().toISOString();
        localStorage.setItem(LAST_UPDATE_CHECK_STORAGE_KEY, checkedAt);
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = undefined;
        retryCountRef.current = 0;
        if (!update || !isUpdateVersionNewer(update.version, currentVersion)) {
          await update?.close().catch(() => undefined);
          await updateRef.current?.close().catch(() => undefined);
          updateRef.current = null;
          setState({
            status: "current",
            currentVersion,
            lastCheckedAt: checkedAt,
          });
          return { status: "current", currentVersion };
        }
        await updateRef.current?.close().catch(() => undefined);
        updateRef.current = update;
        setState({
          status: "available",
          currentVersion,
          nextVersion: update.version,
          releaseNotes: update.body,
          releaseDate: update.date,
          totalBytes: await updateArchiveSize(update),
          lastCheckedAt: checkedAt,
        });
        return {
          status: "available",
          currentVersion,
          nextVersion: update.version,
        };
      } catch (error) {
        const checkedAt = new Date().toISOString();
        localStorage.setItem(LAST_UPDATE_CHECK_STORAGE_KEY, checkedAt);
        const retryIndex = Math.min(
          retryCountRef.current,
          UPDATE_RETRY_DELAYS_MS.length - 1,
        );
        const retryDelay = UPDATE_RETRY_DELAYS_MS[retryIndex];
        retryCountRef.current += 1;
        window.clearTimeout(retryTimerRef.current);
        if (!userInitiated && automaticChecks) {
          retryTimerRef.current = window.setTimeout(
            () => void checkForUpdate(false),
            retryDelay,
          );
        }
        const errorMessage = String(error);
        setState({
          status: "failed",
          currentVersion: currentVersionRef.current,
          error: errorMessage,
          retryable: true,
          silentFailure: !userInitiated,
          lastCheckedAt: checkedAt,
        });
        return {
          status: "failed",
          currentVersion: currentVersionRef.current,
          error: errorMessage,
        };
      } finally {
        checkingRef.current = false;
      }
    },
    [automaticChecks],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const downloadUpdate = useCallback(async () => {
    let update = updateRef.current;
    if (!update) {
      const result = await checkForUpdate(true);
      if (result.status !== "available") {
        return;
      }
      update = updateRef.current;
      if (!update) {
        return;
      }
    }
    let downloadedBytes = 0;
    // Falls back to the manifest size when the server omits a content length.
    let totalBytes: number | undefined = stateRef.current.totalBytes;
    setState((current) => ({
      ...current,
      status: "downloading",
      downloadedBytes: 0,
      progressPercent: 0,
    }));
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? totalBytes;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
        }
        setState((current) => ({
          ...current,
          status: "downloading",
          downloadedBytes,
          totalBytes,
          progressPercent: updateProgressPercent(downloadedBytes, totalBytes),
        }));
      });
      setState((current) => ({
        ...current,
        status: "ready",
        downloadedBytes,
        totalBytes,
        progressPercent: 100,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "failed",
        error: String(error),
        retryable: true,
        silentFailure: false,
      }));
    }
  }, [checkForUpdate]);

  const restartAndInstallUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      await checkForUpdate(true);
      return;
    }
    setState((current) => ({ ...current, status: "installing" }));
    try {
      await update.install();
      await invoke("restart_app");
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "failed",
        error: String(error),
        retryable: true,
        silentFailure: false,
      }));
    }
  }, [checkForUpdate]);

  useEffect(() => {
    if (import.meta.env.DEV || !automaticChecks || !isTauriRuntime()) {
      return;
    }
    const launchTimer = window.setTimeout(
      () => void checkForUpdate(false),
      1_500,
    );
    const checkIfDue = () => {
      if (
        updateRef.current !== null ||
        ["available", "downloading", "ready", "installing"].includes(
          stateRef.current.status,
        )
      ) {
        return;
      }
      const lastChecked = localStorage.getItem(LAST_UPDATE_CHECK_STORAGE_KEY);
      const lastCheckedAt = lastChecked ? new Date(lastChecked).getTime() : NaN;
      if (
        !lastChecked ||
        !Number.isFinite(lastCheckedAt) ||
        Date.now() - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
      ) {
        void checkForUpdate(false);
      }
    };
    const periodicTimer = window.setInterval(
      checkIfDue,
      UPDATE_CHECK_POLL_INTERVAL_MS,
    );
    const onFocus = () => checkIfDue();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(launchTimer);
      window.clearTimeout(retryTimerRef.current);
      window.clearInterval(periodicTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [automaticChecks, checkForUpdate]);

  useEffect(
    () => () => {
      void updateRef.current?.close();
    },
    [],
  );

  return { state, checkForUpdate, downloadUpdate, restartAndInstallUpdate };
}
