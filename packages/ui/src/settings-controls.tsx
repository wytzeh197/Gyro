import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactNode,
} from "react";
import { SettingsDisclosure } from "./settings-disclosure";
import { SelectionTrack } from "./selection-track";
import { ChevronDown } from "lucide-react";
import "./settings-design.css";

const SettingsRowDescription = createContext<string | undefined>(undefined);

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
  const descriptionId = useContext(SettingsRowDescription);
  return (
    <span className="gyro-settings-select-field">
      <select
        {...props}
        aria-describedby={props["aria-describedby"] ?? descriptionId}
        className={["gyro-settings-select", props.className]
          .filter(Boolean)
          .join(" ")}
      />
      <ChevronDown aria-hidden="true" size={13} />
    </span>
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
  const detailId = useId();
  const content = (
    <>
      <div>
        <strong>{label}</strong>
        <span id={detailId}>{detail}</span>
      </div>
      <div className="gyro-settings-control-column">
        <SettingsRowDescription.Provider value={detailId}>
          {children ?? (
            <span className="gyro-settings-info-value">{value}</span>
          )}
        </SettingsRowDescription.Provider>
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

export function SettingsGroup({ label, id, icon, badge, description, summary, actions, attention, defaultOpen, children }: {
  label: string; id?: string; icon?: ReactNode; badge?: string; description?: string; summary?: string; actions?: ReactNode; attention?: boolean; defaultOpen?: boolean; children: ReactNode;
}) {
  return <SettingsDisclosure id={id ?? settingsSearchKey(label)} title={label} icon={icon} description={description} summary={badge ?? summary} actions={actions} attention={attention} defaultOpen={defaultOpen}>
    {badge ? <p>{badge}</p> : null}<div className="gyro-settings-group-rows">{children}</div>
  </SettingsDisclosure>;
}

export function SettingsSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: Array<{ label: string; value: T }>;
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const descriptionId = useContext(SettingsRowDescription);
  return (
    <SelectionTrack
      label={label}
      className="gyro-settings-segmented"
      value={value}
    >
      {options.map((option) => (
        <button
          aria-describedby={descriptionId}
          aria-pressed={value === option.value}
          className={value === option.value ? "is-active" : ""}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </SelectionTrack>
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
  const descriptionId = useContext(SettingsRowDescription);
  return (
    <button
      aria-describedby={descriptionId}
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
