import assert from "node:assert/strict";

import { parseProviderLoginProgress } from "../apps/desktop/src/provider-login-progress.ts";

// Claude Code: browser OAuth with an optional paste-back prompt.
const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=nS0Cm-ly8IEhdTLtW&code_challenge_method=S256&state=5ZX_IG3fy";
const claude = parseProviderLoginProgress(
  `\u001b[2mOpening browser to sign in…\u001b[22m\r\nIf the browser didn't open, visit: ${claudeUrl}\r\nPaste code here if prompted > `,
);
assert.equal(claude.url, claudeUrl);
assert.equal(claude.deviceCode, undefined, "OAuth query tokens are not codes");
assert.equal(claude.acceptsCode, true);

// The same URL hard-wrapped by an 80-column terminal is rejoined.
const prefix = "If the browser didn't open, visit: ";
const flat = `${prefix}${claudeUrl}`;
const wrappedLines = flat.match(/.{1,80}/g);
const wrapped = parseProviderLoginProgress(
  `${wrappedLines.join("\n")}\nPaste code here if prompted > `,
);
assert.equal(wrapped.url, claudeUrl);

// A short line after a URL is the next message, not part of the URL.
const short = parseProviderLoginProgress(
  "Visit https://example.com/login\nWaiting\n",
);
assert.equal(short.url, "https://example.com/login");

// Codex device auth: verification page plus a one-time code.
const codex = parseProviderLoginProgress(
  [
    "Welcome to Codex [v0.165.0]",
    "",
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "",
    "1. Open this link in your browser and sign in to your account",
    "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
    "",
    "2. Enter this one-time code (expires in 15 minutes)",
    "   \u001b[94mBQ7X-4KLM9\u001b[0m",
    "",
  ].join("\r\n"),
);
assert.equal(codex.url, "https://auth.openai.com/codex/device");
assert.equal(codex.deviceCode, "BQ7X-4KLM9");
assert.equal(codex.acceptsCode, false);

// Inline code with context on the same line.
const inline = parseProviderLoginProgress(
  "Go to https://example.com/activate and enter code: WXYZ-1234.\n",
);
assert.equal(inline.url, "https://example.com/activate");
assert.equal(inline.deviceCode, "WXYZ-1234");

// Trailing punctuation is not part of a URL.
assert.equal(
  parseProviderLoginProgress("Open https://kimi.com/device.\n").url,
  "https://kimi.com/device",
);

// Nothing printed yet.
assert.deepEqual(parseProviderLoginProgress(""), {
  url: undefined,
  deviceCode: undefined,
  acceptsCode: false,
});

console.log("provider login progress checks passed");
