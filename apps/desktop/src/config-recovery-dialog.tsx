import { useRef, useState } from "react";
import "./quit-confirm-dialog.css";
import { AlertDialog, Button } from "@gyro-dev/ui";

/** Keep normal edits behind an explicit recovery decision; Escape and outside clicks do nothing. */
export function ConfigRecoveryDialog({ retry, recover }: {
  retry: () => Promise<void>; recover: () => Promise<void>;
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(); } catch { setError("Configuration could not be recovered. The original file has been kept. Check disk access and try again."); }
    finally { setBusy(false); }
  }
  return <AlertDialog.Root open onOpenChange={() => undefined}>
    <AlertDialog.Content className="gyro-quit-dialog" aria-labelledby="config-recovery-title" aria-describedby="config-recovery-description" aria-busy={busy}
      initialFocus={retryRef} onKeyDown={(event) => event.stopPropagation()}>
      <AlertDialog.Header>
        <AlertDialog.Title id="config-recovery-title">Settings could not be loaded</AlertDialog.Title>
        <AlertDialog.Description id="config-recovery-description">Retry after restoring config.json, or back up the current file and reset configuration to safe defaults. Chats, projects and stored credentials are kept.</AlertDialog.Description>
        {error && <p className="gyro-quit-error" role="alert">{error}</p>}
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <Button ref={retryRef} variant="ghost" size="sm" disabled={busy} onClick={() => void run(retry)}>Retry loading</Button>
        <Button size="sm" disabled={busy} onClick={() => void run(recover)}>{busy ? "Working…" : "Back up and reset"}</Button>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>;
}
