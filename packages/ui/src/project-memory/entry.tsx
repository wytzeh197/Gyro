import { ArrowLeft, Trash2 } from "lucide-react";
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
      <button className="gyro-secondary-button" onClick={back}>
        <ArrowLeft size={14} />
        All entries
      </button>
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
          <button
            className="gyro-secondary-button"
            onClick={() => edit(selected)}
          >
            Edit memory
          </button>
          <button
            className="gyro-secondary-button"
            onClick={() => setForgetting(true)}
          >
            <Trash2 size={14} />
            Forget
          </button>
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
            <button
              className="gyro-primary-button"
              disabled={saving}
              onClick={onForget}
            >
              Forget memory
            </button>
            <button
              className="gyro-secondary-button"
              onClick={() => setForgetting(false)}
            >
              Keep memory
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
