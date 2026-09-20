import type { SessionEvent } from "./types";

export type ChatQuestion = { title: string; options: string[] };
export type ChatQuestionRequest = { id: string; questions: ChatQuestion[] };

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
      questions.push({ title, options: unique });
      i = end - 1;
    }
  }
  return questions.slice(0, 5);
}

export function latestChatQuestions(
  events: SessionEvent[],
): ChatQuestionRequest | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === "user-message") return undefined;
    if (event.kind !== "assistant-message" || !event.message.trim()) continue;
    const questions = parseChatQuestions(event.message);
    return questions.length ? { id: event.id, questions } : undefined;
  }
  return undefined;
}
