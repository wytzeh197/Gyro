import type { MemorySnapshot, ProjectMemoryRuntime } from "./types";
export function ProjectMemorySettings({
  snapshot,
  runtime,
  run,
  saving,
  selectedRoot,
}: {
  snapshot: MemorySnapshot;
  runtime: ProjectMemoryRuntime;
  run: (action: () => Promise<unknown>, message: string) => Promise<void>;
  saving: boolean;
  selectedRoot?: { id: string; path: string };
}) {
  return (
    <details className="gyro-memory-settings">
      <summary>Project memory settings</summary>
      <label>
        <input
          type="checkbox"
          checked={snapshot.settings.enabled}
          disabled={saving}
          onChange={(event) =>
            void run(
              () =>
                runtime.settings(snapshot.rootId, {
                  ...snapshot.settings,
                  enabled: event.target.checked,
                }),
              "Memory settings saved",
            )
          }
        />
        Use relevant memory in new turns
      </label>
      <label>
        <input
          type="checkbox"
          checked={snapshot.settings.suggestions}
          disabled={saving || !snapshot.settings.enabled}
          onChange={(event) =>
            void run(
              () =>
                runtime.settings(snapshot.rootId, {
                  ...snapshot.settings,
                  suggestions: event.target.checked,
                }),
              "Memory settings saved",
            )
          }
        />
        Suggest durable user decisions
      </label>
      <label>
        Memory budget
        <select
          aria-label="Memory context budget"
          value={snapshot.settings.maxBytes}
          disabled={saving}
          onChange={(event) =>
            void run(
              () =>
                runtime.settings(snapshot.rootId, {
                  ...snapshot.settings,
                  maxBytes: Number(event.target.value),
                }),
              "Memory budget saved",
            )
          }
        >
          <option value={768}>Compact · about 250 tokens</option>
          <option value={1536}>Balanced · about 500 tokens</option>
          <option value={3072}>More context · about 1,000 tokens</option>
          {![768, 1536, 3072].includes(snapshot.settings.maxBytes) ? (
            <option value={snapshot.settings.maxBytes}>
              Custom · about {Math.ceil(snapshot.settings.maxBytes / 3)} tokens
            </option>
          ) : null}
        </select>
      </label>
      <p className="gyro-memory-hint">
        Local selection · no extra model call · up to{" "}
        {snapshot.settings.maxEntries} entries and {snapshot.settings.maxBytes}{" "}
        bytes. Unchanged memory is reused on confirmed resumes.
      </p>
      <p className="gyro-memory-hint">
        Stored in {selectedRoot?.path.split("/").filter(Boolean).at(-1)}
        /.gyro/memory.md
      </p>
    </details>
  );
}
