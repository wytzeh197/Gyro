// Chat blocks and their existing component aliases. Shared primitives such as
// provider logos and file identities remain owned by the product foundation.
export const chatSelectorPattern =
  /\.gyro-(?:chat-|composer-|message|user-message-|response|run|change-|send-button|context-summary-|environment-|thread-|dictation-|model-chip|model-focus-|effort-chip|use-again|copy-user-message|question-|task-suggestion|code-mode-|side-chat|transcript-|canvas(?:-|\b)|subagents?\b|subagent-|plan-card)|\[data-chat-/;
export const chatComponentStyles = new Set([
  "chat-file-card.css",
  "chat-question-popup.css",
  "chat-task-suggestions.css",
  "chat-canvas.css",
  "chat-recovery.css",
  "chat-run-minimal.css",
  "plan-mode.css",
  "subagents.css",
  "code-mode.css",
]);

// Last compound selector, respecting functional pseudos and attribute strings.
// Ancestor classes must not turn a child control into its parent's design role.
export function chatSelectorSubject(selector) {
  let depth = 0,
    quote = "",
    start = 0;
  for (let i = 0; i < selector.length; i++) {
    const character = selector[i];
    if (quote) {
      if (character === quote && selector[i - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[") depth++;
    if (character === ")" || character === "]") depth--;
    if (!depth && /[\s>+~]/.test(character)) start = i + 1;
  }
  return selector.slice(start);
}
