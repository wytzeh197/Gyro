import type { SessionEvent } from "./types";

export type ChatQuestion = {
  title: string;
  options: string[];
  /** One line under each option, aligned with `options` by index. */
  details?: (string | undefined)[];
  /** Index of the option the model recommends, when it named one. */
  recommended?: number;
};
export type ChatQuestionRequest = { id: string; questions: ChatQuestion[] };

/** The answer is undefined when the user skipped that question. */
export type ChatQuestionAnswer = { question: string; answer?: string };

const MAX_QUESTIONS = 5;
const RECOMMENDED_TAG = /\s*[([]\s*recommended\s*[)\]]\s*/i;

// Only promote explicit choice questions, never code examples or arbitrary prose.
export function parseChatQuestions(message: string): ChatQuestion[] {
  const text = message.replace(/```[\s\S]*?```/g, "").trim();
  const lines = text.replace(/\?\s+-\s+/g, "?\n- ").split(/\r?\n/);
  const questions: ChatQuestion[] = [];
  for (let i = 0; i < lines.length; i++) {
    const title = (lines[i] ?? "")
      .trim()
      .replace(/^(?:#{1,6}\s+|\d+[.)]\s+)/, "")
      .replace(/\*\*/g, "");
    if (!title.endsWith("?") || title.length > 400) continue;
    const options: string[] = [];
    let end = i + 1;
    for (; end < lines.length; end++) {
      const line = (lines[end] ?? "").trim();
      if (!line) continue;
      const match = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (!match?.[1] || match[1].trim().endsWith("?")) break;
      options.push(
        ...match[1]
          .split(/\s+-\s+/)
          .map((part) => part.trim())
          .filter(Boolean),
      );
    }
    const unique = [...new Set(options)];
    if (
      unique.length >= 2 &&
      unique.length <= 8 &&
      unique.every((option) => option.length <= 300)
    ) {
      // Prose models mark their pick as "(Recommended)"; lift it into the badge.
      const recommended = unique.findIndex((option) =>
        RECOMMENDED_TAG.test(option),
      );
      const question: ChatQuestion = {
        title,
        options: unique.map((option) =>
          option.replace(RECOMMENDED_TAG, " ").trim(),
        ),
      };
      if (recommended >= 0) question.recommended = recommended;
      questions.push(question);
      i = end - 1;
    }
  }
  return questions.slice(0, MAX_QUESTIONS);
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Questions the model sent through the hidden GYRO_QUESTIONS line. Anything
 * malformed is dropped rather than repaired, so a bad payload falls back to the
 * prose parser instead of drawing a broken card.
 */
export function questionsFromPayload(value: unknown): ChatQuestion[] {
  const list =
    value && typeof value === "object" && "questions" in value
      ? (value as { questions: unknown }).questions
      : undefined;
  if (!Array.isArray(list)) return [];
  const questions: ChatQuestion[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = text(record.question) ?? text(record.title);
    if (!title || !Array.isArray(record.options)) continue;
    const options = record.options.flatMap(
      (option): { label: string; detail?: string; recommended?: boolean }[] => {
        if (typeof option === "string") {
          return text(option) ? [{ label: option.trim() }] : [];
        }
        if (!option || typeof option !== "object") return [];
        const item = option as Record<string, unknown>;
        const label = text(item.label);
        return label
          ? [
              {
                label,
                detail: text(item.detail) ?? text(item.description),
                recommended: item.recommended === true,
              },
            ]
          : [];
      },
    );
    if (options.length < 2 || options.length > 8) continue;
    const question: ChatQuestion = {
      title,
      options: options.map((option) => option.label),
    };
    if (options.some((option) => option.detail)) {
      question.details = options.map((option) => option.detail);
    }
    const recommended = options.findIndex((option) => option.recommended);
    if (recommended >= 0) question.recommended = recommended;
    questions.push(question);
  }
  return questions.slice(0, MAX_QUESTIONS);
}

export function latestChatQuestions(
  events: SessionEvent[],
): ChatQuestionRequest | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === "user-message") return undefined;
    if (event.kind !== "assistant-message") continue;
    const structured = questionsFromPayload(
      (event.payload as { questions?: unknown } | undefined)?.questions,
    );
    if (structured.length) return { id: event.id, questions: structured };
    if (!event.message.trim()) continue;
    const questions = parseChatQuestions(event.message);
    return questions.length ? { id: event.id, questions } : undefined;
  }
  return undefined;
}

const ANSWERS_HEADING = "Answers to your questions:";
const SKIPPED_ANSWER = "Skipped. Use your judgment.";
const NOTE_PREFIX = "Also: ";

/**
 * One message carries every answer back. It stays readable to the model and
 * keeps a fixed shape so the transcript can fold it into "Asked N questions".
 */
export function formatChatAnswers(
  answers: ChatQuestionAnswer[],
  note?: string,
): string {
  const blocks = answers.map(
    (item, index) =>
      `${index + 1}. ${item.question}\n→ ${item.answer?.trim() || SKIPPED_ANSWER}`,
  );
  const extra = note?.trim() ? `\n\n${NOTE_PREFIX}${note.trim()}` : "";
  return `${ANSWERS_HEADING}\n\n${blocks.join("\n\n")}${extra}`;
}

export function parseChatAnswers(
  message: string,
): { answers: ChatQuestionAnswer[]; note?: string } | undefined {
  if (!message.startsWith(ANSWERS_HEADING)) return undefined;
  const body = message.slice(ANSWERS_HEADING.length);
  const noteAt = body.indexOf(`\n\n${NOTE_PREFIX}`);
  const blocks = noteAt >= 0 ? body.slice(0, noteAt) : body;
  const answers = [...blocks.matchAll(/^\d+\. (.+)\n→ (.*)$/gm)].map(
    (match) => ({
      question: match[1] ?? "",
      answer: match[2] === SKIPPED_ANSWER ? undefined : match[2],
    }),
  );
  if (!answers.length) return undefined;
  const note =
    noteAt >= 0
      ? body.slice(noteAt + NOTE_PREFIX.length + 2).trim()
      : undefined;
  return note ? { answers, note } : { answers };
}
