import type { ComponentProps, ReactNode } from "react";
import { OptionSelect, Segmented } from "./primitives";

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

export function SettingsSelect(props: ComponentProps<typeof OptionSelect>) {
  return <OptionSelect {...props} />;
}

/**
 * One settings row: the label and its explanation, then the control.
 *
 * `value` is a read-only fact ("On", "Provider-dependent"). It is set after the
 * label as quiet text, never in the control column, so a row that cannot be
 * changed does not look like a disabled control. The control column is only
 * rendered when there is something to operate.
 */
export function SettingsRow({
  label,
  value,
  detail,
  detailId,
  onClick,
  children,
  tone,
}: {
  label: string;
  value?: string;
  detail: string;
  /** Lets the row's control point aria-describedby at the detail line. */
  detailId?: string;
  onClick?: () => void;
  children?: ReactNode;
  tone?: "danger";
}) {
  const content = (
    <>
      <div>
        <strong>
          {label}
          {/* A real space keeps "Label Value" apart in copied text and for
              screen readers; the dot between them is drawn by CSS. */}
          {value ? (
            <>
              {" "}
              <small className="gyro-settings-info-value">{value}</small>
            </>
          ) : null}
        </strong>
        <span id={detailId}>{detail}</span>
      </div>
      {children != null && children !== false ? (
        <div className="gyro-settings-control-column">{children}</div>
      ) : null}
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
          <span className="gyro-badge gyro-settings-group-badge">{badge}</span>
        </h2>
      ) : (
        <h2>{label}</h2>
      )}
      <div className="gyro-settings-group-rows">{children}</div>
    </section>
  );
}

export function SettingsSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ label: string; value: T }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Segmented label={label} onChange={onChange} options={options} value={value} />
  );
}

export function SettingsSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`gyro-settings-switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}
