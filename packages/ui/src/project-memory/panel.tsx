import { MemoryEditor, type MemoryEditorState } from "./editor";
import { MemoryEntryDetail } from "./entry";
import { MemoryContextReceipts } from "./receipts";
import { ProjectMemorySettings } from "./settings";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, RefreshCw } from "lucide-react";
import type {
  MemoryDraft,
  MemoryEntry,
  MemoryReceipt,
  MemoryCandidate,
  MemorySnapshot,
  ProjectMemoryRuntime,
} from "./types";

const emptyDraft = (): MemoryDraft => ({
  text: "",
  kind: "note",
  paths: [],
  sources: [{ kind: "user-entered" }],
});

/** Root header → toolbar → entries/detail → provenance/receipts → controls.
 * The existing companion owns width, focus, tabs, close and overlay behavior. */
export function ProjectMemoryPanel({
  runtime,
}: {
  runtime?: ProjectMemoryRuntime;
}) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [rootId, setRootId] = useState<string>();
  const [query, setQuery] = useState("");
  const [receipts, setReceipts] = useState<MemoryReceipt[]>([]);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [tab, setTab] = useState<"entries" | "used" | "suggestions">("entries");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<MemoryEntry>();
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [editor, setEditor] = useState<MemoryEditorState>();
  const [forgetting, setForgetting] = useState(false);
  const generation = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const currentIdentity = useRef(runtime?.key);
  currentIdentity.current = runtime?.key;
  const panel = useRef<HTMLElement>(null);
  const restoreFocus = () =>
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
      else panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const refresh = useCallback(
    async (offset = 0) => {
      if (!runtime) return;
      const revision = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const [next, used, suggestions] = await Promise.all([
          runtime.list(rootId, query, offset),
          runtime.receipts(),
          runtime.candidates(rootId),
        ]);
        if (revision !== generation.current || !mounted.current) return;
        setSnapshot((current) =>
          offset && current?.rootId === next.rootId
            ? { ...next, entries: [...current.entries, ...next.entries] }
            : next,
        );
        setReceipts(used);
        setCandidates(suggestions);
      } catch (reason) {
        if (revision === generation.current && mounted.current)
          setError(String(reason));
      } finally {
        if (revision === generation.current && mounted.current)
          setLoading(false);
      }
    },
    [runtime, rootId, query],
  );
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void refresh();
      },
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [refresh, query]);
  useEffect(() => runtime?.subscribe(() => void refresh()), [runtime, refresh]);
  useEffect(() => {
    setSnapshot(undefined);
    setSelected(undefined);
    setEditor(undefined);
    setRootId(undefined);
    setQuery("");
    setNotice("");
    setSaving(false);
    setForgetting(false);
  }, [runtime?.key]);
  useEffect(() => {
    if (editor) textInput.current?.focus();
  }, [Boolean(editor)]);
  const back = () => {
    setEditor(undefined);
    setSelected(undefined);
    setForgetting(false);
    setError("");
    restoreFocus();
  };
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (saving) return;
    const identity = runtime?.key,
      root = snapshot?.rootId;
    setSaving(true);
    setError("");
    try {
      await action();
      if (
        !mounted.current ||
        identity !== currentIdentity.current ||
        root !== snapshot?.rootId
      )
        return;
      setNotice(message);
      setEditor(undefined);
      setSelected(undefined);
      setForgetting(false);
      await refresh();
      restoreFocus();
    } catch (reason) {
      if (mounted.current && identity === currentIdentity.current)
        setError(String(reason));
    } finally {
      if (mounted.current && identity === currentIdentity.current)
        setSaving(false);
    }
  };
  const edit = (entry?: MemoryEntry) => {
    opener.current = document.activeElement as HTMLElement;
    setEditor({
      id: entry?.id,
      expectedHash: entry ? selectedHash : (snapshot?.documentHash ?? null),
      draft: entry
        ? {
            text: entry.text,
            kind: entry.kind,
            paths: entry.paths,
            sources: entry.sources.length
              ? entry.sources
              : [{ kind: "user-entered" }],
            supersedes: entry.supersedes,
          }
        : emptyDraft(),
    });
    setForgetting(false);
    setError("");
  };
  if (!runtime)
    return (
      <div className="gyro-memory-panel">
        <p className="gyro-memory-empty">
          Start a chat in a project to use project memory.
        </p>
      </div>
    );
  const selectedRoot = snapshot?.roots.find(
    (root) => root.id === snapshot.rootId,
  );
  return (
    <section
      ref={panel}
      className="gyro-memory-panel"
      aria-label="Project memory"
      onKeyDown={(event) => {
        if (event.key === "Escape" && editor) {
          event.preventDefault();
          event.stopPropagation();
          setNotice("Save or discard your edits before closing the editor.");
        }
      }}
    >
      <header className="gyro-memory-root">
        <label>
          Project
          <select
            aria-label="Memory project root"
            title={
              editor
                ? "Save or discard edits before switching projects"
                : undefined
            }
            value={snapshot?.rootId ?? ""}
            disabled={Boolean(editor) || saving}
            onChange={(event) => {
              setRootId(event.target.value);
              setSelected(undefined);
              setNotice("");
            }}
          >
            {snapshot?.roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.path.split("/").filter(Boolean).at(-1) || root.path}
              </option>
            ))}
          </select>
        </label>
        <button
          className="gyro-icon-button"
          aria-label="Refresh project memory"
          disabled={loading || saving}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {!editor && !selected ? (
        <header>
          <h3>Project memory</h3>
          <p className="gyro-memory-hint">
            Notes Gyro can use in future chats about this project.
          </p>
        </header>
      ) : null}
      {editor ? (
        <MemoryEditor
          editor={editor}
          setEditor={setEditor}
          saving={saving}
          textInput={textInput}
          onSave={() => {
            if (!snapshot) return;
            const draft = {
              ...editor.draft,
              paths: editor.draft.paths
                .map((path) => path.trim())
                .filter(Boolean),
            };
            void run(
              () =>
                editor.candidate
                  ? runtime.accept(
                      snapshot.rootId,
                      editor.expectedHash,
                      editor.candidate,
                      draft,
                    )
                  : runtime.save(
                      snapshot.rootId,
                      editor.expectedHash,
                      draft,
                      editor.id,
                    ),
              "Memory saved",
            );
          }}
          onDiscard={back}
        />
      ) : selected ? (
        <MemoryEntryDetail
          selected={selected}
          back={back}
          edit={edit}
          saving={saving}
          forgetting={forgetting}
          setForgetting={setForgetting}
          onForget={() =>
            void run(
              () => runtime.forget(snapshot!.rootId, selectedHash, selected.id),
              "Memory forgotten",
            )
          }
        />
      ) : (
        <>
          <div
            className="gyro-memory-tabs"
            role="group"
            aria-label="Memory view"
          >
            <button
              aria-pressed={tab === "entries"}
              onClick={() => setTab("entries")}
            >
              Saved notes
            </button>
            <button
              aria-pressed={tab === "suggestions"}
              onClick={() => setTab("suggestions")}
            >
              Suggestions
              {candidates.filter(
                (candidate) =>
                  candidate.status === "pending" ||
                  candidate.status === "accepting",
              ).length
                ? ` (${candidates.filter((candidate) => candidate.status === "pending" || candidate.status === "accepting").length})`
                : ""}
            </button>
            <button
              aria-pressed={tab === "used"}
              onClick={() => setTab("used")}
            >
              Used this turn
            </button>
          </div>
          {tab === "entries" ? (
            <>
              <div className="gyro-memory-toolbar">
                <label>
                  <Search size={14} />
                  <input
                    aria-label="Search project memory"
                    placeholder="Search memory"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button
                  className="gyro-primary-button"
                  disabled={!snapshot || loading}
                  onClick={() => edit()}
                >
                  <Plus size={14} />
                  Add note
                </button>
              </div>
              <div className="gyro-memory-list" aria-busy={loading}>
                {!snapshot && loading ? (
                  <p className="gyro-memory-empty">Loading project memory…</p>
                ) : !snapshot && error ? (
                  <p className="gyro-memory-empty">
                    Project memory couldn’t be loaded.
                  </p>
                ) : !snapshot?.entries.length ? (
                  <p className="gyro-memory-empty">
                    {query
                      ? "No memory matches this search."
                      : "No project memory yet. Save a decision or convention for future chats."}
                  </p>
                ) : (
                  <ul>
                    {snapshot.entries.map((entry) => (
                      <li key={entry.id}>
                        <button
                          onClick={(event) => {
                            opener.current = event.currentTarget;
                            setSelectedHash(snapshot.documentHash);
                            setSelected(entry);
                          }}
                        >
                          <span>{entry.text}</span>
                          <small>
                            {entry.kind.replace("-", " ")}
                            {entry.status !== "active"
                              ? ` · ${entry.status}`
                              : ""}
                            {entry.sourceChanged
                              ? " · source text changed"
                              : ""}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {snapshot?.nextOffset !== null &&
                snapshot?.nextOffset !== undefined ? (
                  <button
                    className="gyro-secondary-button"
                    disabled={loading}
                    onClick={() => void refresh(snapshot.nextOffset!)}
                  >
                    Load more entries
                  </button>
                ) : null}
              </div>
            </>
          ) : tab === "suggestions" ? (
            <div className="gyro-memory-suggestions">
              {candidates.length ? (
                candidates.map((candidate) => (
                  <div className="gyro-memory-suggestion" key={candidate.id}>
                    <p>
                      {candidate.draft?.text ??
                        (candidate.status === "accepted"
                          ? "Memory saved"
                          : "Suggestion dismissed")}
                    </p>
                    <p className="gyro-memory-hint">
                      {candidate.status === "accepting"
                        ? "Save interrupted · review before continuing"
                        : candidate.status}
                    </p>
                    {candidate.draft ? (
                      <>
                        <details>
                          <summary>Source decision</summary>
                          <blockquote>{candidate.evidenceQuote}</blockquote>
                          <p className="gyro-memory-hint">
                            Completed turn {candidate.sourceTurnId} · this
                            reference stays private.
                          </p>
                        </details>
                        <div className="gyro-memory-actions">
                          <button
                            className="gyro-secondary-button"
                            disabled={saving}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setEditor({
                                candidate,
                                expectedHash: snapshot?.documentHash ?? null,
                                draft: candidate.draft!,
                              });
                            }}
                          >
                            Review suggestion
                          </button>
                          <button
                            className="gyro-secondary-button"
                            disabled={saving}
                            onClick={() =>
                              void run(
                                () =>
                                  runtime.dismiss(snapshot!.rootId, candidate),
                                "Suggestion dismissed",
                              )
                            }
                          >
                            Dismiss
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="gyro-memory-empty">
                  No suggestions yet. Supported turns can suggest a durable
                  decision you explicitly stated, without another model call.
                </p>
              )}
            </div>
          ) : (
            <MemoryContextReceipts receipts={receipts} snapshot={snapshot} />
          )}
          {snapshot ? (
            <ProjectMemorySettings
              snapshot={snapshot}
              runtime={runtime}
              run={run}
              saving={saving}
              selectedRoot={selectedRoot}
            />
          ) : null}
        </>
      )}
      {snapshot?.diagnostics.length ? (
        <details className="gyro-memory-diagnostics">
          <summary>
            {snapshot.diagnostics.length} document{" "}
            {snapshot.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}
          </summary>
          <ul>
            {snapshot.diagnostics.map((diagnostic, index) => (
              <li key={index}>
                Line {diagnostic.line}: {diagnostic.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? (
        <div className="gyro-memory-error" role="alert">
          <p>{error}</p>
          <button
            className="gyro-secondary-button"
            onClick={() => void refresh()}
          >
            Reload memory
          </button>
          {editor ? (
            <p>
              Your draft is preserved. Review the current entry before saving
              again.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="gyro-memory-status" role="status" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}
