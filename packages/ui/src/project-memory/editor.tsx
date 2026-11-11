import type { RefObject } from "react";
import type { MemoryDraft, MemoryCandidate, MemoryKind } from "./types";
export type MemoryEditorState = {
  id?: string;
  expectedHash: string | null;
  draft: MemoryDraft;
  candidate?: MemoryCandidate;
};
const kinds: MemoryKind[] = [
  "decision",
  "convention",
  "command",
  "open-problem",
  "note",
];
export function MemoryEditor({
  editor,
  setEditor,
  saving,
  textInput,
  onSave,
  onDiscard,
}: {
  editor: MemoryEditorState;
  setEditor: (editor: MemoryEditorState) => void;
  saving: boolean;
  textInput: RefObject<HTMLTextAreaElement>;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="gyro-memory-editor">
      <h3>{editor.id ? "Edit memory" : "Add note"}</h3>
      <label>
        What should future chats know?
        <textarea
          ref={textInput}
          value={editor.draft.text}
          maxLength={500}
          rows={6}
          onChange={(event) =>
            setEditor({
              ...editor,
              draft: { ...editor.draft, text: event.target.value },
            })
          }
        />
      </label>
      <details>
        <summary>Options</summary>
        <label>
          Type
          <select
            value={editor.draft.kind}
            onChange={(event) =>
              setEditor({
                ...editor,
                draft: {
                  ...editor.draft,
                  kind: event.target.value as MemoryKind,
                },
              })
            }
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replace("-", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Relevant paths <span>optional, one per line</span>
          <textarea
            rows={2}
            value={editor.draft.paths.join("\n")}
            onChange={(event) =>
              setEditor({
                ...editor,
                draft: {
                  ...editor.draft,
                  paths: event.target.value.split("\n"),
                },
              })
            }
          />
        </label>
      </details>
      <p className="gyro-memory-hint">
        Keep one durable fact. Saved memory may be sent to your chosen provider
        when relevant.
      </p>
      {editor.draft.sources.some((source) => source.kind !== "user-entered") ? (
        <button
          className="gyro-secondary-button"
          onClick={() =>
            setEditor({
              ...editor,
              draft: {
                ...editor.draft,
                sources: [{ kind: "user-entered" }],
              },
            })
          }
        >
          Record this as my correction
        </button>
      ) : null}
      <div className="gyro-memory-actions">
        <button
          className="gyro-primary-button"
          disabled={saving || !editor.draft.text.trim()}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save memory"}
        </button>
        <button
          className="gyro-secondary-button"
          disabled={saving}
          onClick={onDiscard}
        >
          Discard edits
        </button>
      </div>
    </div>
  );
}
