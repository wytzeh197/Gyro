type Bounds = { x: number; y: number; width: number; height: number };
type HostCommand = (command: string, args: Record<string, unknown>) => Promise<unknown>;

// Native webviews outlive React panels. Serialize updates per browser so a
// pending resize cannot show a child again after its host has unmounted.
export function createBrowserHostVisibility(invoke: HostCommand) {
  const pending = new Map<string, Promise<void>>();
  const revisions = new Map<string, number>();
  return (sessionId: string, bounds: Bounds | null): Promise<void> => {
    const revision = (revisions.get(sessionId) ?? 0) + 1;
    revisions.set(sessionId, revision);
    const update = (pending.get(sessionId) ?? Promise.resolve()).then(async () => {
      if (revisions.get(sessionId) !== revision) return;
      if (bounds) {
        await invoke("session_browser_set_bounds", { sessionId, bounds });
        if (revisions.get(sessionId) !== revision) return;
      }
      await invoke("session_browser_set_visible", { sessionId, visible: bounds !== null });
    }).catch(() => {
      // The first host report can arrive before navigation creates the child.
    });
    pending.set(sessionId, update);
    void update.then(() => {
      if (pending.get(sessionId) === update) pending.delete(sessionId);
    });
    return update;
  };
}
