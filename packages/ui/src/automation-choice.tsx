import { SelectMenu, type SelectMenuOption } from "./primitives";

export type AutomationChoiceOption = SelectMenuOption;

/** Automation setting rows use the shared SelectMenu, right-aligned. */
export function AutomationChoice(props: {
  label: string;
  value: string;
  options: AutomationChoiceOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  disabled?: boolean;
}) {
  return <SelectMenu {...props} className="gyro-automation-choice" />;
}
