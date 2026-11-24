import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Input as BaseInput } from "@base-ui/react/input";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { Check, Search, X } from "../icons";
import { SelectionTrack } from "../selection-track";
import {
  forwardRef,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cx, styledPart } from "./cx";

/**
 * Form controls. Flat: a 1px border, no shadow, and a focus state that raises
 * the border or draws the shared 2px focus outline. No glow.
 */

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<BaseInput.Props, "className" | "size"> {
  className?: string;
  size?: InputSize;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "md", invalid = false, ...props },
  ref,
) {
  return (
    <BaseInput
      ref={ref}
      className={cx("gyro-input", className)}
      data-size={size}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid = false, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cx("gyro-textarea", className)}
        aria-invalid={invalid || undefined}
        {...props}
      />
    );
  },
);

export interface SearchFieldProps
  extends Omit<InputProps, "type" | "value" | "defaultValue" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  clearLabel?: string;
  /** Adornment on the right, such as a shortcut hint. Hidden while there is text. */
  hint?: ReactNode;
}

/** An input with a search glyph and a clear button. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onValueChange,
      clearLabel = "Clear search",
      hint,
      className,
      size = "md",
      ...props
    },
    ref,
  ) {
    return (
      <div className={cx("gyro-search-field", className)} data-size={size}>
        <Search aria-hidden size={14} className="gyro-search-field__icon" />
        <BaseInput
          ref={ref}
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          className="gyro-search-field__input"
          {...props}
        />
        {value ? (
          <button
            type="button"
            className="gyro-search-field__clear"
            aria-label={clearLabel}
            onClick={() => onValueChange("")}
          >
            <X aria-hidden size={12} />
          </button>
        ) : hint ? (
          <span className="gyro-search-field__hint">{hint}</span>
        ) : null}
      </div>
    );
  },
);

export interface SwitchProps extends Omit<BaseSwitch.Root.Props, "className"> {
  className?: string;
  size?: "sm" | "md";
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch({ className, size = "md", ...props }, ref) {
    return (
      <BaseSwitch.Root
        ref={ref}
        nativeButton
        render={<button type="button" />}
        className={cx("gyro-switch", className)}
        data-size={size}
        {...props}
      >
        <BaseSwitch.Thumb className="gyro-switch__thumb" />
      </BaseSwitch.Root>
    );
  },
);

export interface CheckboxProps
  extends Omit<BaseCheckbox.Root.Props, "className"> {
  className?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <BaseCheckbox.Root
        ref={ref}
        className={cx("gyro-checkbox", className)}
        {...props}
      >
        <BaseCheckbox.Indicator
          className="gyro-checkbox__indicator"
          keepMounted
        >
          <Check aria-hidden size={12} strokeWidth={3} />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
    );
  },
);

export interface RadioProps extends Omit<BaseRadio.Root.Props, "className"> {
  className?: string;
}

const RadioItem = forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { className, ...props },
  ref,
) {
  return (
    <BaseRadio.Root ref={ref} className={cx("gyro-radio", className)} {...props}>
      <BaseRadio.Indicator className="gyro-radio__indicator" keepMounted />
    </BaseRadio.Root>
  );
});

export const Radio = {
  Group: styledPart(BaseRadioGroup, "gyro-radio-group", "RadioGroup"),
  Item: RadioItem,
};

export interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is an icon only. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<Value extends string> {
  value: Value;
  onValueChange: (value: Value) => void;
  options: readonly SegmentedControlOption<Value>[];
  size?: "sm" | "md";
  /** Stretch the segments to fill the container. */
  fill?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
}

/** A single-choice group of toggle segments. */
export function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  fill = false,
  className,
  disabled,
  ...props
}: SegmentedControlProps<Value>) {
  return (
    <SelectionTrack
      value={value}
      className={cx("gyro-segmented", className)}
      label={props["aria-label"]}
      render={(track) => (
        <BaseToggleGroup<Value>
          {...track}
          value={[value]}
          onValueChange={([chosen]) => {
            if (chosen !== undefined && chosen !== value) onValueChange(chosen);
          }}
          disabled={disabled}
          data-size={size}
          data-fill={fill || undefined}
        />
      )}
    >
      {options.map((option) => (
        <BaseToggle
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          aria-describedby={props["aria-describedby"]}
          className={cx("gyro-segmented__item", option.value === value && "is-active")}
        >
          {option.icon}
          {option.label}
        </BaseToggle>
      ))}
    </SelectionTrack>
  );
}

export interface SliderProps extends Omit<BaseSlider.Root.Props, "className"> {
  className?: string;
}

export const Slider = forwardRef<HTMLDivElement, SliderProps>(function Slider(
  { className, "aria-label": label, ...props },
  ref,
) {
  return (
    <BaseSlider.Root ref={ref} className={cx("gyro-slider", className)} {...props}>
      <BaseSlider.Control className="gyro-slider__control">
        <BaseSlider.Track className="gyro-slider__track">
          <BaseSlider.Indicator className="gyro-slider__indicator" />
          <BaseSlider.Thumb className="gyro-slider__thumb" getAriaLabel={label ? () => label : undefined} />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
});
