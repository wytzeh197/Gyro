import { useState, type ReactNode } from "react";
import type { ProviderId } from "./types";

export type ComposerReviewer = {
  providerId: ProviderId;
  modelId: string;
  label: string;
};
export const secondOpinionCommand = "/second-opinion";

type CommandRange = { start: number; end: number; reviewer?: ComposerReviewer };

type DecoratedDraft = {
  key: string;
  display: string;
  plain: string;
  commands: CommandRange[];
};

// Preserve selected commands across ordinary edits on either side. Editing
// inside a command turns the remaining characters back into ordinary text.
function draftEdit(previous: DecoratedDraft, next: string) {
  const old = previous.display;
  let start = 0;
  while (
    start < old.length &&
    start < next.length &&
    old[start] === next[start]
  )
    start++;
  let end = old.length;
  const delta = next.length - old.length;
  while (
    end > start &&
    end + delta > start &&
    old[end - 1] === next[end + delta - 1]
  )
    end--;
  return { start, end, delta };
}

function moveCommands(previous: DecoratedDraft, next: string) {
  const { start, end, delta } = draftEdit(previous, next);
  return previous.commands
    .flatMap((range) => {
      if (range.end <= start) return [range];
      if (range.start >= end)
        return [
          { ...range, start: range.start + delta, end: range.end + delta },
        ];
      return [];
    })
    .filter(
      ({ start, end }) =>
        (!start || /\s/.test(next[start - 1]!)) &&
        (end === next.length || /\s/.test(next[end]!)),
    );
}

// Reserve space for the provider mark and disclosure in the mirrored textarea.
function reviewerToken(reviewer: ComposerReviewer) {
  return (
    secondOpinionCommand +
    " \u2003\u00a0" +
    reviewer.label.replace(/ /g, "\u00a0") +
    "\u00a0\u2003"
  );
}

export function useInlineCommandDraft(
  plain: string,
  changePlain: (value: string, reviewer?: ComposerReviewer) => void,
  key: string,
  restoredReviewer?: ComposerReviewer,
) {
  const [saved, setSaved] = useState<DecoratedDraft>();
  let current = saved?.key === key && saved.plain === plain ? saved : undefined;
  if (saved && !current) setSaved(undefined);
  if (!current && restoredReviewer) {
    const prefix = plain && !/\s$/.test(plain) ? plain + " " : plain;
    const text = reviewerToken(restoredReviewer);
    current = {
      key,
      plain,
      display: prefix + text + " ",
      commands: [
        {
          start: prefix.length,
          end: prefix.length + text.length,
          reviewer: restoredReviewer,
        },
      ],
    };
  }

  function change(display: string, selected?: CommandRange) {
    let preserved = current ? moveCommands(current, display) : [];
    // A reviewer and its delimiters are one token. Editing through either
    // boundary must not leak part of the command or model name into the prompt.
    if (current && !selected) {
      const removed = current.commands.find(
        (range) =>
          range.reviewer &&
          !preserved.some((candidate) => candidate.reviewer === range.reviewer),
      );
      if (removed) {
        const edit = draftEdit(current, display);
        display =
          current.display.slice(0, Math.min(removed.start, edit.start)) +
          display.slice(edit.start, edit.end + edit.delta) +
          current.display.slice(Math.max(removed.end, edit.end));
        preserved = moveCommands(current, display);
      }
    }
    const commands = preserved.filter(
      (range) =>
        !selected || range.end <= selected.start || range.start >= selected.end,
    );

    if (selected) commands.push(selected);
    commands.sort((a, b) => a.start - b.start);
    // Actions run on selection. Only the user's prose is submitted or saved
    // as a goal, even when several commands were used in one message.
    let message = "";
    let offset = 0;
    for (const { start, end } of commands) {
      message += display.slice(offset, start);
      offset = end;
      if (display[offset] === " ") offset++;
    }
    message += display.slice(offset);
    setSaved(
      commands.length ? { key, plain: message, display, commands } : undefined,
    );
    changePlain(message, commands.find((range) => range.reviewer)?.reviewer);
  }

  const reviewCommand = current?.commands.find(
    (range) =>
      range.reviewer ||
      current!.display.slice(range.start, range.end) === secondOpinionCommand,
  );
  function chooseReviewer(reviewer: ComposerReviewer) {
    if (!current || !reviewCommand) return;
    const { start, end } = reviewCommand;
    const text = reviewerToken(reviewer);
    change(
      current.display.slice(0, start) + text + current.display.slice(end),
      { start, end: start + text.length, reviewer },
    );
  }
  function removeReviewer() {
    if (!current || !reviewCommand) return;
    change(
      current.display.slice(0, reviewCommand.start) +
        current.display.slice(reviewCommand.end).replace(/^ /, ""),
    );
  }
  return {
    reviewCommand,
    chooseReviewer,
    removeReviewer,
    display: current?.display ?? plain,
    commands: current?.commands ?? [],
    change,
  };
}

export type InlineCommandDraft = ReturnType<typeof useInlineCommandDraft>;

export function InlineCommandText({
  display,
  commands,
  renderReviewer,
}: InlineCommandDraft & {
  renderReviewer?: (reviewer: ComposerReviewer) => ReactNode;
}) {
  let offset = 0;
  const parts = commands.map(({ start, end, reviewer }) => {
    const before = display.slice(offset, start);
    const token = reviewer ? secondOpinionCommand : display.slice(start, end);
    offset = end;
    return (
      <span key={start}>
        <span aria-hidden="true">{before}</span>
        <span aria-hidden="true" className="gyro-inline-command">
          {token}
          <svg aria-hidden="true" width="100%" height="100%">
            <text
              x="0"
              y="50%"
              dy=".34em"
              textLength="100%"
              lengthAdjust="spacingAndGlyphs"
            >
              {token}
            </text>
          </svg>
        </span>
        {reviewer && (
          <>
            {" "}
            <span className="gyro-inline-reviewer-space">
              <span aria-hidden="true">
                {display.slice(start + token.length + 1, end)}
              </span>
              {renderReviewer?.(reviewer)}
            </span>
          </>
        )}
      </span>
    );
  });
  return (
    <>
      {parts}
      <span aria-hidden="true">
        {display.slice(offset)}
        {"\u200b"}
      </span>
    </>
  );
}
