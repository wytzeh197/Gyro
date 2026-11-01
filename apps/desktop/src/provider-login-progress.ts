/**
 * What a provider login CLI has asked of the person signing in so far, read
 * from its terminal output. The popover shows this instead of the raw
 * terminal, so the parse only needs the few facts a person acts on: where to
 * sign in, which code to enter, and whether the CLI will take a pasted code.
 */
export type ProviderLoginProgress = {
  /** The sign-in or device verification page. */
  url?: string;
  /** A one-time code the person types on the verification page. */
  deviceCode?: string;
  /** The CLI is reading a code from its input (OAuth paste-back). */
  acceptsCode: boolean;
};

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const URL_PATTERN = /https:\/\/[^\s<>"'`]+/g;
const URL_CONTINUATION = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
// Terminals are at least this wide, so a shorter line ended on its own.
const MIN_WRAP_WIDTH = 80;
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;
// Device codes are short uppercase groups joined by a dash: ABCD-1234, 7XQ2-9PLM.
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const DEVICE_CODE_CONTEXT = /\b(code|enter|device)\b/i;
const CODE_PROMPT_PATTERN =
  /\b(paste|enter)\b[^\n]*\b(code|token)\b[^\n]*(?:[:>]\s*$|if prompted)/im;

export function stripTerminalControls(output: string) {
  return output.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
}

/**
 * The first sign-in URL, rejoined when a narrow terminal hard-wrapped it.
 * Only a line that filled a terminal row can have wrapped, and wrapped lines
 * carry only URL characters, so a short line or the next sentence ends it.
 */
function firstUrl(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(URL_PATTERN);
    if (!match) continue;
    let url = match[0];
    let wrapped =
      line.length >= MIN_WRAP_WIDTH && line.trimEnd().endsWith(url);
    for (let next = index + 1; wrapped && next < lines.length; next += 1) {
      const candidate = (lines[next] ?? "").trim();
      if (!candidate || !URL_CONTINUATION.test(candidate)) break;
      url += candidate;
      wrapped = (lines[next] ?? "").length >= MIN_WRAP_WIDTH;
    }
    return url.replace(TRAILING_PUNCTUATION, "");
  }
  return undefined;
}

function deviceCode(lines: string[]) {
  for (const rawLine of lines) {
    // OAuth query strings are full of dash-joined tokens; codes never sit in a URL.
    const line = rawLine.replace(URL_PATTERN, " ");
    const match = line.match(DEVICE_CODE_PATTERN);
    if (match && DEVICE_CODE_CONTEXT.test(line)) return match[1];
  }
  // Some CLIs print the code alone on the line after "enter this code".
  for (let index = 1; index < lines.length; index += 1) {
    const code = (lines[index] ?? "").trim();
    if (
      DEVICE_CODE_PATTERN.test(code) &&
      code.length <= 11 &&
      DEVICE_CODE_CONTEXT.test(lines[index - 1] ?? "")
    ) {
      return code;
    }
  }
  return undefined;
}

export function parseProviderLoginProgress(
  output: string,
): ProviderLoginProgress {
  const text = stripTerminalControls(output);
  const lines = text.split("\n");
  return {
    url: firstUrl(lines),
    deviceCode: deviceCode(lines),
    acceptsCode: CODE_PROMPT_PATTERN.test(text),
  };
}
