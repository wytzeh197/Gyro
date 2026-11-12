import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowRight, ChevronLeft, ChevronRight, X } from "lucide-react";
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
function isPlainKey(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Set by a card in the composer; the composer's send hands its text here. */
export type ComposerAnswerRef = MutableRefObject<
  ((text: string) => void) | null
>;

/**
 * A card that sits in the composer is answered from the composer's own text
 * box: sending typed text goes to the card instead of the chat, and while the
 * box is empty the number keys pick an option.
 */
export function useComposerAnswer(
  answerRef: ComposerAnswerRef | undefined,
  rootRef: RefObject<HTMLElement | null>,
  onAnswer: (text: string) => void,
  onPick: (index: number) => boolean,
) {
  const latest = useRef({ onAnswer, onPick });
  latest.current = { onAnswer, onPick };
  useEffect(() => {
    if (!answerRef) return;
    const handler = (text: string) => latest.current.onAnswer(text);
    answerRef.current = handler;
    return () => {
      if (answerRef.current === handler) answerRef.current = null;
    };
  }, [answerRef]);
  useEffect(() => {
    const field = rootRef.current
      ?.closest(".gyro-composer-input")
      ?.querySelector("textarea");
    if (!field) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (field.value || event.isComposing || !isPlainKey(event)) return;
      if (!/^[1-9]$/.test(event.key)) return;
      if (latest.current.onPick(Number(event.key) - 1)) event.preventDefault();
    };
    field.addEventListener("keydown", onKeyDown);
    return () => field.removeEventListener("keydown", onKeyDown);
  }, [rootRef]);
}

/**
 * Questions open upward out of the composer's text box, one at a time. Typing
 * in the box and sending gives your own answer; the box returns to normal once
 * every question is answered or skipped. Answering moves to the next open question; the last one
 * sends everything as a single message.
 */
export function ChatQuestionPopup({
  request,
  onSend,
  onDismiss,
  answerRef,
}: {
  request: ChatQuestionRequest;
  onSend: (answer: string) => void;
  onDismiss: () => void;
  answerRef?: ComposerAnswerRef;
}) {
  const total = request.questions.length;
  const [page, setPage] = useState(0);
  // undefined: not reached yet; null: skipped; string: the answer.
  const [answers, setAnswers] = useState<(string | null | undefined)[]>(() =>
    request.questions.map(() => undefined),
  );
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLFormElement>(null);
  const question = request.questions[page];
  const recordRef = useRef<(value: string | null) => void>(() => {});
  const chooseRef = useRef<(index: number) => boolean>(() => false);
  useComposerAnswer(
    answerRef,
    rootRef,
    (text) => recordRef.current(text),
    (index) => chooseRef.current(index),
  );

  // The composer this replaces had focus a moment ago; hand it to the card so
  // the number keys keep working instead of falling back to the page.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rootRef.current?.focus({ preventScroll: true });
  }, []);


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
    // Skipping every question just closes the card; there is nothing to tell
    // the model, so no message goes out.
    if (next.every((answer) => answer === null)) {
      onDismiss();
      return;
    }
    try {
      const result: ChatQuestionAnswer[] = request.questions.map(
        (item, index) => ({
          question: plainText(item.title),
          answer: next[index] ?? undefined,
        }),
      );
      onSend(formatChatAnswers(result));
      onDismiss();
    } catch {
      setError("Could not send. Your answers are still here.");
    }
  };

  const choose = (index: number) => {
    const option = question.options[index];
    if (!option) return false;
    record(plainText(option));
    return true;
  };

  recordRef.current = record;
  chooseRef.current = choose;

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (!isPlainKey(event)) return;
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
      onSubmit={(event) => event.preventDefault()}
      ref={rootRef}
      tabIndex={-1}
    >
      <header className="gyro-question-dock-head">
        <h3 id={`${request.id}-question`}>
          <InlineMarkdown text={question.title} />
        </h3>
        {total > 1 ? (
          <span className="gyro-question-dock-pager">
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
          className="gyro-question-dock-skip"
          onClick={() => record(null)}
          title="Skip this question"
          type="button"
        >
          Skip
        </button>
        <button
          aria-label="Dismiss questions"
          className="gyro-question-dock-close"
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

      {error ? (
        <p className="gyro-question-dock-note is-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
