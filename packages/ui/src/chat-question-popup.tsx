import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./chat-question-popup.css";
import {
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  PenLine,
  X,
} from "lucide-react";
import {
  formatChatAnswers,
  type ChatQuestionAnswer,
  type ChatQuestionRequest,
} from "./chat-questions";

// Options are written as Markdown ("**Stash them**, then …"); show the emphasis
// and code the model meant instead of the raw asterisks and backticks.
export function InlineMarkdown({ text }: { text: string }) {
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

/** Number keys pick, Return takes the recommended pick, Esc closes. */
function isPlainKey(event: KeyboardEvent) {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * Questions take the composer's place one at a time: the composer stays
 * mounted underneath so a draft survives, and returns once every question is
 * answered or skipped. Answering moves to the next open question; the last one
 * sends everything as a single message.
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
  const total = request.questions.length;
  const [page, setPage] = useState(0);
  // undefined: not reached yet; null: skipped; string: the answer.
  const [answers, setAnswers] = useState<(string | null | undefined)[]>(() =>
    request.questions.map(() => undefined),
  );
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLFormElement>(null);
  const question = request.questions[page];

  // The composer this replaces had focus a moment ago; hand it to the card so
  // the number keys keep working instead of falling back to the page.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const current = answers[page];
    const picked =
      current && question ? question.options.map(plainText) : undefined;
    setCustom(current && picked && !picked.includes(current) ? current : "");
    // Only a page change resets the field, never a keystroke in it.
  }, [page]);

  if (!question) return null;

  const record = (value: string | null) => {
    const next = answers.slice();
    next[page] = value;
    setAnswers(next);
    const open = next.findIndex(
      (answer, index) => index > page && answer === undefined,
    );
    const earlier = next.findIndex((answer) => answer === undefined);
    const target = open >= 0 ? open : earlier;
    if (target >= 0) {
      setPage(target);
      return;
    }
    try {
      const result: ChatQuestionAnswer[] = request.questions.map(
        (item, index) => ({
          question: plainText(item.title),
          answer: next[index] ?? undefined,
        }),
      );
      onSend(formatChatAnswers(result, draft));
      onDismiss();
    } catch {
      setError("Could not send. Your answers are still here.");
    }
  };

  const choose = (index: number) => {
    const option = question.options[index];
    if (option) record(plainText(option));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const inField = event.target instanceof HTMLInputElement;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (inField && custom) {
        setCustom("");
        rootRef.current?.focus();
        return;
      }
      onDismiss();
      return;
    }
    if (inField || !isPlainKey(event)) return;
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < question.options.length) {
        event.preventDefault();
        choose(index);
      }
    } else if (event.key === "Enter" && event.target === rootRef.current) {
      event.preventDefault();
      choose(question.recommended ?? 0);
    } else if (event.key === "ArrowRight" && page < total - 1) {
      event.preventDefault();
      setPage(page + 1);
    } else if (event.key === "ArrowLeft" && page > 0) {
      event.preventDefault();
      setPage(page - 1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [
        ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
          ".gyro-question-option",
        ) ?? []),
      ];
      if (!buttons.length) return;
      event.preventDefault();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        at < 0
          ? step > 0
            ? 0
            : buttons.length - 1
          : (at + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  const current = answers[page];
  return (
    <form
      aria-label={total > 1 ? `Question ${page + 1} of ${total}` : "Question"}
      className="gyro-question-dock"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (custom.trim()) record(custom.trim());
      }}
      ref={rootRef}
      tabIndex={-1}
    >
      <header className="gyro-question-dock-head">
        <h3 id={`${request.id}-question`}>
          <InlineMarkdown text={question.title} />
        </h3>
        {total > 1 ? (
          <span className="gyro-question-dock-pager">
            <span aria-hidden="true" className="gyro-question-dock-steps">
              {request.questions.map((_, index) => (
                <i
                  className={
                    index === page
                      ? "is-current"
                      : answers[index] !== undefined
                        ? "is-done"
                        : ""
                  }
                  key={index}
                />
              ))}
            </span>
            <button
              aria-label="Previous question"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              type="button"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="gyro-question-dock-count">
              {page + 1} of {total}
            </span>
            <button
              aria-label="Next question"
              disabled={page === total - 1}
              onClick={() => setPage(page + 1)}
              type="button"
            >
              <ChevronRight size={14} />
            </button>
          </span>
        ) : null}
        <button
          aria-label="Dismiss questions"
          className="gyro-icon-button is-small gyro-question-dock-close"
          onClick={onDismiss}
          title="Dismiss (Esc)"
          type="button"
        >
          <X size={14} />
        </button>
      </header>

      <div
        aria-labelledby={`${request.id}-question`}
        className="gyro-question-dock-options"
        role="group"
      >
        {question.options.map((option, index) => {
          const value = plainText(option);
          const detail = question.details?.[index];
          const isRecommended = question.recommended === index;
          return (
            <button
              aria-pressed={current === value}
              className={`gyro-question-option${isRecommended ? " is-recommended" : ""}`}
              key={option}
              onClick={() => choose(index)}
              type="button"
            >
              <kbd aria-hidden="true">{index + 1}</kbd>
              <span className="gyro-question-option-text">
                <span className="gyro-question-option-label">
                  <InlineMarkdown text={option} />
                  {isRecommended ? (
                    <em className="gyro-question-option-badge">Recommended</em>
                  ) : null}
                </span>
                {detail ? (
                  <small>
                    <InlineMarkdown text={detail} />
                  </small>
                ) : null}
              </span>
              <ArrowRight
                aria-hidden="true"
                className="gyro-question-option-go"
                size={14}
              />
            </button>
          );
        })}
      </div>

      <div className="gyro-question-dock-other">
        <PenLine aria-hidden="true" size={13} />
        <input
          aria-label={"Your own answer to: " + plainText(question.title)}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="No, and tell Gyro what to do instead"
          value={custom}
        />
        {custom.trim() ? (
          <button
            aria-label="Send this answer"
            className="gyro-button is-primary is-small gyro-question-dock-send"
            type="submit"
          >
            <ArrowUp size={13} />
          </button>
        ) : (
          <button
            className="gyro-button is-ghost is-small gyro-question-dock-skip"
            onClick={() => record(null)}
            type="button"
          >
            Skip
          </button>
        )}
      </div>

      {draft.trim() ? (
        <p className="gyro-question-dock-note">
          Your draft is sent with the answers.
        </p>
      ) : null}
      {error ? (
        <p className="gyro-question-dock-note is-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
