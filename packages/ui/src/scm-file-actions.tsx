import { MoreHorizontal, Trash2 } from "./icons";

import { confirmAction } from "./confirm-action";
import { Menu } from "./primitives";

export function ScmFileActions({
  path,
  onDiscard,
}: {
  path: string;
  onDiscard?: (path: string) => void | Promise<void>;
}) {
  const label = `Actions for ${path}`;
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} className="gyro-scm-file-actions-trigger">
        <MoreHorizontal aria-hidden="true" size={14} />
      </Menu.Trigger>
      <Menu.Content aria-label={label} className="gyro-scm-file-actions-menu">
        <Menu.Item
          disabled={!onDiscard}
          icon={<Trash2 aria-hidden="true" size={14} />}
          onClick={async () => {
            if (
              await confirmAction(
                `Discard all local changes in ${path}? This cannot be undone.`,
              )
            )
              void onDiscard?.(path);
          }}
          tone="danger"
        >
          Discard local changes
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
