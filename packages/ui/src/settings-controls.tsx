import {
  Children,
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { SettingsDisclosure } from "./settings-disclosure";
import { SegmentedControl, Switch } from "./primitives/controls";
import { Empty } from "./primitives/feedback";
import { Select } from "./primitives/popup";
import { ChevronDown, ChevronRight } from "./icons";
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

type ChoiceOption = { value: string; label: ReactNode; disabled?: boolean };
type ChoiceGroup = { id: string; label: string; items: ChoiceOption[] };

export function SettingsChoice({
  value,
  onValueChange,
  options,
  disabled,
  ...trigger
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: readonly (ChoiceOption | ChoiceGroup)[];
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const descriptionId = useContext(SettingsRowDescription);
  const items = options.flatMap((option) =>
    "items" in option ? option.items : [option],
  );
  const selected =
    items.find((option) => option.value === value) ??
    items.find((option) => !option.disabled);
  const renderItem = ({ value, label, disabled }: ChoiceOption) => (
    <Select.Item key={value} value={value} disabled={disabled}>
      {label}
    </Select.Item>
  );
  return (
    <Select.Root
      items={items}
      value={selected?.value ?? null}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled || !items.length}
    >
      <Select.Trigger
        {...trigger}
        aria-describedby={trigger["aria-describedby"] ?? descriptionId}
        className="gyro-settings-choice"
        size="sm"
      />
      <Select.Content>
        {options.map((option) =>
          "items" in option ? (
            <Select.Group key={option.id}>
              <Select.GroupLabel>{option.label}</Select.GroupLabel>
              {option.items.map(renderItem)}
            </Select.Group>
          ) : renderItem(option),
        )}
      </Select.Content>
    </Select.Root>
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
  detail?: string;
  onClick?: () => void;
  children?: ReactNode;
  tone?: "danger";
}) {
  const detailId = useId();
  const content = (
    <>
      <div>
        <strong>{label}</strong>
        {detail ? <span id={detailId}>{detail}</span> : null}
      </div>
      <div className="gyro-settings-control-column">
        <SettingsRowDescription.Provider value={detail ? detailId : undefined}>
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
      className={`gyro-settings-row${tone ? ` is-${tone}` : ""}`}
      data-setting-key={settingsSearchKey(label)}
      tabIndex={-1}
    >
      {content}
    </div>
  );
}

/** Groups with more rows than this fold unless told otherwise. */
const FOLD_AFTER_ROWS = 3;

export function SettingsGroup({
  label,
  id,
  icon,
  badge,
  description,
  summary,
  actions,
  attention,
  defaultOpen,
  collapsible,
  children,
}: {
  label: string;
  id?: string;
  icon?: ReactNode;
  badge?: string;
  description?: string;
  summary?: string;
  actions?: ReactNode;
  attention?: boolean;
  /** Unset: only the first group on a page starts open. */
  defaultOpen?: boolean;
  /**
   * Unset: short groups (a few rows) stay open; longer ones fold to a
   * one-line summary. Pass true or false to override.
   */
  collapsible?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const key = id ?? settingsSearchKey(label);
  const folds =
    collapsible ?? Children.toArray(children).length > FOLD_AFTER_ROWS;
  if (folds) {
    return (
      <SettingsDisclosure
        id={key}
        title={label}
        icon={icon}
        description={description}
        summary={badge ?? summary}
        actions={actions}
        attention={attention}
        defaultOpen={defaultOpen}
      >
        <div className="gyro-settings-group-rows">{children}</div>
      </SettingsDisclosure>
    );
  }
  return (
    <section
      className="gyro-settings-group is-open-section"
      id={key}
      data-settings-group={key}
      data-setting-key={settingsSearchKey(label)}
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <div className="gyro-settings-group-heading">
        <div>
          <h2 id={headingId}>
            {label}
            {badge ? <small>{badge}</small> : null}
          </h2>
          {description ? (
            <p className="gyro-settings-group-description">{description}</p>
          ) : null}
        </div>
        {summary || actions ? (
          <div className="gyro-settings-group-actions">
            {summary && summary !== badge ? (
              <span className="gyro-settings-group-summary">{summary}</span>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
      <div className="gyro-settings-group-rows">{children}</div>
    </section>
  );
}

export function SettingsEmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty icon={icon} title={title} description={description} actions={children} />
  );
}

/**
 * Secondary settings stay behind a click. A native disclosure keeps its rows
 * mounted, so settings search can still find and open them. Opens by itself
 * when `defaultOpen` says something inside already needs attention.
 */
export function SettingsMore({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [initiallyOpen] = useState(defaultOpen);
  return (
    <details className="gyro-settings-more" open={initiallyOpen}>
      <summary>
        <ChevronRight aria-hidden="true" size={13} />
        {label}
      </summary>
      <div className="gyro-settings-more-body">{children}</div>
    </details>
  );
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
    <SegmentedControl
      aria-label={label}
      aria-describedby={descriptionId}
      className="gyro-settings-segmented"
      value={value}
      options={options}
      onValueChange={onChange}
      disabled={disabled}
    />
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
    <Switch
      aria-describedby={descriptionId}
      aria-label={label}
      checked={checked}
      className="gyro-settings-switch"
      disabled={disabled}
      onCheckedChange={onChange}
    />
  );
}
