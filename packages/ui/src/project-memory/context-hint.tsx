import type { SessionEvent } from "../types";

/** Content-free native receipts are UI evidence, never provider instructions. */
export function ProjectMemoryContextHint({
  events,
  onOpen,
}: {
  events: SessionEvent[];
  onOpen?: () => void;
}) {
  if (!onOpen) return null;
  for (
    let index = events.length - 1;
    index >= Math.max(0, events.length - 100);
    index--
  ) {
    const payload = events[index]!.payload as
      | {
          kind?: string;
          receipt?: {
            roots?: { entries?: unknown[] }[];
            estimatedTokens?: number;
            suppliedBytes?: number;
            reusedCount?: number;
          };
        }
      | undefined;
    if (payload?.kind !== "project-memory-context") continue;
    const receipt = payload.receipt;
    if (!receipt || !Array.isArray(receipt.roots)) return null;
    const count = receipt.roots.reduce(
      (count, root) =>
        count + (Array.isArray(root.entries) ? root.entries.length : 0),
      0,
    );
    if (count < 1 || count > 8) return null;
    const reused = receipt.suppliedBytes === 0;
    return (
      <button
        className="gyro-memory-context-hint"
        onClick={onOpen}
        title="Inspect the context prepared for this turn. This does not establish that the model used it."
      >
        Project memory · {count}{" "}
        {reused ? "reused" : count === 1 ? "entry" : "entries"}
        {!reused && typeof receipt.estimatedTokens === "number"
          ? ` · ~${receipt.estimatedTokens} tokens`
          : ""}
      </button>
    );
  }
  return null;
}
