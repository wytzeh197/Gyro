type Position = {
  top: number;
  height: number;
  following: boolean;
  firstId?: string;
};

/** Bounded, process-local reading positions; no transcript text or disk writes. */
export function createChatScrollMemory(limit = 64) {
  const capacity = Number.isFinite(limit)
    ? Math.max(1, Math.min(128, Math.floor(limit)))
    : 64;
  const positions = new Map<string, Position>();
  return {
    save(sessionId: string | undefined, position: Position) {
      if (!sessionId) return;
      positions.delete(sessionId);
      positions.set(sessionId, { ...position });
      while (positions.size > capacity)
        positions.delete(positions.keys().next().value!);
    },
    restore(sessionId: string | undefined, ids: string[], height: number) {
      const saved = sessionId ? positions.get(sessionId) : undefined;
      if (!saved || saved.following) return undefined;
      const first = ids[0];
      // A pruned read cannot restore a position in history it no longer has.
      if (saved.firstId && !ids.includes(saved.firstId)) return undefined;
      return Math.max(
        0,
        saved.top + (first !== saved.firstId ? height - saved.height : 0),
      );
    },
    clear() {
      positions.clear();
    },
  };
}

export const chatScrollMemory = createChatScrollMemory();
