import { FileText, ShieldCheck } from "../../../../packages/ui/node_modules/lucide-react";
import { SettingsStatus } from "../../../../packages/ui/src/settings-presentation";
import type { Snapshot } from "./types";

type Approval = Snapshot["approvals"][number];
type Mutation = Snapshot["mutations"][number];
type Decide = (decision: "approve" | "reject") => void;

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

/** A host command waiting for approval, shown just above the composer. */
export function CommandApprovalCard({
  approval,
  host,
  branch,
  canDecide,
  primary,
  onDecide,
}: {
  approval: Approval;
  host: string;
  branch?: string;
  canDecide: boolean;
  primary: boolean;
  onDecide: Decide;
}) {
  const payload = approval.payload ?? undefined;
  const command = text(payload?.command);
  const cwd = text(payload?.cwd);
  const reason = text(payload?.reason) ?? text(payload?.details);
  const title = command
    ? `Run a command on ${host}`
    : `${text(payload?.providerLabel) ?? "The agent"} needs permission on ${host}`;
  return (
    <section className="gyro-remote-approval" aria-label={title}>
      <div className="gyro-remote-actions">
        <strong>{title}</strong>
        <span className="gyro-remote-spacer" />
        <SettingsStatus status="warning">Needs approval</SettingsStatus>
      </div>
      {reason && <p>{reason}</p>}
      {command && <pre className="gyro-remote-code">{command}</pre>}
      {(cwd || branch) && (
        <span className="gyro-remote-meta">
          {cwd && <>in {cwd}</>}
          {cwd && branch && " · "}
          {branch && <>worktree {branch}</>}
        </span>
      )}
      {!payload && (
        <p>Request details aren't available here. Review it on {host}.</p>
      )}
      <div className="gyro-remote-actions is-end">
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={!canDecide}
          onClick={() => onDecide("reject")}
        >
          Reject
        </button>
        <button
          type="button"
          className={primary ? "gyro-primary-button" : "gyro-secondary-button"}
          disabled={!canDecide || !payload}
          title={payload ? undefined : `Review on ${host}`}
          onClick={() => onDecide("approve")}
        >
          <ShieldCheck size={14} aria-hidden /> Approve once
        </button>
      </div>
    </section>
  );
}

type DiffLine = { kind: "add" | "del" | "same"; text: string };
// Quadratic line diff; past this many cells the panel shows the proposed
// file instead of a diff so a large edit can't stall the window.
const DIFF_LIMIT = 250_000;

function diffLines(before: string, after: string): DiffLine[] | undefined {
  // A final newline would show up as a blank trailing line.
  const a = before.replace(/\n$/, "").split("\n"),
    b = after.replace(/\n$/, "").split("\n");
  if (a.length * b.length > DIFF_LIMIT) return undefined;
  // lcs[i * width + j] = longest common run of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const lines: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || at(i, j + 1) >= at(i + 1, j))) {
      lines.push({ kind: "add", text: b[j] ?? "" });
      j++;
    } else {
      lines.push({ kind: "del", text: a[i] ?? "" });
      i++;
    }
  }
  return lines;
}

function MutationBody({ mutation }: { mutation: Mutation }) {
  const after = mutation.afterContent ?? mutation.content;
  if (after === undefined)
    return <p>The proposed content isn't available here.</p>;
  const creating =
    mutation.operation === "create" || mutation.baseExists === false;
  const lines: DiffLine[] | undefined = creating
    ? after
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => ({ kind: "add", text: line }))
    : mutation.beforeContent !== undefined
      ? diffLines(mutation.beforeContent, after)
      : undefined;
  return (
    <>
      <span className="gyro-remote-meta">
        {creating ? "New file" : lines ? "Changes" : "Proposed content"}
      </span>
      <pre className="gyro-remote-code gyro-remote-diff">
        {lines
          ? lines.map((line, index) => (
              <span
                key={index}
                className={
                  line.kind === "add"
                    ? "is-add"
                    : line.kind === "del"
                      ? "is-del"
                      : undefined
                }
              >
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                {line.text}
                {"\n"}
              </span>
            ))
          : after}
      </pre>
    </>
  );
}

/** Pending file edits, reviewed in a panel beside the chat. */
export function MutationReviewPanel({
  mutations,
  canDecide,
  primary,
  onDecide,
}: {
  mutations: Mutation[];
  canDecide: boolean;
  primary: boolean;
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  return (
    <aside className="gyro-remote-side is-review" aria-label="Review file edits">
      <div className="gyro-remote-actions">
        <strong>
          Edit {mutations.length} {mutations.length === 1 ? "file" : "files"}
        </strong>
        <span className="gyro-remote-spacer" />
        <SettingsStatus status="warning">Needs approval</SettingsStatus>
      </div>
      {mutations.map((mutation, index) => (
        <section
          key={mutation.id}
          className="gyro-remote-review"
          aria-label={`Edit ${mutation.path ?? "file"}`}
        >
          <strong className="gyro-remote-path">
            <FileText size={14} aria-hidden />
            {mutation.path ?? "Unknown file"}
          </strong>
          <MutationBody mutation={mutation} />
          <div className="gyro-remote-actions is-end">
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={!canDecide}
              onClick={() => onDecide(mutation.id, "reject")}
            >
              Reject
            </button>
            <button
              type="button"
              className={
                primary && index === 0
                  ? "gyro-primary-button"
                  : "gyro-secondary-button"
              }
              disabled={!canDecide}
              onClick={() => onDecide(mutation.id, "approve")}
            >
              Approve edit
            </button>
          </div>
        </section>
      ))}
    </aside>
  );
}
