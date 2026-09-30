import { useEffect, useRef, useState } from "react";
import { Dialog } from "./primitives";

// Styled replacement for window.prompt: call requestText() anywhere and the
// single <TextPromptHost /> mounted in AppChrome renders the dialog.
export type TextPromptOptions = {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  placeholder?: string;
};

type PendingPrompt = TextPromptOptions & {
  id: number;
  resolve: (value: string | null) => void;
};

let nextPromptId = 0;
let pending: PendingPrompt | null = null;
const listeners = new Set<(prompt: PendingPrompt | null) => void>();

function publish(prompt: PendingPrompt | null) {
  pending = prompt;
  listeners.forEach((listener) => listener(prompt));
}

/** Resolves with the entered text, or null on Escape / Cancel. */
export function requestText(options: TextPromptOptions): Promise<string | null> {
  pending?.resolve(null);
  return new Promise((resolve) => {
    nextPromptId += 1;
    publish({ ...options, id: nextPromptId, resolve });
  });
}

export function TextPromptHost() {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(pending);
  useEffect(() => {
    listeners.add(setPrompt);
    setPrompt(pending);
    return () => {
      listeners.delete(setPrompt);
    };
  }, []);
  if (!prompt) return null;
  const finish = (value: string | null) => {
    if (pending?.id === prompt.id) publish(null);
    prompt.resolve(value);
  };
  return <TextPromptDialog key={prompt.id} prompt={prompt} onFinish={finish} />;
}

function TextPromptDialog({
  prompt,
  onFinish,
}: {
  prompt: PendingPrompt;
  onFinish: (value: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(prompt.initial ?? "");
  // Dialog focuses the field; select its text so it can be typed over.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const formId = `gyro-text-prompt-${prompt.id}`;
  return (
    <Dialog
      actions={
        <>
          <button
            className="gyro-button is-secondary"
            type="button"
            onClick={() => onFinish(null)}
          >
            Cancel
          </button>
          <button
            className="gyro-button is-primary"
            disabled={!value.trim()}
            form={formId}
            type="submit"
          >
            {prompt.confirmLabel ?? "OK"}
          </button>
        </>
      }
      className="gyro-text-prompt-dialog"
      closeLabel="Cancel"
      onClose={() => onFinish(null)}
      onKeyDown={(event) => event.stopPropagation()}
      open
      title={prompt.title}
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onFinish(value);
        }}
      >
        <label className="gyro-field" htmlFor={`${formId}-input`}>
          {prompt.label}
          <input
            ref={inputRef}
            autoComplete="off"
            className="gyro-input"
            id={`${formId}-input`}
            onChange={(event) => setValue(event.target.value)}
            placeholder={prompt.placeholder}
            spellCheck={false}
            value={value}
          />
        </label>
      </form>
    </Dialog>
  );
}
