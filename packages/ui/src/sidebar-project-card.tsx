import { Folder, FolderPlus } from "./workspace-folder-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageCircle, Pin, Settings, X } from "./icons";
import { Dialog, Popover } from "./primitives";
import { ProjectMemoryPanel } from "./project-memory/panel";
import type { ProjectMemoryRuntime } from "./project-memory/types";
import { MAX_WORKSPACE_FOLDERS } from "./workspace-project";
import type { WorkspaceRootValidation } from "./workspace-roots";
import "./sidebar-project-card.css";

export type SidebarProjectSettings = {
  details: Record<
    string,
    {
      name: string;
      pinned: boolean;
      primaryFolder?: string;
      allowNestedFolders?: boolean;
    }
  >;
  folders: Record<string, string[]>;
  pickFolder: () => Promise<string | null>;
  memory?: (sessionId: string) => ProjectMemoryRuntime;
  /**
   * Check candidate folders against `[path, ...folders]`. Without it the
   * dialog only refuses exact repeats, as before.
   */
  validateFolders?: (
    path: string,
    folders: readonly string[],
    candidates: readonly string[],
    allowNested: boolean,
  ) => Promise<WorkspaceRootValidation>;
  save: (
    path: string,
    name: string,
    pinned: boolean,
    folders: string[],
    primaryFolder?: string,
    allowNestedFolders?: boolean,
  ) => void;
};

/** Extra folders a project may hold next to its original folder. */
const MAX_EXTRA_PROJECT_FOLDERS = MAX_WORKSPACE_FOLDERS - 1;

