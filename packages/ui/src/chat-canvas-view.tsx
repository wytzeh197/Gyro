import { useState } from "react";
import { ChatArtifactContent } from "./chat-artifacts";
import type { CanvasArtifact } from "./chat-canvas";

export type CanvasDrafts = Record<
  string,
  { content: string; original: string }
>;

export function ChatCanvas({
  artifacts,
  selectedId,
  onSelect,
  onSendPrompt,
  drafts,
  setDrafts,
}: {
  artifacts: CanvasArtifact[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onSendPrompt: (prompt: string) => void;
  drafts: CanvasDrafts;
  setDrafts: (update: (current: CanvasDrafts) => CanvasDrafts) => void;
}) {
  const [request, setRequest] = useState("");
  const [copied, setCopied] = useState(false);
  const artifact =
    artifacts.find((item) => item.id === selectedId) ?? artifacts.at(-1);
  const draft = artifact ? drafts[artifact.id] : undefined;
  const content =
    artifact?.kind === "canvas"
      ? (draft?.content ?? artifact.content)
      : undefined;
  const changed =
    artifact?.kind === "canvas" && draft && draft.content !== artifact.content;
  return (
    <section className="gyro-canvas" aria-label="Canvas">
      {!artifact ? (
        <div className="gyro-thread-empty">
          <strong>A place to work beside chat</strong>
          <p>
            Ask for a document, code draft, table, or diagram in Canvas.
            Interactive apps open in Browser.
          </p>
        </div>
      ) : (
        <>
          <header className="gyro-canvas-toolbar">
            <select
              aria-label="Canvas item"
              value={artifact.id}
              onChange={(event) => {
                onSelect(event.target.value);
                setCopied(false);
              }}
            >
              {artifacts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
            {content !== undefined ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(content);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            ) : null}
          </header>
          {changed ? (
            <div className="gyro-canvas-draft-status">
              <span>
                {draft.original !==
                (artifact.kind === "canvas" ? artifact.content : "")
                  ? "The model updated this item. Your draft is preserved."
                  : "Local draft"}
              </span>
              <button
                type="button"
                onClick={() =>
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[artifact.id];
                    return next;
                  })
                }
              >
                Use model version
              </button>
            </div>
          ) : null}
          <div className="gyro-canvas-body">
            {artifact.kind === "canvas" ? (
              <textarea
                aria-label={`${artifact.title} content`}
                className={`gyro-canvas-editor is-${artifact.format}`}
                spellCheck={artifact.format !== "code"}
                value={content}
                onChange={(event) => {
                  const value = event.target.value;
                  setCopied(false);
                  setDrafts((current) => ({
                    ...current,
                    [artifact.id]: {
                      content: value,
                      original:
                        current[artifact.id]?.original ?? artifact.content,
                    },
                  }));
                }}
              />
            ) : (
              <ChatArtifactContent artifact={artifact} />
            )}
          </div>
          <form
            className="gyro-canvas-request"
            onSubmit={(event) => {
              event.preventDefault();
              if (!request.trim() && !changed) return;
              onSendPrompt(
                `Update Canvas item ${JSON.stringify(artifact.id)} (${artifact.title}), keeping its id. ${request.trim() || "Use my edited draft."}${changed ? `\n\nMy edited draft:\n${content}` : ""}`,
              );
              setRequest("");
            }}
          >
            <input
              aria-label="Request canvas changes"
              placeholder="Describe a change…"
              value={request}
              onChange={(event) => setRequest(event.target.value)}
            />
            <button disabled={!request.trim() && !changed} type="submit">
              Send to chat
            </button>
          </form>
        </>
      )}
    </section>
  );
}
