import assert from "node:assert/strict";
import {
  linkedChatFile,
  parseChatMarkdownLink,
  chatInlineTokenPattern,
} from "../packages/ui/src/chat-file-links.ts";
assert.deepEqual(
  linkedChatFile("Launch demo", "/Users/me/Screen Recording (2).mov"),
  {
    target: "/Users/me/Screen Recording (2).mov",
    name: "Launch demo",
    kind: "video",
    local: true,
  },
);
assert.equal(
  linkedChatFile("", "file:///Users/me/My%20report.pdf").name,
  "My report.pdf",
);
assert.equal(
  linkedChatFile("Budget", "https://example.com/budget.xlsx?download=1#sheet")
    .kind,
  "file",
);
assert.equal(
  linkedChatFile("Spec.pdf", "https://example.com/download?id=42").kind,
  "pdf",
);
assert.equal(linkedChatFile("", "/tmp/chart.png").kind, "image");
assert.equal(
  linkedChatFile("Source", "/tmp/code.ts:12").target,
  "/tmp/code.ts",
);
assert.equal(linkedChatFile("Docs", "https://example.com/docs"), undefined);
for (const target of [
  "javascript:alert(1)",
  "data:text/html,hello",
  "file://other-host/share/a.pdf",
  "//example.com/a.pdf",
  "/tmp/a\n.pdf",
])
  assert.equal(linkedChatFile("bad", target), undefined);
assert.equal(linkedChatFile("Video", "/tmp/demo.mov", true).kind, "video");
assert.equal(linkedChatFile("Audio", "/tmp/demo.mp3", true).kind, "audio");
const markdown =
  "Here is ![Demo](/tmp/Screen Recording (2).mov) and [Report](</tmp/My Report.pdf>) plus [Docs](https://example.com/docs).";
const links = markdown
  .split(chatInlineTokenPattern)
  .map(parseChatMarkdownLink)
  .filter(Boolean);
assert.equal(links.length, 3);
assert.equal(links[0].target, "/tmp/Screen Recording (2).mov");
assert.equal(links[0].image, true);
assert.equal(links[1].target, "/tmp/My Report.pdf");
assert.equal(
  parseChatMarkdownLink('[Report](https://example.com/report.pdf "Q4 report")')
    .target,
  "https://example.com/report.pdf",
);
assert.equal(
  "`[Code](/tmp/a.pdf)`".split(chatInlineTokenPattern).filter(Boolean).length,
  1,
);
console.log(
  "Chat file link checks passed: media, documents, local paths, encoded names, nested parentheses, and unsafe schemes.",
);