export function SidebarProjectCard({
  path,
  name,
  taskCount,
  activeCount,
  settings,
  memorySessionId,
  expandedContent,
  onRemove,
  children,
}: {
  path: string;
  name: string;
  taskCount: number;
  activeCount: number;
  settings?: SidebarProjectSettings;
  memorySessionId?: string;
  expandedContent?: ReactNode;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Focus to restore when a keyboard-opened card closes; null for hover.
  const returnFocus = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const pinned = settings?.details[path]?.pinned ?? false;
  const clear = () => {
    clearTimeout(timer.current);
  };
  const restoringFocus = useRef(false);
  const close = () => {
    clear();
    if (open && returnFocus.current) restoringFocus.current = true;
    setOpen(false);
  };
  const show = (fromKeyboard = false) => {
    clear();
    returnFocus.current = fromKeyboard
      ? (document.activeElement as HTMLElement | null)
      : null;
    setOpen(true);
  };
  const enter = () => {
    clear();
    restoringFocus.current = false;
    if (!open && !editing) timer.current = setTimeout(() => show(), 1500);
  };
  const leave = () => {
    clear();
    timer.current = setTimeout(close, 180);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
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
        onFocus={() => {
          // Focus coming back from the card is not a fresh hover.
          if (restoringFocus.current) restoringFocus.current = false;
          else enter();
        }}
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
            show(true);
          }
        }}
        className="gyro-project-card-anchor"
      >
        {children}
      </div>
      {expandedContent ? (
        <div className="gyro-sidebar-project-children">{expandedContent}</div>
      ) : null}
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <Popover.Content
          ref={card}
          anchor={anchor}
          side="right"
          align="start"
          sideOffset={-16}
          collisionPadding={8}
          aria-label={`${name} project details`}
          className="gyro-project-hover-card"
          initialFocus={() => returnFocus.current !== null}
          finalFocus={() => returnFocus.current ?? false}
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
                  settings.details[path]?.allowNestedFolders,
                )
              }
            >
              <Pin size={17} fill={pinned ? "currentColor" : "none"} />
            </button>
          </div>
          <div className="gyro-project-card-count">
            <MessageCircle size={17} />
            <span>
              {taskCount} {taskCount === 1 ? "chat" : "chats"}
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
        </Popover.Content>
      </Popover.Root>
      {editing && settings && (
        <ProjectEditDialog
          path={path}
          name={name}
          folders={settings.folders[path] ?? []}
          primaryFolder={settings.details[path]?.primaryFolder ?? path}
          allowNestedFolders={
            settings.details[path]?.allowNestedFolders ?? false
          }
          pickFolder={settings.pickFolder}
          validateFolders={settings.validateFolders}
          onClose={() => {
            setEditing(false);
            requestAnimationFrame(() => {
              anchor.current
                ?.querySelector<HTMLButtonElement>(
                  ".gyro-sidebar-project-toggle",
                )
                ?.focus();
            });
          }}
          onSave={(nextName, folders, primaryFolder, allowNested) =>
            settings.save(
              path,
              nextName,
              pinned,
              folders,
              primaryFolder,
              allowNested,
            )
          }
          onRemove={onRemove}
          memory={
            memorySessionId ? settings.memory?.(memorySessionId) : undefined
          }
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
  allowNestedFolders,
  pickFolder,
  validateFolders,
  onClose,
  onSave,
  onRemove,
  memory,
}: {
  path: string;
  name: string;
  folders: string[];
  primaryFolder: string;
  allowNestedFolders: boolean;
  pickFolder: () => Promise<string | null>;
  validateFolders?: SidebarProjectSettings["validateFolders"];
  onClose: () => void;
  onSave: (
    name: string,
    folders: string[],
    primaryFolder: string,
    allowNested: boolean,
  ) => void;
  onRemove?: () => void;
  memory?: ProjectMemoryRuntime;
}) {
  const [view, setView] = useState<"general" | "memory">("general");
  const [memoryVisited, setMemoryVisited] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftFolders, setDraftFolders] = useState(folders);
  const [draftPrimary, setDraftPrimary] = useState(
    folders.includes(primaryFolder) ? primaryFolder : path,
  );
  const [draftAllowNested, setDraftAllowNested] = useState(allowNestedFolders);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const atFolderCap = draftFolders.length >= MAX_EXTRA_PROJECT_FOLDERS;
  const addFolder = async () => {
    setPicking(true);
    setError("");
    try {
      const selected = await pickFolder();
      if (!selected) return;
      if (!validateFolders) {
        if (selected !== path)
          setDraftFolders((current) => [...new Set([...current, selected])]);
        return;
      }
      const result = await validateFolders(
        path,
        draftFolders,
        [selected],
        draftAllowNested,
      );
      const accepted = result.accepted[0];
      if (accepted) {
        setDraftFolders((current) => [...new Set([...current, accepted])]);
        return;
      }
      const label = selected.split(/[\\/]/).filter(Boolean).at(-1) ?? selected;
      setError(`${label}: ${result.issues[0]?.message ?? "Not added"}`);
    } catch {
      setError("Couldn't open the folder picker. Please try again.");
    } finally {
      setPicking(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(next, details) => {
        // The memory editor holds Escape while a draft is unsaved.
        if (!next && !details.event?.defaultPrevented) onClose();
      }}
    >
      <Dialog.Content
        className={`gyro-project-edit-dialog${view === "memory" ? " is-memory" : ""}`}
        aria-labelledby="gyro-project-edit-title"
      >
      <header>
        <Dialog.Title id="gyro-project-edit-title">Edit project</Dialog.Title>
        <button type="button" aria-label="Close edit project" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      {memory ? (
        <div
          className="gyro-memory-tabs gyro-project-settings-views"
          role="group"
          aria-label="Project settings"
        >
          <button
            type="button"
            aria-pressed={view === "general"}
            onClick={() => setView("general")}
          >
            General
          </button>
          <button
            type="button"
            aria-pressed={view === "memory"}
            onClick={() => {
              setMemoryVisited(true);
              setView("memory");
            }}
          >
            Project memory
          </button>
        </div>
      ) : null}
      <form
        hidden={view !== "general"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!draftName.trim() || picking) return;
          void (async () => {
            // Turning nesting off must not keep folders that now break the
            // rule. Unavailable folders are kept: they may come back.
            if (validateFolders && !draftAllowNested && draftFolders.length) {
              setPicking(true);
              try {
                const result = await validateFolders(
                  path,
                  [],
                  draftFolders,
                  false,
                );
                const blocking = result.issues.find(
                  (issue) => issue.code === "overlap",
                );
                if (blocking) {
                  const label =
                    blocking.path.split("/").filter(Boolean).at(-1) ??
                    blocking.path;
                  setError(
                    `${label}: ${blocking.message}. Remove it or allow nested folders.`,
                  );
                  return;
                }
              } catch {
                // Validation is advisory here; saving still goes through.
              } finally {
                setPicking(false);
              }
            }
            onSave(
              draftName.trim(),
              draftFolders,
              draftPrimary,
              draftAllowNested,
            );
            onClose();
          })();
        }}
      >
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
            disabled={picking || atFolderCap}
            title={
              atFolderCap
                ? `A project holds up to ${MAX_WORKSPACE_FOLDERS} folders`
                : undefined
            }
            onClick={() => void addFolder()}
          >
            <FolderPlus size={19} />
            {picking
              ? "Choosing folder…"
              : atFolderCap
                ? `${MAX_WORKSPACE_FOLDERS} of ${MAX_WORKSPACE_FOLDERS} folders`
                : "Add folder"}
          </button>
        </div>
        <label className="gyro-project-nested-toggle">
          <input
            type="checkbox"
            checked={draftAllowNested}
            onChange={(event) => {
              setDraftAllowNested(event.target.checked);
              setError("");
            }}
          />
          <span>Allow folders inside other folders</span>
        </label>
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
      {memoryVisited ? (
        <div
          hidden={view !== "memory"}
          className="gyro-project-settings-memory"
        >
          <ProjectMemoryPanel runtime={memory} embedded />
        </div>
      ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
