/** Publish completed roots in workspace order, retaining successful roots on failure. */
export async function runWorkspaceSearchRoots<T>(
  roots: string[],
  search: (root: string) => Promise<T[]>,
  publish: (results: T[]) => void,
  isCurrent: () => boolean,
  maxResults: number,
): Promise<void> {
  const completed = new Map<string, T[]>();
  const outcomes = await Promise.allSettled(
    roots.map(async (root) => {
      if (!isCurrent()) return;
      const results = await search(root);
      if (!isCurrent()) return;
      completed.set(root, results);
      publish(
        roots.flatMap((path) => completed.get(path) ?? []).slice(0, maxResults),
      );
    }),
  );
  if (!isCurrent()) return;
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [new Error(`${roots[index]}: ${String(outcome.reason)}`)]
      : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      `Search incomplete: ${failures.map((failure) => failure.message).join("; ")}`,
    );
}
