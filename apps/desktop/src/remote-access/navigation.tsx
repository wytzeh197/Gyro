import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
} from "../../../../packages/ui/node_modules/lucide-react";
import {
  Folder,
  FolderOpen,
} from "../../../../packages/ui/src/workspace-folder-icons";
import {
  SidebarProjectRow,
  SessionSidebarRow,
} from "../../../../packages/ui/src/workspace-sidebar";
import {
  RemoteAccessSlots,
  useRemoteWorkspaceSlots,
} from "../../../../packages/ui/src/remote-access-context";
import type { RemoteCatalog, RemoteSelection } from "./catalog";

export function RemoteNavigation({
  catalogs,
  selection,
  onSelect,
}: {
  catalogs: RemoteCatalog[];
  selection?: RemoteSelection;
  onSelect: (selection: RemoteSelection) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const slots = useRemoteWorkspaceSlots();
  const [counts, setCounts] = useState<Record<string, number>>({});
  return (
    <>
      {catalogs.map((catalog) => (
        <RemoteAccessSlots.Provider
          key={catalog.host.id}
          value={{
            ...slots,
            projectHost: catalog.host.name,
            projects: undefined,
          }}
        >
          {catalog.projects.map(({ project, sessions }) => {
            const key = `${catalog.host.id}:${project.id}`;
            const isCollapsed = collapsed.includes(key);
            const count = counts[key] ?? 5;
            const ordered = [...sessions].sort(
              (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
            );
            const visible = ordered.slice(0, count);
            const active =
              selection?.hostId === catalog.host.id &&
              selection.projectId === project.id
                ? ordered.find((s) => s.id === selection.sessionId)
                : undefined;
            if (active && !visible.includes(active))
              visible.splice(Math.max(0, count - 1), 1, active);

            return (
              <div className="gyro-sidebar-project-group" key={key}>
                <SidebarProjectRow
                  icon={isCollapsed ? Folder : FolderOpen}
                  isCollapsed={isCollapsed}
                  label={project.name}
                  onClick={() => {
                    setCollapsed((old) =>
                      isCollapsed
                        ? old.filter((id) => id !== key)
                        : [...old, key],
                    );
                  }}
                />
                {!isCollapsed ? (
                  <div className="gyro-sidebar-project-children">
                    <button
                      type="button"
                      className="gyro-sidebar-thread is-empty"
                      aria-label={`New chat in ${project.name}, remote on ${catalog.host.name}`}
                      onClick={() =>
                        onSelect({
                          hostId: catalog.host.id,
                          projectId: project.id,
                        })
                      }
                    >
                      New chat
                    </button>
                    {visible.map((session) => (
                      <SessionSidebarRow
                        key={session.id}
                        session={session}
                        isNested
                        isPinned={false}
                        isMenuOpen={false}
                        isSending={false}
                        isActive={
                          selection?.hostId === catalog.host.id &&
                          selection.projectId === project.id &&
                          selection.sessionId === session.id
                        }
                        onMenuClose={() => {}}
                        onSelect={() =>
                          onSelect({
                            hostId: catalog.host.id,
                            projectId: project.id,
                            sessionId: session.id,
                          })
                        }
                      />
                    ))}
                    {sessions.length > count || count > 5 ? (
                      <div className="gyro-sidebar-more-actions">
                        {sessions.length > count ? (
                          <button
                            type="button"
                            className="gyro-sidebar-more-button"
                            aria-expanded={count > 5}
                            aria-label={`Show more chats in ${project.name}, remote on ${catalog.host.name}`}
                            onClick={() =>
                              setCounts((old) => ({
                                ...old,
                                [key]: count + 15,
                              }))
                            }
                          >
                            <ChevronDown size={12} aria-hidden />
                            <span>more</span>
                          </button>
                        ) : null}
                        {count > 5 ? (
                          <button
                            type="button"
                            className="gyro-sidebar-more-button"
                            aria-label={`Show fewer chats in ${project.name}, remote on ${catalog.host.name}`}
                            onClick={() =>
                              setCounts((old) => ({ ...old, [key]: 5 }))
                            }
                          >
                            <ChevronUp size={12} aria-hidden />
                            <span>less</span>
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {!sessions.length ? (
                      <span className="gyro-sidebar-mini-copy">
                        No chats yet
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </RemoteAccessSlots.Provider>
      ))}
    </>
  );
}
