import { flushSync } from "react-dom";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import "./settings-disclosure.css";

type DisclosureContext = {
  page: string;
  values: Record<string, boolean>;
  change: (key: string, open: boolean) => void;
};
const Context = createContext<DisclosureContext | null>(null);
export function SettingsDisclosureProvider({
  page,
  values = {},
  onChange,
  children,
}: {
  page: string;
  values?: Record<string, boolean>;
  onChange?: (values: Record<string, boolean>) => void;
  children: ReactNode;
}) {
  const [local, setLocal] = useState(values);
  const current = useRef(values);
  current.current = onChange ? values : local;
  return (
    <Context.Provider
      value={{
        page,
        values: current.current,
        change: (key, open) => {
          const next = { ...current.current, [key]: open };
          current.current = next;
          onChange ? onChange(next) : setLocal(next);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}

/** Reveal ancestors before focusing a search result; children remain mounted. */
export function revealSettingsTarget(target: HTMLElement | null) {
  if (target)
    flushSync(() =>
      target.dispatchEvent(
        new CustomEvent("gyro:reveal-setting", { bubbles: true }),
      ),
    );
}

function liveSummary(body: HTMLElement): string {
  const values: string[] = [];
  for (const element of body.querySelectorAll<HTMLElement>(
    "select, [role=switch], button[aria-pressed=true], .gyro-settings-info-value",
  )) {
    if (element instanceof HTMLSelectElement)
      values.push(
        element.selectedOptions[0]?.textContent?.trim() || "Unavailable",
      );
    else if (element.getAttribute("role") === "switch")
      values.push(
        `${element.getAttribute("aria-label") ?? "Switch"}: ${element.getAttribute("aria-checked") === "true" ? "on" : "off"}`,
      );
    else if (element.textContent?.trim())
      values.push(element.getAttribute("aria-label") || element.textContent.trim());
    if (values.length >= 2) break;
  }
  return values.join(" · ");
}

export function SettingsDisclosure({
  id,
  title,
  description,
  summary,
  actions,
  children,
  attention = false,
  defaultOpen,
}: {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  actions?: ReactNode;
  children: ReactNode;
  attention?: boolean;
  defaultOpen?: boolean;
}) {
  const context = useContext(Context);
  const key = `${context?.page ?? "settings"}/${id}`;
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [initialOpen, setInitialOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [measuredSummary, setMeasuredSummary] = useState("");
  const lastError = useRef("");
  const open = revealed || (context?.values[key] ?? initialOpen);
  const bodyId = `settings-${key.replace(/[^a-z0-9_-]/gi, "-")}`;
  useLayoutEffect(() => {
    setInitialOpen(
      defaultOpen ??
        (root.current
          ?.closest(".gyro-settings-content")
          ?.querySelector("[data-settings-disclosure]") === root.current),
    );
  }, [key, defaultOpen]);
  useEffect(() => {
    const element = root.current;
    const reveal = () => setRevealed(true);
    element?.addEventListener("gyro:reveal-setting", reveal);
    return () => element?.removeEventListener("gyro:reveal-setting", reveal);
  }, []);
  useLayoutEffect(() => {
    setRevealed(false);
    lastError.current = "";
  }, [key]);
  useEffect(() => {
    if (attention) setRevealed(true);
  }, [attention]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const update = () => {
      setMeasuredSummary(liveSummary(element));
      const error = [
        ...element.querySelectorAll('[role="alert"], [aria-invalid="true"]'),
      ]
        .map(
          (e) =>
            e.textContent || e.getAttribute("aria-label") || "Invalid value",
        )
        .join(" ");
      if (error && error !== lastError.current) setRevealed(true);
      lastError.current = error;
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-checked",
        "aria-pressed",
        "aria-invalid",
        "role",
        "value",
      ],
    });
    element.addEventListener("change", update);
    return () => {
      observer.disconnect();
      element.removeEventListener("change", update);
    };
  }, [children]);
  const subtitle = open
    ? description
    : summary || measuredSummary || description || "View settings";
  return (
    <section
      ref={root}
      className={`gyro-settings-disclosure-group${open ? " is-open" : ""}`}
      data-settings-disclosure={id}
      data-setting-key={title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}
      tabIndex={-1}
    >
      <div className="gyro-settings-disclosure-heading">
        <h2>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => {
              setRevealed(false);
              context?.change(key, !open);
              if (!context) setInitialOpen(!open);
            }}
          >
            <SlidersHorizontal aria-hidden="true" size={18} />
            <span>
              <strong>{title}</strong>
              {subtitle ? <small>{subtitle}</small> : null}
            </span>
            <ChevronDown
              className="gyro-settings-disclosure-chevron"
              aria-hidden="true"
              size={16}
            />
          </button>
        </h2>
        {actions ? (
          <div className="gyro-settings-disclosure-actions">{actions}</div>
        ) : null}
      </div>
      <div
        ref={body}
        id={bodyId}
        className="gyro-settings-disclosure-body"
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
