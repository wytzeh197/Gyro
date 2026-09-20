import assert from "node:assert/strict";
import {
  parseChatQuestions,
  latestChatQuestions,
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
console.log("Chat question detection checks passed.");
