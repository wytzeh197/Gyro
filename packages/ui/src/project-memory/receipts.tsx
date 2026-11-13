import type { MemoryReceipt, MemorySnapshot } from "./types";
export function MemoryContextReceipts({
  receipts,
  snapshot,
}: {
  receipts: MemoryReceipt[];
  snapshot?: MemorySnapshot;
}) {
  return (
    <div className="gyro-memory-used">
      {receipts
        .filter(
          (item) =>
            item.receipt.roots.some(
              (root) => root.rootId === snapshot?.rootId,
            ) ||
            (item.receipt.delta && item.receipt.roots.length === 0),
        )
        .slice(0, 10)
        .map((item) => (
          <details key={`${item.turnId}:${item.providerId}`}>
            <summary>
              {(() => {
                const count = item.receipt.suppliedBytes
                  ? item.receipt.roots.reduce(
                      (count, root) => count + root.entries.length,
                      0,
                    )
                  : item.receipt.reusedCount;
                const noun = count === 1 ? "entry" : "entries";
                return item.receipt.suppliedBytes
                  ? `${count} ${noun} · ~${item.receipt.estimatedTokens} tokens`
                  : `${count} ${noun} reused · no added memory text`;
              })()}
            </summary>
            <p>
              Prepared for this turn · {item.providerId}. This records supplied
              context, not whether the model used it.
            </p>
            {item.receipt.roots
              .filter((root) => root.rootId === snapshot?.rootId)
              .flatMap((root) => root.entries)
              .map((entry) => {
                const current = snapshot?.entries.find(
                  (item) =>
                    item.id === entry.id && item.entryHash === entry.entryHash,
                );
                return (
                  <p key={entry.id}>
                    {current?.text ??
                      "Entry changed, forgotten, or unavailable in this view."}
                  </p>
                );
              })}
          </details>
        ))}
      {!receipts.some(
        (item) =>
          item.receipt.roots.some((root) => root.rootId === snapshot?.rootId) ||
          (item.receipt.delta && item.receipt.roots.length === 0),
      ) ? (
        <p className="gyro-memory-empty">
          No memory context receipts for this project in this chat yet.
        </p>
      ) : null}
    </div>
  );
}
