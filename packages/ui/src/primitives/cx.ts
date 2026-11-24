import { createElement, forwardRef, type ElementType } from "react";

type ClassPart = string | false | null | undefined;

/** Joins class names, skipping empty parts. */
export function cx(...parts: ClassPart[]): string {
  return parts.filter(Boolean).join(" ");
}

type StateClassName<State> =
  | string
  | ((state: State) => string | undefined)
  | undefined;

/**
 * Prepends a primitive's base class to a Base UI `className`, which may be a
 * string or a function of the part's state.
 */
export function withBaseClass<State>(
  base: string,
  className: StateClassName<State>,
): string | ((state: State) => string) {
  if (typeof className === "function") {
    return (state: State) => cx(base, className(state));
  }
  return cx(base, className);
}

/**
 * Wraps a Base UI part so it always carries `base`, keeping the part's own
 * prop types (generics included) for callers.
 */
export function styledPart<Component extends ElementType>(
  component: Component,
  base: string,
  displayName: string,
): Component {
  const Styled = forwardRef<unknown, { className?: StateClassName<unknown> }>(
    (props, ref) =>
      createElement(component, {
        ...props,
        ref,
        className: withBaseClass(base, props.className),
      }),
  );
  Styled.displayName = displayName;
  return Styled as unknown as Component;
}
