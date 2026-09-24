import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import "./chat-question-popup.css";
import { ArrowUp, Check, MessageCircleQuestion, X } from "lucide-react";
import type { ChatQuestionRequest } from "./chat-questions";

// Options are written as Markdown ("**Stash them**, then …"); show the emphasis
// and code the model meant instead of the raw asterisks and backticks.
function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(
      match[1] !== undefined ? (
        <strong key={index}>{match[1]}</strong>
      ) : (
        <code key={index}>{match[2]}</code>
      ),
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}

const plainText = (text: string) =>
  text.replace(/\*\*(.+?)\*\*|`([^`]+)`/g, "$1$2");

/**
 * The question takes the composer's place, like plan approval: the composer
 * stays mounted underneath so a draft survives, and returns once the question
 * is answered or dismissed.
 */
export function ChatQuestionPopup({
  request,
  onSend,
  onDismiss,
  draft,
}: {
  request: ChatQuestionRequest;
  onSend: (answer: string) => void;
  onDismiss: () => void;
  draft: string;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const single = request.questions.length === 1;
  const answerAt = (index: number) =>
    custom[index]?.trim() || answers[index] || "";
  const ready = request.questions.every((_, index) => Boolean(answerAt(index)));
  const choose = (index: number, option: string) => {
    setAnswers((current) => ({ ...current, [index]: option }));
    setCustom((current) => ({ ...current, [index]: "" }));
  };

  // The composer this replaces had focus a moment ago; hand it to the card so
  // the keyboard keeps working instead of falling back to the page.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    formRef.current
      ?.querySelector<HTMLInputElement>('input[type="radio"]')
      ?.focus({ preventScroll: true });
  }, []);

  return (
    <form
      className="gyro-chat-question-popup"
      aria-label="Answer questions"
      ref={formRef}
      onKeyDown={(event) => {
        const inText = event.target instanceof HTMLTextAreaElement;
        if (event.key === "Escape") {
          event.stopPropagation();
          onDismiss();
        } else if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !(event.target instanceof HTMLButtonElement)
        ) {
          event.preventDefault();
          formRef.current?.requestSubmit();
        } else if (
          single &&
          !inText &&
          !event.metaKey &&
          !event.ctrlKey &&
          /^[1-9]$/.test(event.key)
        ) {
          const option = request.questions[0]?.options[Number(event.key) - 1];
          if (option) {
            event.preventDefault();
            choose(0, plainText(option));
          }
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || sending) return;
        setSending(true);
        try {
          const response = request.questions
            .map((question, index) =>
              single
                ? answerAt(index)
                : plainText(question.title) + "\n" + answerAt(index),
            )
            .join("\n\n");
          onSend(draft.trim() ? response + "\n\n" + draft.trim() : response);
          onDismiss();
        } catch {
          setSending(false);
          setError("Could not send. Your answers are still here.");
        }
      }}
    >
      <header>
        <MessageCircleQuestion aria-hidden="true" size={14} />
        <span>
          {single ? "Question" : `${request.questions.length} questions`}
        </span>
        <button
          type="button"
          aria-label="Dismiss questions"
          title="Dismiss (Esc)"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </header>
      <div className="gyro-chat-question-scroll">
        {request.questions.map((question, index) => (
          <fieldset key={index}>
            <legend>
              <InlineMarkdown text={question.title} />
            </legend>
            <div className="gyro-chat-question-options">
              {question.options.map((option, optionIndex) => {
                const value = plainText(option);
                const selected =
                  !custom[index]?.trim() && answers[index] === value;
                return (
                  <label key={option} className={selected ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name={request.id + "-" + index}
                      checked={selected}
                      onChange={() => choose(index, value)}
                    />
                    <kbd aria-hidden="true">{optionIndex + 1}</kbd>
                    <span>
                      <InlineMarkdown text={option} />
                    </span>
                    {selected ? <Check aria-hidden="true" size={14} /> : null}
                  </label>
                );
              })}
            </div>
            <textarea
              aria-label={"Your own answer to: " + plainText(question.title)}
              placeholder="Something else…"
              rows={1}
              value={custom[index] || ""}
              onChange={(event) => {
                const field = event.currentTarget;
                field.style.height = "auto";
                field.style.height = `${field.scrollHeight}px`;
                setCustom({ ...custom, [index]: event.target.value });
              }}
            />
          </fieldset>
        ))}
        {draft.trim() ? (
          <p className="gyro-chat-question-draft">
            Your draft is sent with the answer: {draft}
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer>
        <span>
          {single
            ? "Pick 1–" +
              Math.min(9, request.questions[0]?.options.length ?? 1) +
              " or type · Enter to send"
            : "Answer each question · Enter to send"}
        </span>
        <button type="button" className="is-secondary" onClick={onDismiss}>
          Dismiss
        </button>
        <button
          type="submit"
          className="is-primary"
          disabled={!ready || sending}
        >
          Send <ArrowUp aria-hidden="true" size={13} />
        </button>
      </footer>
    </form>
  );
}
