import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { updateProgressPercent, type UpdateState } from "@gyro-dev/ui";
import { useCallback, useEffect, useRef, useState } from "react";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const UPDATE_RETRY_DELAYS_MS = [5 * 60 * 1_000, 30 * 60 * 1_000, 2 * 60 * 60 * 1_000];
const LAST_UPDATE_CHECK_STORAGE_KEY = "gyro.update.last-checked-at.v1";

export type GyroUpdateController = {
  state: UpdateState;
  checkForUpdate: (userInitiated?: boolean) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  restartAndInstallUpdate: () => Promise<void>;
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export function useGyroUpdater({
  automaticChecks,
  restartBlockers,
}: {
  automaticChecks: boolean;
  restartBlockers: string[];
}): GyroUpdateController {
  const [state, setState] = useState<UpdateState>({
    status: import.meta.env.DEV ? "development" : "checking",
    currentVersion: import.meta.env.DEV ? "development" : "unknown",
  });
  const updateRef = useRef<Update | null>(null);
  const currentVersionRef = useRef("unknown");
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number>();
  const checkingRef = useRef(false);

  const checkForUpdate = useCallback(async (userInitiated = true) => {
    if (import.meta.env.DEV || !isTauriRuntime() || checkingRef.current) {
      return;
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
      retryCountRef.current = 0;
      if (!update) {
        await updateRef.current?.close().catch(() => undefined);
        updateRef.current = null;
        setState({ status: "current", currentVersion, lastCheckedAt: checkedAt });
        return;
      }
      await updateRef.current?.close().catch(() => undefined);
      updateRef.current = update;
      setState({
        status: "available",
        currentVersion,
        nextVersion: update.version,
        releaseNotes: update.body,
        releaseDate: update.date,
        lastCheckedAt: checkedAt,
      });
    } catch (error) {
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
      setState({
        status: "failed",
        currentVersion: currentVersionRef.current,
        error: String(error),
        retryable: true,
        silentFailure: !userInitiated,
        lastCheckedAt: localStorage.getItem(LAST_UPDATE_CHECK_STORAGE_KEY) ?? undefined,
      });
    } finally {
      checkingRef.current = false;
    }
  }, [automaticChecks]);

  const downloadUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      await checkForUpdate(true);
      return;
    }
    let downloadedBytes = 0;
    let totalBytes: number | undefined;
    setState((current) => ({
      ...current,
      status: "downloading",
      downloadedBytes: 0,
      progressPercent: 0,
    }));
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
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
    if (restartBlockers.length > 0) {
      setState((current) => ({
        ...current,
        status: "restart-blocked",
        blockers: restartBlockers,
      }));
      return;
    }
    setState((current) => ({ ...current, status: "installing", blockers: [] }));
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
  }, [checkForUpdate, restartBlockers]);

  useEffect(() => {
    if (import.meta.env.DEV || !automaticChecks || !isTauriRuntime()) {
      return;
    }
    const launchTimer = window.setTimeout(() => void checkForUpdate(false), 1_500);
    const onFocus = () => {
      const lastChecked = localStorage.getItem(LAST_UPDATE_CHECK_STORAGE_KEY);
      if (
        !lastChecked ||
        Date.now() - new Date(lastChecked).getTime() >= UPDATE_CHECK_INTERVAL_MS
      ) {
        void checkForUpdate(false);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(launchTimer);
      window.clearTimeout(retryTimerRef.current);
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
