import type { GitReviewActionId, SourceControlState } from "./types.ts";

/**
 * The two things a chat can do to its repository without leaving the thread.
 *
 * The Environment popover used to be four read-only rows: it told the user the
 * branch had three uncommitted files and then left them to find the Review
 * surface themselves. These rows close that gap. They are deliberately coarse —
 * one row for "move this work forward", one for "publish it" — because a
 * popover that mirrors every git verb is just the Review surface again, badly.
 */
export type EnvironmentActionId = "commit-or-push" | "create-pull-request";

/**
 * What a row does when it is clicked.
 *
 * A commit needs a message, and the message field lives on the Review surface,
 * so a working tree with changes routes there rather than inventing a second
 * place to type one. Everything else runs the same git action the Review
 * surface runs, so the two cannot drift apart in behaviour.
 */
export type EnvironmentActionIntent =
  { kind: "review" } | { kind: "git"; actionId: GitReviewActionId };

export type EnvironmentAction = {
  id: EnvironmentActionId;
  label: string;
  /**
   * Why the row is offered, or why it is not. Never empty: a greyed row with no
   * explanation is the failure this replaces.
   */
  detail: string;
  enabled: boolean;
  /** Present only when the row is enabled. */
  intent?: EnvironmentActionIntent;
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Whether this branch has work the remote has not seen.
 *
 * A branch with no upstream reports `ahead: 0` — git has nothing to count
 * against — so counting alone would read as "nothing to push" at exactly the
 * moment pushing is the point. An unpublished branch is always publishable.
 * This mirrors the readiness rule the Review surface's git actions use, so the
 * popover and the Review strip never disagree about what is possible.
 */
function unpushedWork(sourceControl: SourceControlState) {
  return sourceControl.ahead > 0 || !sourceControl.upstream;
}

function commitOrPush(sourceControl?: SourceControlState): EnvironmentAction {
  const label = "Commit or push";
  if (!sourceControl?.available) {
    return {
      id: "commit-or-push",
      label,
      detail: "No repository here",
      enabled: false,
    };
  }
  const pending = sourceControl.files.length;
  if (pending > 0) {
    return {
      id: "commit-or-push",
      label,
      detail: `${plural(pending, "file")} to commit`,
      enabled: true,
      intent: { kind: "review" },
    };
  }
  if (sourceControl.detached) {
    return {
      id: "commit-or-push",
      label,
      detail: "Check out a branch to push",
      enabled: false,
    };
  }
  // A deleted remote branch reports no ahead count at all, yet pushing is
  // exactly what brings it back.
  if (sourceControl.upstreamGone) {
    return {
      id: "commit-or-push",
      label,
      detail: "Publish this branch again",
      enabled: true,
      intent: { kind: "git", actionId: "push" },
    };
  }
  if (unpushedWork(sourceControl)) {
    return {
      id: "commit-or-push",
      label,
      detail: sourceControl.upstream
        ? `${plural(sourceControl.ahead, "commit")} to push`
        : "Publish this branch",
      enabled: true,
      intent: { kind: "git", actionId: "push" },
    };
  }
  return {
    id: "commit-or-push",
    label,
    detail: "Nothing to commit or push",
    enabled: false,
  };
}

function createPullRequest(
  sourceControl?: SourceControlState,
): EnvironmentAction {
  const label = "Create pull request";
  if (!sourceControl?.available) {
    return {
      id: "create-pull-request",
      label,
      detail: "No repository here",
      enabled: false,
    };
  }
  if (sourceControl.detached) {
    return {
      id: "create-pull-request",
      label,
      detail: "Check out a branch first",
      enabled: false,
    };
  }
  // A pull request compares two refs the remote can see, so an unpublished
  // branch or unpushed commits would open a request that misses the work.
  if (!sourceControl.upstream || sourceControl.upstreamGone) {
    return {
      id: "create-pull-request",
      label,
      detail: "Push the branch first",
      enabled: false,
    };
  }
  if (unpushedWork(sourceControl)) {
    return {
      id: "create-pull-request",
      label,
      detail: `${plural(sourceControl.ahead, "commit")} not pushed yet`,
      enabled: false,
    };
  }
  return {
    id: "create-pull-request",
    label,
    detail: "Open a request for this branch",
    enabled: true,
    intent: { kind: "git", actionId: "open-pr" },
  };
}

/**
 * The action rows for a repository's current state, in the order they are
 * reached: finish the work, then propose it.
 */
export function environmentActions(
  sourceControl?: SourceControlState,
): EnvironmentAction[] {
  return [commitOrPush(sourceControl), createPullRequest(sourceControl)];
}

export type EnvironmentTone = "neutral" | "pending" | "warning";

/** How the branch stands against its upstream, as one short value. */
export type EnvironmentSync = {
  label: string;
  /** The longer explanation for the tooltip and screen readers. */
  detail: string;
  tone: EnvironmentTone;
};

export function environmentSync(
  sourceControl?: SourceControlState,
): EnvironmentSync | undefined {
  if (!sourceControl?.available) return undefined;
  if (sourceControl.detached) {
    return {
      label: "Detached",
      detail: "HEAD is not on a branch, so there is nothing to sync",
      tone: "warning",
    };
  }
  const upstream = sourceControl.upstream;
  if (!upstream) {
    return {
      label: "Not published",
      detail: "This branch has no upstream yet",
      tone: "pending",
    };
  }
  if (sourceControl.upstreamGone) {
    return {
      label: "Remote deleted",
      detail: `${upstream} no longer exists on the remote`,
      tone: "warning",
    };
  }
  const { ahead, behind } = sourceControl;
  if (ahead > 0 && behind > 0) {
    return {
      label: `↑${ahead} ↓${behind}`,
      detail: `Diverged from ${upstream}: ${plural(ahead, "commit")} to push, ${plural(behind, "commit")} to pull`,
      tone: "warning",
    };
  }
  if (ahead > 0) {
    return {
      label: `↑${ahead}`,
      detail: `${plural(ahead, "commit")} ahead of ${upstream}`,
      tone: "pending",
    };
  }
  if (behind > 0) {
    return {
      label: `↓${behind}`,
      detail: `${plural(behind, "commit")} behind ${upstream}`,
      tone: "pending",
    };
  }
  return {
    label: "Up to date",
    detail: `In sync with ${upstream}`,
    tone: "neutral",
  };
}

const operationLabels: Record<
  NonNullable<SourceControlState["operation"]>,
  string
> = {
  rebase: "Rebase",
  merge: "Merge",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  bisect: "Bisect",
};

/**
 * The one thing about the repository that needs attention before anything
 * else, or nothing. Ordered by what blocks the user most: an operation left
 * half-done outranks conflicts it caused, which outrank a stale read.
 */
export function environmentNotice(
  sourceControl?: SourceControlState,
): string | undefined {
  if (!sourceControl) return undefined;
  const conflicts = sourceControl.files.filter(
    (file) => file.state === "conflicted",
  ).length;
  if (sourceControl.operation) {
    const operation = operationLabels[sourceControl.operation];
    return conflicts > 0
      ? `${operation} in progress with ${plural(conflicts, "conflict")}`
      : `${operation} in progress`;
  }
  if (conflicts > 0) return `${plural(conflicts, "conflicted file")}`;
  return sourceControl.error || undefined;
}

/**
 * Shortens a long label from the middle, so a branch keeps both its family
 * (`release/`) and the part that tells it apart from its siblings (`49.3`).
 */
export function middleTruncate(value: string, max: number) {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}
