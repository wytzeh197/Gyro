import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Keep normal edits behind an explicit recovery decision, with native focus containment. */
export function ConfigRecoveryDialog({ retry, recover }: {
  retry: () => Promise<void>; recover: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(); } catch { setError("Configuration could not be recovered. The original file has been kept. Check disk access and try again."); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="gyro-quit-dialog" aria-labelledby="config-recovery-title" aria-describedby="config-recovery-description" aria-busy={busy}
    onCancel={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
    <div className="gyro-quit-dialog-body">
      <h2 id="config-recovery-title">Settings could not be loaded</h2>
      <p id="config-recovery-description">Retry after restoring config.json, or back up the current file and reset configuration to safe defaults. Chats, projects and stored credentials are kept.</p>
      {error && <p className="gyro-quit-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button type="button" className="gyro-quit-cancel" disabled={busy} autoFocus onClick={() => void run(retry)}>Retry loading</button>
      <button type="button" className="gyro-quit-confirm" disabled={busy} onClick={() => void run(recover)}>{busy ? "Working…" : "Back up and reset"}</button>
    </footer>
  </dialog>, document.body);
}
