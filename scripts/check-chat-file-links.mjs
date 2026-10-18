import assert from "node:assert/strict";
import {
  bareChatUrl,
  chatBareUrlPattern,
  linkedChatFile,
  parseChatMarkdownLink,
  chatInlineTokenPattern,
  isCitedImageTarget,
  markdownImageTargets,
} from "../packages/ui/src/chat-file-links.ts";
import { replyLinkMark } from "../packages/ui/src/external-links.ts";
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
assert.equal(isCitedImageTarget("images/composer.png"), true);
assert.equal(isCitedImageTarget("/tmp/shot.webp"), true);
assert.equal(isCitedImageTarget("file:///tmp/shot.jpg"), true);
assert.equal(isCitedImageTarget("../secret.png"), false);
assert.equal(isCitedImageTarget("https://example.com/a.png"), false);
assert.equal(isCitedImageTarget("/tmp/a.gif"), false);
assert.equal(isCitedImageTarget("notes\n.png"), false);
const cited =
  "![Composer with the microphone left of Send](images/composer.png)\n\n`images/composer.png`";
assert.equal(markdownImageTargets(cited).has("images/composer.png"), true);
assert.equal(markdownImageTargets("see `images/other.png`").size, 0);
// A bare URL in a reply is a link, not grey text the user has to copy.
assert.equal(bareChatUrl("https://gyro.dev"), "https://gyro.dev");
assert.equal(
  bareChatUrl("https://gyro.dev/docs)."),
  "https://gyro.dev/docs",
  "a sentence's closing bracket must not become part of the href",
);
assert.equal(
  bareChatUrl("https://example.com/a_(b)"),
  "https://example.com/a_(b)",
  "brackets the URL opened itself stay",
);
assert.equal(bareChatUrl("https://gyro.dev."), "https://gyro.dev");
assert.equal(bareChatUrl("https://"), undefined);
assert.equal(bareChatUrl("javascript:alert(1)"), undefined);
assert.deepEqual(
  "see https://gyro.dev now".split(chatBareUrlPattern).filter(Boolean),
  ["see ", "https://gyro.dev", " now"],
);
// Only hosts Gyro can name with confidence earn a mark; a lookalike host or a
// non-web scheme must stay a plain link instead of borrowing the logo.
assert.equal(replyLinkMark("https://github.com/gyro-dev/gyro/pull/12"), "github");
assert.equal(replyLinkMark("https://gist.github.com/abc"), "github");
assert.equal(replyLinkMark("https://www.github.com/x/y"), "github");
assert.equal(replyLinkMark("https://example.com/github.com"), undefined);
assert.equal(replyLinkMark("https://notgithub.com/x"), undefined);
assert.equal(replyLinkMark("mailto:hi@gyro.dev"), undefined);
console.log(
  "Chat file link checks passed: media, documents, local paths, encoded names, nested parentheses, unsafe schemes, and host marks.",
);
