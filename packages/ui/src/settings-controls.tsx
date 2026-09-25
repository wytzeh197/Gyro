import type { ComponentProps, ReactNode } from "react";

/**
 * The settings controls every section is built from.
 *
 * They live beside `surfaces.tsx` rather than inside it because that file sits
 * at its architecture ceiling: a new settings surface must be able to add a row
 * without growing the file that renders all of them. These four are the pieces
 * a row is made of -- the select, the row, the group that holds rows, and the
 * label-to-key helper all three stamp onto the DOM for settings search.
 */

/**
 * The key a settings row is findable by.
 *
 * Rows and sections stamp it onto `data-setting-key`, and the settings search
 * queries the same keys, so the two must be derived from labels the same way.
 */
export function settingsSearchKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function SettingsSelect(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={["gyro-settings-select", props.className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function SettingsRow({
  label,
  value,
  detail,
  onClick,
  children,
  tone,
}: {
  label: string;
  value?: string;
  detail: string;
  onClick?: () => void;
  children?: ReactNode;
  tone?: "danger";
}) {
  const content = (
    <>
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="gyro-settings-control-column">
        {children ?? <span className="gyro-settings-info-value">{value}</span>}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        className={`gyro-settings-row${tone ? ` is-${tone}` : ""}`}
        data-setting-key={settingsSearchKey(label)}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className="gyro-settings-row"
      data-setting-key={settingsSearchKey(label)}
      tabIndex={-1}
    >
      {content}
    </div>
  );
}

export function SettingsGroup({
  label,
  badge,
  children,
}: {
  label: string;
  /** Marks a group whose controls are visible but not yet usable. */
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className={`gyro-settings-group${badge ? " is-unavailable" : ""}`}>
      {badge ? (
        <h2>
          {label}
          <span className="gyro-settings-group-badge">{badge}</span>
        </h2>
      ) : (
        <h2>{label}</h2>
      )}
      <div className="gyro-settings-group-rows">{children}</div>
    </section>
  );
}
