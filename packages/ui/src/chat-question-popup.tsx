import { useState } from "react";
import "./chat-question-popup.css";
import { X, MessageCircleQuestion, ArrowUp } from "lucide-react";
import type { ChatQuestionRequest } from "./chat-questions";

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
  const answerAt = (index: number) =>
    custom[index]?.trim() || answers[index] || "";
  const ready = request.questions.every((_, index) => Boolean(answerAt(index)));
  return (
    <form
      className="gyro-chat-question-popup"
      aria-label="Answer questions"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDismiss();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || sending) return;
        setSending(true);
        try {
          const response = request.questions
            .map((question, index) =>
              request.questions.length === 1
                ? answerAt(index)
                : question.title + "\n" + answerAt(index),
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
        <span>
          <MessageCircleQuestion size={17} />{" "}
          {request.questions.length === 1
            ? "A question for you"
            : "A few questions for you"}
        </span>
        <button
          type="button"
          aria-label="Dismiss questions"
          onClick={onDismiss}
        >
          <X size={17} />
        </button>
      </header>
      <div className="gyro-chat-question-scroll">
        {request.questions.map((question, index) => (
          <fieldset key={index}>
            <legend>{question.title}</legend>
            <div className="gyro-chat-question-options">
              {question.options.map((option) => (
                <label
                  key={option}
                  className={
                    !custom[index]?.trim() && answers[index] === option
                      ? "is-selected"
                      : ""
                  }
                >
                  <input
                    type="radio"
                    name={request.id + "-" + index}
                    checked={
                      !custom[index]?.trim() && answers[index] === option
                    }
                    onChange={() => {
                      setAnswers({ ...answers, [index]: option });
                      setCustom({ ...custom, [index]: "" });
                    }}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </div>
            <textarea
              aria-label={"Your own answer to: " + question.title}
              placeholder="Or write your own answer…"
              rows={2}
              value={custom[index] || ""}
              onChange={(event) =>
                setCustom({ ...custom, [index]: event.target.value })
              }
            />
          </fieldset>
        ))}
        {draft.trim() ? (
          <p className="gyro-chat-question-draft">
            Your composer draft will also be sent: {draft}
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer>
        <span>
          {request.questions.length > 1
            ? "Answer each question to continue"
            : "Choose an option or write an answer"}
        </span>
        <button
          className="gyro-primary-button"
          type="submit"
          disabled={!ready || sending}
        >
          Send {request.questions.length === 1 ? "answer" : "answers"}{" "}
          <ArrowUp size={15} />
        </button>
      </footer>
    </form>
  );
}
