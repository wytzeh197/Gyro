import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { getLanguage, resolveLanguage, searchLanguages } from "./registry";

export function LanguagePicker({
  path,
  content,
  override,
  detectedLanguage,
  onChange,
}: {
  path: string;
  content?: string;
  override?: string;
  detectedLanguage?: string;
  onChange?: (id?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ right: 8, bottom: 28 });
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const detected =
    (detectedLanguage && getLanguage(detectedLanguage)) ||
    resolveLanguage({ path, content });
  const language = (override && getLanguage(override)) || detected;
  const choices = searchLanguages(query);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const select = (id?: string) => {
    onChange?.(id);
    setOpen(false);
    setQuery("");
    button.current?.focus();
  };
  return (
    <div
      className="gyro-language-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && open) {
          event.preventDefault();
          const items = [
            ...(menu.current?.querySelectorAll<HTMLButtonElement>(
              "[role=option]",
            ) ?? []),
          ];
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          items[
            (index < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
          ]?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={button}
        disabled={!onChange}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${language.name}${override ? " (manual override)" : " (auto detected)"}. Change language mode.`}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          if (rect)
            setAnchor({
              right: Math.max(8, window.innerWidth - rect.right),
              bottom: window.innerHeight - rect.top + 6,
            });
          setQuery("");
          setOpen((value) => !value);
        }}
      >
        {language.name}
        {override ? " •" : ""}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            style={{ position: "fixed", ...anchor }}
            className="gyro-language-menu"
            role="dialog"
            aria-label="Change language mode"
          >
            <input
              ref={input}
              aria-label="Search languages"
              placeholder="Search by name, alias, or extension"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && query && choices[0]) {
                  event.preventDefault();
                  event.stopPropagation();
                  select(choices[0].id);
                }
              }}
            />
            <div role="listbox" aria-label="Language modes">
              <button
                type="button"
                role="option"
                aria-selected={!override}
                onClick={() => select()}
              >
                Auto Detect <small>{detected.name}</small>
              </button>
              {!query && (
                <button
                  type="button"
                  role="option"
                  aria-selected={override === "plaintext"}
                  onClick={() => select("plaintext")}
                >
                  {getLanguage("plaintext")!.name}
                </button>
              )}
              {choices
                .filter((choice) => query || choice.id !== "plaintext")
                .map((choice) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={language.id === choice.id}
                    key={choice.id}
                    onClick={() => select(choice.id)}
                  >
                    {choice.name}
                    <small>{choice.extensions?.slice(0, 3).join(" ")}</small>
                  </button>
                ))}
              {!choices.length && <p>No matching languages.</p>}
            </div>
            <p>Applies to this file for this session.</p>
          </div>,
          document.body,
        )}
    </div>
  );
}
