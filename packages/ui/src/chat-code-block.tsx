import { Fragment, useEffect, useState, type ReactNode } from "react";
import { WrapText } from "./icons";
import { IconButton } from "./primitives";
import type { CodeToken } from "./theme/highlight-code";

const syntaxColors: Record<NonNullable<CodeToken["role"]>, string> = {
  keyword: "var(--gyro-code-keyword, var(--gyro-accent))",
  string: "var(--gyro-code-string, var(--gyro-success))",
  number: "var(--gyro-code-number, var(--gyro-attention))",
  symbol: "var(--gyro-code-symbol, var(--gyro-secondary-accent))",
  comment: "var(--gyro-text-secondary)",
  added: "var(--gyro-diff-added, var(--gyro-success))",
  removed: "var(--gyro-diff-removed, var(--gyro-danger))",
};

export function ChatCodeBlock({
  code,
  language,
  copyAction,
}: {
  code: string;
  language?: string;
  copyAction: ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    lines: CodeToken[][];
  }>();
  useEffect(() => {
    // Keep streaming replies and large pasted files responsive.
    if (!language || code.length > 16_384 || !code.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void import("./theme/highlight-code")
        .then(({ highlightCode }) => highlightCode(code, language))
        .then((lines) => {
          if (!cancelled && lines) setHighlighted({ code, language, lines });
        })
        .catch(() => {
          // Plain text remains readable when a grammar or the engine cannot load.
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, language]);
  const lines =
    highlighted &&
    highlighted.code === code &&
    highlighted.language === language
      ? highlighted.lines
      : undefined;
  return (
    <div className="gyro-response-code">
      <div className="gyro-response-code-heading">
        <span>{language || "Code"}</span>
        <div className="gyro-response-code-actions">
          <IconButton
            label="Wrap code"
            aria-pressed={wrap}
            size="xs"
            variant="chrome"
            onClick={() => setWrap(!wrap)}
          >
            <WrapText aria-hidden="true" size={14} />
          </IconButton>
          {copyAction}
        </div>
      </div>
      <pre
        className="gyro-response-code-block"
        data-wrap={wrap}
        tabIndex={0}
        aria-label={language ? language + " code" : "Code block"}
      >
        <code>
          {lines
            ? lines.map((line, index) => (
                <Fragment key={index}>
                  {index > 0 ? "\n" : null}
                  {line.map((token, tokenIndex) =>
                    token.role ? (
                      <span
                        key={tokenIndex}
                        data-code-role={token.role}
                        style={{ color: syntaxColors[token.role] }}
                      >
                        {token.content}
                      </span>
                    ) : (
                      <Fragment key={tokenIndex}>{token.content}</Fragment>
                    ),
                  )}
                </Fragment>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
