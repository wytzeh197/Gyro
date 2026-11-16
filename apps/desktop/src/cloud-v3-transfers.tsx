import { useEffect, useRef, useState } from "react";
import {
  FolderIcon,
  MessageSquareIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  TrashIcon,
} from "@gyro-dev/ui";
import {
  completedSave,
  saveKind,
  saveSize,
  savePresentation,
  type PendingSave,
} from "./cloud-v3-transfer-state";

/** All path, credential and upload authority remains in the native coordinator. */
export function PendingCloudSaves({
  items,
  running,
  outcomes,
  busy,
  onResume,
  onRestart,
  onRemove,
  onClose,
}: {
  items: PendingSave[];
  running: string[];
  outcomes: Record<string, string>;
  busy: boolean;
  onResume: (id: string) => void;
  onRestart: (id: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [menu, setMenu] = useState<string | null>(null),
    [removing, setRemoving] = useState<string | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  const completed = items.filter((p) => completedSave(p, outcomes[p.requestId])).length;
  const selected = items.find((p) => p.requestId === selectedId) || items[0];
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const current =
    selected &&
    savePresentation(
      selected,
      running.includes(selected.requestId),
      outcomes[selected.requestId],
    );
  return (
    <section className="gyro-cloud-pending" aria-label="Prepared Cloud saves">
      <p
        className="gyro-cloud-pending-intro"
        id="gyro-cloud-pending-description"
      >
        {!items.length
          ? "No saves are waiting to upload."
          : items.length === 1
            ? current?.status === "Ready to upload"
              ? "One save is ready to upload."
              : "One prepared save on this Mac."
            : `${items.length - completed} unfinished ${items.length - completed === 1 ? "save" : "saves"} · ${completed} completed ${completed === 1 ? "copy" : "copies"} on this Mac.`}
      </p>
      {items.length > 0 && (
        <div className="gyro-cloud-pending-list">
          {items.map((p) => {
            const state = savePresentation(
                p,
                running.includes(p.requestId),
                outcomes[p.requestId],
              ),
              Icon =
                p.kind === "project"
                  ? FolderIcon
                  : p.kind === "chat"
                    ? MessageSquareIcon
                    : FileTextIcon;
            const identity = (
              <>
                <Icon size={24} aria-hidden="true" />
                <span className="gyro-cloud-pending-name">
                  <strong>{p.label}</strong>
                  <span>
                    {saveKind(p.kind)} · {saveSize(p.prepared?.size)}
                  </span>
                </span>
              </>
            );
            return (
              <div
                className="gyro-cloud-pending-row"
                key={p.requestId}
                data-selected={selected?.requestId === p.requestId}
              >
                {items.length > 1 ? (
                  <button
                    type="button"
                    className="gyro-cloud-pending-select"
                    aria-pressed={selected?.requestId === p.requestId}
                    onClick={() => {
                      setSelectedId(p.requestId);
                      setMenu(null);
                      setRemoving(null);
                    }}
                  >
                    {identity}
                  </button>
                ) : (
                  <div className="gyro-cloud-pending-identity">{identity}</div>
                )}
                <span className="gyro-cloud-pending-status" role="status">
                  {state.status}
                </span>
                <div
                  className="gyro-cloud-pending-menu"
                  ref={menu === p.requestId ? menuRoot : undefined}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && menu) {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu(null);
                      menuButton.current?.focus();
                    }
                  }}
                >
                  <button
                    type="button"
                    className="gyro-cloud-icon-button"
                    ref={menu === p.requestId ? menuButton : undefined}
                    aria-label={`More actions for ${p.label}`}
                    aria-expanded={menu === p.requestId}
                    aria-controls={
                      menu === p.requestId ? "gyro-pending-actions" : undefined
                    }
                    disabled={busy}
                    onClick={() => {
                      setSelectedId(p.requestId);
                      setMenu(menu === p.requestId ? null : p.requestId);
                    }}
                  >
                    <MoreHorizontalIcon size={20} />
                  </button>
                  {menu === p.requestId && (
                    <div
                      id="gyro-pending-actions"
                      className="gyro-cloud-pending-actions"
                      role="group"
                      aria-label={`Actions for ${p.label}`}
                    >
                      <button
                        type="button"
                        disabled={!state.restart || busy}
                        onClick={() => {
                          setMenu(null);
                          void onRestart(p.requestId);
                        }}
                      >
                        <RefreshIcon size={16} />
                        Restart upload
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setMenu(null);
                          setRemoving(p.requestId);
                        }}
                      >
                        <TrashIcon size={16} />
                        {p.cancelRequested
                          ? "Finish removing save"
                          : p.localRunning || running.includes(p.requestId)
                            ? "Stop and remove prepared copy"
                            : "Remove prepared copy"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {removing && (
        <div
          className="gyro-cloud-pending-confirm"
          role="group"
          aria-label="Confirm prepared copy removal"
        >
          <p>Remove this prepared copy?</p>
          <p>
            Its unfinished upload will be stopped. Your original files and saved
            Cloud versions stay untouched.
          </p>
          <div>
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={busy}
              autoFocus
              onClick={() => setRemoving(null)}
            >
              Keep save
            </button>
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={busy}
              onClick={() => {
                void onRemove(removing).then((done) => {
                  if (done) setRemoving(null);
                });
              }}
            >
              Remove prepared copy
            </button>
          </div>
        </div>
      )}
      {!removing && (
        <>
          {current && (
            <p className="gyro-cloud-pending-description">
              {current.description}
            </p>
          )}
          <footer className="gyro-cloud-pending-footer">
            <p>
              {items.length
                ? `Closing this window keeps your prepared ${items.length === 1 ? "save" : "saves"}.`
                : "Your local files stay on this Mac."}
            </p>
            <div>
              <button
                type="button"
                className="gyro-cloud-pending-dismiss"
                onClick={onClose}
              >
                {items.length ? "Not now" : "Close"}
              </button>
              {selected && current && (
                <button
                  type="button"
                  className="gyro-primary-button"
                  disabled={busy || current.disabled}
                  onClick={() => onResume(selected.requestId)}
                >
                  {current.action}
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
