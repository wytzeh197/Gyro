import assert from "node:assert/strict";
import {
  formatChatAnswers,
  latestChatQuestions,
  parseChatAnswers,
  parseChatQuestions,
  questionsFromPayload,
} from "../packages/ui/src/chat-questions.ts";

const sample =
  "Which GitHub actions break most often for you? - PRs, checks, and merges - Push, pull, and sync - Sign-in or repository access";
assert.deepEqual(parseChatQuestions(sample), [
  {
    title: "Which GitHub actions break most often for you?",
    options: [
      "PRs, checks, and merges",
      "Push, pull, and sync",
      "Sign-in or repository access",
    ],
  },
]);
assert.equal(
  parseChatQuestions(
    "Which theme?\n- Light\n- Dark\n\nWhich layout?\n1. Wide\n2. Compact",
  ).length,
  2,
);
assert.deepEqual(
  parseChatQuestions(
    "Here are the changes:\n- Fixed search\n- Added navigation",
  ),
  [],
);
assert.deepEqual(
  parseChatQuestions("```text\nWhich theme?\n- Light\n- Dark\n```"),
  [],
);
const question = { id: "q", kind: "assistant-message", message: sample };
assert.equal(latestChatQuestions([question])?.id, "q");
assert.equal(
  latestChatQuestions([question, { kind: "user-message", message: "Push" }]),
  undefined,
);
assert.equal(
  latestChatQuestions([
    question,
    { kind: "assistant-message", message: "Done." },
  ]),
  undefined,
);
assert.equal(
  latestChatQuestions([
    question,
    { kind: "system-event", message: "Completed" },
  ])?.id,
  "q",
);

// Prose questions keep their pick when the model tags it.
assert.deepEqual(
  parseChatQuestions("Which theme?\n- Light (Recommended)\n- Dark"),
  [{ title: "Which theme?", options: ["Light", "Dark"], recommended: 0 }],
);

// Structured questions from the hidden GYRO_QUESTIONS line.
const payload = {
  questions: [
    {
      question: "Which release?",
      options: [
        { label: "Stable", detail: "First public release", recommended: true },
        { label: "Alpha" },
      ],
    },
    { question: "Only one option", options: [{ label: "Lonely" }] },
    { options: [{ label: "A" }, { label: "B" }] },
  ],
};
assert.deepEqual(questionsFromPayload(payload), [
  {
    title: "Which release?",
    options: ["Stable", "Alpha"],
    details: ["First public release", undefined],
    recommended: 0,
  },
]);
assert.deepEqual(questionsFromPayload({ questions: "nope" }), []);
assert.deepEqual(questionsFromPayload(undefined), []);
const structured = {
  id: "s",
  kind: "assistant-message",
  message: "A few decisions first.",
  payload: { questions: payload },
};
assert.equal(latestChatQuestions([structured])?.questions[0]?.title, "Which release?");
// A marker-only reply still asks, even with no visible text.
assert.equal(
  latestChatQuestions([{ ...structured, message: "" }])?.id,
  "s",
);

// Answers travel as one message and fold back into the transcript row.
const answered = formatChatAnswers(
  [
    { question: "Which release?", answer: "Stable" },
    { question: "Which layout?" },
  ],
  "Keep the launch small.",
);
assert.deepEqual(parseChatAnswers(answered), {
  answers: [
    { question: "Which release?", answer: "Stable" },
    { question: "Which layout?", answer: undefined },
  ],
  note: "Keep the launch small.",
});
assert.equal(parseChatAnswers("Which release? Stable"), undefined);
console.log("Chat question detection checks passed.");
