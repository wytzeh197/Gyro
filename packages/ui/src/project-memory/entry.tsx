import { Button } from "../primitives/button";
import { ArrowLeft, Trash2 } from "../icons";
import type { MemoryEntry } from "./types";
export function MemoryEntryDetail({
  selected,
  back,
  edit,
  saving,
  forgetting,
  setForgetting,
  onForget,
}: {
  selected: MemoryEntry;
  back: () => void;
  edit: (entry: MemoryEntry) => void;
  saving: boolean;
  forgetting: boolean;
  setForgetting: (value: boolean) => void;
  onForget: () => void;
}) {
  return (
    <div className="gyro-memory-detail">
      <Button
        variant="outline"
        leading={<ArrowLeft size={14} aria-hidden="true" />}
        onClick={back}
      >
        All entries
      </Button>
      <p className="gyro-memory-entry-text">{selected.text}</p>
      <p className="gyro-memory-hint">
        {selected.kind.replace("-", " ")}
        {selected.date ? ` · ${selected.date}` : " · Date unavailable"}
        {selected.status !== "active" ? ` · ${selected.status}` : ""}
        {selected.sourceChanged ? " · Source text changed" : ""}
      </p>
      {selected.paths.length > 0 ? (
        <p className="gyro-memory-paths">{selected.paths.join(", ")}</p>
      ) : null}
      <details>
        <summary>Provenance</summary>
        {selected.sources.length ? (
          <ul>
            {selected.sources.map((source, index) => (
              <li key={index}>
                {source.kind === "user-entered"
                  ? "Entered by you"
                  : source.kind === "project-file"
                    ? `${source.path}${source.lines ? `:${source.lines.join("–")}` : ""} · captured file reference`
                    : `Commit ${source.oid}${source.path ? ` · ${source.path}` : ""}`}
              </li>
            ))}
          </ul>
        ) : (
          <p>Source provenance is unavailable for this legacy entry.</p>
        )}
      </details>
      {selected.status === "invalid" ? (
        <p>
          Resolve the metadata diagnostic in .gyro/memory.md before editing this
          entry.
        </p>
      ) : (
        <div className="gyro-memory-actions">
          <Button
            variant="outline"
            onClick={() => edit(selected)}
          >
            Edit memory
          </Button>
          <Button
            variant="outline"
            leading={<Trash2 size={14} aria-hidden="true" />}
            onClick={() => setForgetting(true)}
          >
            Forget
          </Button>
        </div>
      )}
      {forgetting ? (
        <div
          className="gyro-memory-confirm"
          role="group"
          aria-label="Forget memory confirmation"
        >
          <p>
            Remove this entry from future retrieval? Earlier chats, provider
            context, and saved review inputs have separate deletion controls.
          </p>
          <div className="gyro-memory-actions">
            <Button
              variant="destructive"
              disabled={saving}
              onClick={onForget}
            >
              Forget memory
            </Button>
            <Button
              variant="outline"
              onClick={() => setForgetting(false)}
            >
              Keep memory
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
