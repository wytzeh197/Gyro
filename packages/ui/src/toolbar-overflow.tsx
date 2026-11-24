import { MoreHorizontal } from "./icons";
import type { ReactNode } from "react";
import { Menu } from "./primitives";

/** A toolbar's secondary actions in the shared Menu; children are `Menu.Item`s. */
export function ToolbarOverflow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} title={label}>
        <MoreHorizontal aria-hidden="true" size={13} />
      </Menu.Trigger>
      <Menu.Content
        align="end"
        aria-label={label}
        className="gyro-toolbar-overflow-menu"
      >
        {children}
      </Menu.Content>
    </Menu.Root>
  );
}
