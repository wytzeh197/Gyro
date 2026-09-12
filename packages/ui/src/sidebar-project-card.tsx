import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  FolderPlus,
  MessageCircle,
  Pin,
  Settings,
  X,
} from "lucide-react";

export type SidebarProjectSettings = {
  details: Record<
    string,
    { name: string; pinned: boolean; primaryFolder?: string }
  >;
  folders: Record<string, string[]>;
  pickFolder: () => Promise<string | null>;
  save: (
    path: string,
    name: string,
    pinned: boolean,
    folders: string[],
    primaryFolder?: string,
  ) => void;
};

export function SidebarProjectCard({
  path,
  name,
  taskCount,
  activeCount,
  settings,
  onRemove,
  children,
}: {
  path: string;
  name: string;
  taskCount: number;
  activeCount: number;
  settings?: SidebarProjectSettings;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const [editing, setEditing] = useState(false);
  const pinned = settings?.details[path]?.pinned ?? false;
  const clear = () => {
    clearTimeout(timer.current);
  };
  const close = () => {
    clear();
    setPosition(undefined);
  };
  const show = () => {
    clear();
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 278)),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 144)),
      });
  };
  const enter = () => {
    clear();
    if (!position && !editing) timer.current = setTimeout(show, 1500);
  };
  const leave = () => {
    clear();
    timer.current = setTimeout(close, 180);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !anchor.current?.contains(event.target as Node) &&
        !card.current?.contains(event.target as Node)
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);
  const edit = () => {
    close();
    setEditing(true);
  };
  return (
    <>
      <div
        ref={anchor}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node) &&
            !card.current?.contains(event.relatedTarget as Node)
          )
            leave();
        }}
        onDragStartCapture={close}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !event.altKey) {
            event.preventDefault();
            show();
          }
        }}
        className="gyro-project-card-anchor"
      >
        {children}
      </div>
      {position &&
        createPortal(
          <div
            ref={card}
            role="dialog"
            aria-label={`${name} project details`}
            className="gyro-project-hover-card"
            style={position}
            onMouseEnter={clear}
            onMouseLeave={leave}
            onFocus={clear}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                leave();
            }}
          >
            <div className="gyro-project-card-heading">
              <Folder size={18} />
              <strong>{name}</strong>
              <button
                type="button"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${name}`}
                aria-pressed={pinned}
                disabled={!settings}
                onClick={() =>
                  settings?.save(
                    path,
                    name,
                    !pinned,
                    settings.folders[path] ?? [],
                    settings.details[path]?.primaryFolder,
                  )
                }
              >
                <Pin size={17} fill={pinned ? "currentColor" : "none"} />
              </button>
            </div>
            <div className="gyro-project-card-count">
              <MessageCircle size={17} />
              <span>
                {taskCount} {taskCount === 1 ? "task" : "tasks"}
                <span className="gyro-project-count-dot"> · </span>
                {activeCount} active
              </span>
            </div>
            <div className="gyro-project-card-path" title={path}>
              <Folder size={17} />
              <span>{path.replace(/^\/(Users|home)\/[^/]+(?=\/)/, "~")}</span>
            </div>
            <button
              className="gyro-project-card-edit"
              type="button"
              onClick={edit}
              disabled={!settings}
            >
              <Settings size={18} />
              Edit project
            </button>
          </div>,
          document.body,
        )}
      {editing && settings && (
        <ProjectEditDialog
          path={path}
          name={name}
          folders={settings.folders[path] ?? []}
          primaryFolder={settings.details[path]?.primaryFolder ?? path}
          pickFolder={settings.pickFolder}
          onClose={() => {
            setEditing(false);
            anchor.current
              ?.querySelector<HTMLButtonElement>(".gyro-sidebar-project-toggle")
              ?.focus();
          }}
          onSave={(nextName, folders, primaryFolder) =>
            settings.save(path, nextName, pinned, folders, primaryFolder)
          }
          onRemove={onRemove}
        />
      )}
    </>
  );
}

function ProjectEditDialog({
  path,
  name,
  folders,
  primaryFolder,
  pickFolder,
  onClose,
  onSave,
  onRemove,
}: {
  path: string;
  name: string;
  folders: string[];
  primaryFolder: string;
  pickFolder: () => Promise<string | null>;
  onClose: () => void;
  onSave: (name: string, folders: string[], primaryFolder: string) => void;
  onRemove?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draftName, setDraftName] = useState(name);
  const [draftFolders, setDraftFolders] = useState(folders);
  const [draftPrimary, setDraftPrimary] = useState(
    folders.includes(primaryFolder) ? primaryFolder : path,
  );
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const addFolder = async () => {
    setPicking(true);
    setError("");
    try {
      const selected = await pickFolder();
      if (selected && selected !== path)
        setDraftFolders((current) => [...new Set([...current, selected])]);
    } catch {
      setError("Couldn't open the folder picker. Please try again.");
    } finally {
      setPicking(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="gyro-project-edit-dialog"
      aria-labelledby="gyro-project-edit-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!draftName.trim() || picking) return;
          onSave(draftName.trim(), draftFolders, draftPrimary);
          onClose();
        }}
      >
        <header>
          <h2 id="gyro-project-edit-title">Edit project</h2>
          <button
            type="button"
            aria-label="Close edit project"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div className="gyro-project-name-input">
          <Folder size={18} />
          <input
            autoFocus
            aria-label="Project name"
            value={draftName}
            maxLength={120}
            onChange={(event) => setDraftName(event.target.value)}
            required
          />
        </div>
        <label className="gyro-project-folders-label">Source folders</label>
        <div className="gyro-project-folders">
          {[path, ...draftFolders.filter((folder) => folder !== path)].map(
            (folder) => (
              <div className="gyro-project-folder" key={folder} title={folder}>
                <Folder size={18} />
                <span>
                  {folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder}
                </span>
                {draftFolders.length > 0 &&
                  (folder === draftPrimary ? (
                    <small className="gyro-project-primary-badge">
                      Primary
                    </small>
                  ) : (
                    <button
                      className="gyro-project-make-primary"
                      type="button"
                      aria-label={`Make ${folder} primary`}
                      onClick={() => setDraftPrimary(folder)}
                    >
                      Make primary
                    </button>
                  ))}
                <button
                  type="button"
                  disabled={folder === path}
                  aria-label={`Remove folder ${folder}`}
                  title={
                    folder === path
                      ? "The original folder identifies this project. Use Remove local project to remove it."
                      : "Remove folder"
                  }
                  onClick={() => {
                    setDraftFolders((current) =>
                      current.filter((item) => item !== folder),
                    );
                    if (folder === draftPrimary) setDraftPrimary(path);
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ),
          )}
          <button
            className="gyro-project-add-folder"
            type="button"
            disabled={picking || draftFolders.length >= 19}
            onClick={() => void addFolder()}
          >
            <FolderPlus size={19} />
            {picking ? "Choosing folder…" : "Add folder"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="gyro-project-remove"
            type="button"
            disabled={!onRemove}
            onClick={() => {
              onClose();
              onRemove?.();
            }}
          >
            Remove local project
          </button>
          <div>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="gyro-project-save"
              type="submit"
              disabled={!draftName.trim() || picking}
            >
              Save
            </button>
          </div>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
