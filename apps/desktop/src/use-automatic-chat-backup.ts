import { useEffect, useRef, useState } from "react";
import type {
  BillingActions,
  BillingSnapshot,
} from "../../../packages/ui/src/billing-settings";

const preferenceKey = (account: string) =>
  `gyro.cloud.auto-chat-backup.${account}`;

export function useAutomaticChatBackup(
  snapshot: BillingSnapshot,
  actions: BillingActions,
  sending: string[],
  isSavedChat: (id: string) => boolean,
) {
  const account = snapshot.billingIdentity?.split(":")[0];
  const [preference, setPreference] = useState<{
    account?: string;
    enabled: boolean;
  }>({ enabled: false });
  const [uploading, setUploading] = useState<string>();
  const enabled =
    !!account && preference.account === account && preference.enabled;
  const allowed =
    snapshot.cloudCapabilities?.backup?.allowed === true &&
    ["active", "cancellation-scheduled", "exhausted"].includes(snapshot.status);
  const current = useRef({
    account,
    enabled,
    allowed,
    request: actions.cloud?.request,
    isSavedChat,
    sending,
  });
  current.current = {
    account,
    enabled,
    allowed,
    request: actions.cloud?.request,
    isSavedChat,
    sending,
  };
  const previous = useRef({ account, enabled, sending });
  const pending = useRef(new Set<string>());
  const running = useRef(false);
  const consent = useRef(0);
  const [wake, setWake] = useState(0);

  useEffect(() => {
    consent.current++;
    let saved = false;
    try {
      saved =
        !!account && localStorage.getItem(preferenceKey(account)) === "on";
    } catch {
      /* Storage unavailable. Default to off. */
    }
    setPreference({ account, enabled: saved });
  }, [account]);

  useEffect(() => {
    const before = previous.current;
    previous.current = { account, enabled, sending };
    if (before.account !== account || !enabled || !before.enabled) {
      pending.current.clear();
      return;
    }
    if (!allowed) return;
    for (const id of before.sending) {
      if (!sending.includes(id) && current.current.isSavedChat(id))
        pending.current.add(id);
    }
  }, [account, allowed, enabled, sending]);

  useEffect(() => {
    if (
      !account ||
      !enabled ||
      !allowed ||
      !pending.current.size ||
      running.current
    )
      return;
    const timer = window.setTimeout(() => {
      for (const id of pending.current) {
        if (!current.current.isSavedChat(id)) pending.current.delete(id);
      }
      const id = [...pending.current].find(
        (candidate) => !current.current.sending.includes(candidate),
      );
      if (!id) return;
      pending.current.delete(id);
      const consentAtPreview = consent.current;
      const canUpload = () =>
        consent.current === consentAtPreview &&
        current.current.account === account &&
        current.current.enabled &&
        current.current.allowed;
      if (!canUpload() || !current.current.isSavedChat(id)) return;
      const request = current.current.request;
      if (!request) return;
      running.current = true;
      void (async () => {
        try {
          const preview = await request({
            operation: "preview-chat",
            localId: id,
          });
          if (
            !canUpload() ||
            !current.current.isSavedChat(id) ||
            current.current.sending.includes(id) ||
            preview.kind !== "chat" ||
            typeof preview.ticket !== "string"
          )
            return;
          setUploading(id);
          await current.current.request?.({
            operation: "upload-preview",
            ticket: preview.ticket,
            reviewed: true,
          });
        } catch {
          // A failed attempt must not silently retry an ambiguous upload.
        } finally {
          running.current = false;
          setUploading(undefined);
          setWake((value) => value + 1);
        }
      })();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [account, allowed, enabled, sending, wake]);

  return {
    uploading,
    preference: account
      ? {
          enabled,
          available: allowed,
          setEnabled(next: boolean) {
            if (next && !allowed) return;
            try {
              if (next) localStorage.setItem(preferenceKey(account), "on");
              else localStorage.removeItem(preferenceKey(account));
            } catch {
              /* The choice still applies for this app session. */
            }
            consent.current++;
            current.current.enabled = next;
            if (!next) pending.current.clear();
            setPreference({ account, enabled: next });
          },
        }
      : undefined,
  };
}
