import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./settings-controls";
import "./cloud-services-settings.css";
import {
  CLOUD_CONTINUATION_MAX_CHARS,
  cloudChatContinuationContext,
  reviewedCloudContinuation,
} from "./cloud-chat-continuation";
import { revealSettingsTarget } from "./settings-disclosure";
import {
  CLOUD_TASKS,
  cloudDeviceId,
  cloudSourceReference,
  contextReview,
  managedTaskAvailability,
  memoryDraftState,
  reportLinkState,
  sourceMessageExcerpt,
  sourceRangeLabel,
  type CloudCapability,
  type CloudPlan,
  type CloudSourceReference,
} from "./cloud-services-state";

type Data = Record<string, unknown>;
type Chat = {
  format: "gyro-portable-chat-v1";
  title: string;
  projectId?: string;
  messages: { role: string; text: string; createdAt: string }[];
};
type ObjectRow = {
  objectId: string;
  kind: string;
  headRevisionId: string | null;
  updatedAt: string;
  pinned?: boolean;
  filename?: string | null;
};
type LocalChat = { localId: string; title: string };
type Source = { objectId: string; revisionId: string };
export type CloudServicesActions = {
  request: (request: Data) => Promise<Data>;
  preferences: () => Data;
  applySettings: (settings: Data) => void;
  continueChat?: (context: string) => Promise<boolean>;
};
const record = (v: unknown): Data =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Data) : {};
const rows = (v: unknown): Data[] => (Array.isArray(v) ? v.map(record) : []);
const id = () => crypto.randomUUID();
type Block = "sync" | "links" | "memory" | "ai" | "devices" | "account";
type Feedback = { error?: string; notice?: string };
const decodedObjectText = (data: Data) => {
  const bytes = Uint8Array.from(atob(String(data.bytesBase64 ?? "")), (char) =>
    char.charCodeAt(0),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};
const rescanIds = (v: unknown) =>
  Array.isArray(v)
    ? v
        .map((value) =>
          typeof value === "string" ? value : String(record(value).objectId),
        )
        .filter((value) => /^[0-9a-f-]{36}$/i.test(value))
    : [];

/** Render the service's link state without treating every non-revoked link as active. */
export function CloudReportLinkRow({
  share,
  accessState,
  busy = false,
  onRevoke,
}: {
  share: Data;
  accessState?: string;
  busy?: boolean;
  onRevoke: () => void;
}) {
  const state = reportLinkState(share, accessState);
  const expiry = Date.parse(String(share.expiresAt ?? ""));
  return (
    <div>
      <SettingsRow
        label="Report link"
        detail={
          Number.isFinite(expiry)
            ? `Expires ${new Date(expiry).toLocaleString()}`
            : "Expiry could not be verified."
        }
        value={state.label}
      />
      <button
        type="button"
        className="gyro-secondary-button"
        disabled={busy || !state.revocable}
        onClick={onRevoke}
      >
        Revoke link
      </button>
    </div>
  );
}

/** A proposal is actionable only after a readable, current draft and its provenance were reviewed. */
export function CloudMemoryDraftCard({
  proposal,
  currentRevision,
  busy = false,
  memoryDirty = false,
  reviewed,
  provenance,
  onRead,
  onReviewedChange,
  onReview,
  onRefreshRequest,
}: {
  proposal: Data;
  currentRevision: number;
  busy?: boolean;
  memoryDirty?: boolean;
  reviewed: boolean;
  provenance: ReactNode;
  onRead: () => void;
  onReviewedChange: (reviewed: boolean) => void;
  onReview: (action: "accept" | "reject") => void;
  onRefreshRequest?: () => void;
}) {
  const state = memoryDraftState(proposal);
  const sources = Array.isArray(proposal.sources) ? proposal.sources : [];
  const validSources =
    sources.length > 0 &&
    sources.every((source) => cloudSourceReference(source));
  const current =
    Number.isSafeInteger(proposal.expectedRevision) &&
    proposal.expectedRevision === currentRevision;
  const canReview =
    state.readable &&
    proposal.loaded === true &&
    validSources &&
    current &&
    !memoryDirty;
  return (
    <details>
      <summary>{state.label}</summary>
      <p>{state.description}</p>
      {typeof proposal.jobStatus === "string" ? (
        <p>Existing request: {proposal.jobStatus}</p>
      ) : null}
      {state.readable ? (
        <>
          <p>
            Based on saved memory revision{" "}
            {String(proposal.expectedRevision ?? "unavailable")} · current saved
            revision {currentRevision}
          </p>
          {!current ? (
            <p role="alert">
              This draft is based on another memory revision. Reload saved
              memory before deciding; existing edits are protected.
            </p>
          ) : null}
          {proposal.loaded ? (
            <pre className="gyro-cloud-read-only-text">
              {String(proposal.content ?? "")}
            </pre>
          ) : (
            <p>Read the complete draft to load its proposed text.</p>
          )}
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={onRead}
          >
            Read draft
          </button>
        </>
      ) : null}
      <h3>Source revisions used for this extraction</h3>
      {provenance}
      {state.readable && proposal.loaded ? (
        <>
          {!validSources ? (
            <p role="alert">
              Complete source references are required before this draft can be
              accepted.
            </p>
          ) : null}
          {memoryDirty ? (
            <p>
              Save or reload your unsaved memory edits before accepting this
              draft.
            </p>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              disabled={busy || !canReview}
              onChange={(event) =>
                onReviewedChange(event.currentTarget.checked)
              }
            />{" "}
            I reviewed this memory draft and its source revisions
          </label>
        </>
      ) : null}
      <div className="gyro-settings-transfer-actions">
        {state.readable ? (
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy || !canReview || !reviewed}
            onClick={() => onReview("accept")}
          >
            Accept reviewed draft
          </button>
        ) : null}
        {onRefreshRequest ? (
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={onRefreshRequest}
          >
            Check existing request & refresh drafts
          </button>
        ) : null}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={
            busy ||
            !["prepared", "conflict", "proposal"].includes(
              String(proposal.status),
            )
          }
          onClick={() => onReview("reject")}
        >
          Reject draft
        </button>
      </div>
      {proposal.status === "prepared" ? (
        <p>
          Rejecting a draft does not cancel an already submitted managed
          request.
        </p>
      ) : null}
    </details>
  );
}

/** Existing Settings blocks; all remote state is read after deliberate actions. */
export function CloudServicesSettings({
  actions,
  limits,
  plan,
  managedAi,
  accessState,
}: {
  actions: CloudServicesActions;
  limits?: { historyDays: number; activeLinks: number };
  plan?: CloudPlan;
  managedAi?: CloudCapability;
  accessState?: string;
}) {
  const [activeBlock, setActiveBlock] = useState<Block>();
  const actionBlock = useRef<Block>();
  const busy = activeBlock !== undefined;
  const [feedback, setFeedback] = useState<Partial<Record<Block, Feedback>>>(
    {},
  );
  const [loaded, setLoaded] = useState({
    sync: false,
    local: false,
    links: false,
    devices: false,
  });
  const [localChats, setLocalChats] = useState<LocalChat[]>([]),
    [selected, setSelected] = useState("");
  const [objects, setObjects] = useState<ObjectRow[]>([]),
    [shares, setShares] = useState<Data[]>([]),
    [devices, setDevices] = useState<Data[]>([]);
  const [preview, setPreview] = useState<Data>(),
    [reviewed, setReviewed] = useState(false),
    [archive, setArchive] = useState<Chat>();
  const [continuationContext, setContinuationContext] = useState("");
  const [readOnlyReport, setReadOnlyReport] = useState<string>();
  const [projectId, setProjectId] = useState(""),
    [memory, setMemory] = useState(""),
    [memoryRevision, setMemoryRevision] = useState(0),
    [sources, setSources] = useState<Source[]>([]),
    [proposals, setProposals] = useState<Data[]>([]);
  const [savedMemory, setSavedMemory] = useState("");
  const [memoryProvenance, setMemoryProvenance] = useState<Data[]>([]);
  const [sourceReader, setSourceReader] = useState<{
    source: CloudSourceReference;
    text: string;
    messages?: Chat["messages"];
  }>();
  const sourceReaderElement = useRef<HTMLElement>(null);
  const sourceReaderTrigger = useRef<HTMLButtonElement>();
  const [jobAmbiguous, setJobAmbiguous] = useState(false);
  const [rescanSources, setRescanSources] = useState<string[]>([]);
  const [rescanReferences, setRescanReferences] = useState<
    CloudSourceReference[]
  >([]);
  const [memoryMorePending, setMemoryMorePending] = useState(false);
  const [memoryRequestPending, setMemoryRequestPending] = useState(false);
  const [task, setTask] = useState("failure-explanation"),
    [context, setContext] = useState(""),
    [job, setJob] = useState<Data>(),
    [jobRequest, setJobRequest] = useState(id);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]),
    [versions, setVersions] = useState<Record<string, Data[]>>({}),
    [reviewedDrafts, setReviewedDrafts] = useState<string[]>([]),
    [automaticMemory, setAutomaticMemory] = useState(false),
    [savedAutomaticMemory, setSavedAutomaticMemory] = useState(false);
  const [savedSourceObjectIds, setSavedSourceObjectIds] = useState<string[]>(
    [],
  );
  const [link, setLink] = useState(""),
    [deleteConfirmation, setDeleteConfirmation] = useState("");
  const service = (command: Data) =>
    actions.request({ operation: "service", command });
  const setNotice = (
    notice: string,
    block: Block = actionBlock.current ?? "sync",
  ) => setFeedback((old) => ({ ...old, [block]: { notice } }));
  const perform = async (block: Block, work: () => Promise<void>) => {
    if (actionBlock.current) return;
    actionBlock.current = block;
    setActiveBlock(block);
    setFeedback((old) => ({ ...old, [block]: {} }));
    try {
      await work();
    } catch (e) {
      setFeedback((old) => ({ ...old, [block]: { error: String(e) } }));
    } finally {
      actionBlock.current = undefined;
      setActiveBlock(undefined);
    }
  };
  const blockFeedback = (block: Block) => (
    <div
      className="gyro-cloud-block-feedback"
      aria-busy={activeBlock === block}
    >
      {activeBlock === block ? <p role="status">Working…</p> : null}
      {feedback[block]?.error ? (
        <p role="alert">{feedback[block]!.error}</p>
      ) : null}
      {feedback[block]?.notice ? (
        <p role="status">{feedback[block]!.notice}</p>
      ) : null}
    </div>
  );
  const loadObjects = async () => {
    const data = await service({ operation: "list-objects", cursor: null });
    setObjects(rows(data.items) as unknown as ObjectRow[]);
    setLoaded((old) => ({ ...old, sync: true }));
  };
  const loadShares = async () => {
    const data = await service({ operation: "list-shares" });
    setShares(rows(data.items ?? data.shares));
    setLoaded((old) => ({ ...old, links: true }));
  };
  const loadDevices = async () => {
    const result = await service({ operation: "devices" });
    setDevices(rows(result.items ?? result.devices));
    setLoaded((old) => ({ ...old, devices: true }));
  };
  const taskAvailability = managedTaskAvailability(
    plan,
    task,
    managedAi,
    accessState,
  );
  const memoryAvailability = managedTaskAvailability(
    plan,
    "memory-update",
    managedAi,
    accessState,
  );
  const managedAvailable = memoryAvailability.allowed;
  const contextFit = contextReview(context, plan);
  const memoryDirty = memory !== savedMemory;
  const sourceExcerpt = sourceReader
    ? sourceMessageExcerpt(
        sourceReader.messages ?? [{ role: "source", text: sourceReader.text }],
        sourceReader.source.messageRange,
      )
    : null;
  const previewContent = record(preview?.content);
  const readObject = async (o: ObjectRow) => {
    if (o.kind === "attachment") {
      const result = await actions.request({
        operation: "download-attachment",
        objectId: o.objectId,
        revisionId: o.headRevisionId,
        filename: o.filename ?? null,
      });
      setNotice(
        result.cancelled
          ? "Download cancelled."
          : "Attachment saved as a separate local file.",
      );
      return;
    }
    const data = await service({
      operation: "read-object",
      objectId: o.objectId,
      revisionId: o.headRevisionId,
    });
    const text = decodedObjectText(data);
    if (o.kind === "report") {
      setReadOnlyReport(text);
      setNotice(
        "Opened this report version read-only. It cannot run a Check or grant permissions.",
      );
      return;
    }
    const content = record(JSON.parse(text));
    if (o.kind === "chat") {
      const saved = await actions.request({
        operation: "save-read-only-archive",
        content,
      });
      const restored = record(saved.content) as unknown as Chat;
      setArchive(restored);
      setContinuationContext(cloudChatContinuationContext(restored));
      setNotice(String(saved.notice));
    } else if (o.kind === "settings") {
      setPreview({ kind: "restore-settings", content });
      setReviewed(false);
    } else
      setNotice(
        "This object is available in the account export. The text reader supports chats and appearance settings.",
      );
  };
  const openMemory = async () => {
    const identity = await actions.request({
      operation: "project-memory-id",
      localId: selected || null,
    });
    await loadMemory(String(identity.projectId));
    revealMemory();
  };
  const revealMemory = () =>
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-settings-disclosure="cloud-project-memory"]',
      );
      revealSettingsTarget(target);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    }, 0);
  const loadMemory = async (project: string) => {
    const data = await service({ operation: "get-memory", projectId: project });
    const pending = await service({
      operation: "list-memory-proposals",
      projectId: project,
    });
    if (project !== projectId) {
      setRescanSources([]);
      setRescanReferences([]);
      setMemoryMorePending(false);
      setSourceReader(undefined);
    }
    setProjectId(project);
    setAutomaticMemory(data.automaticEnabled === true);
    setSavedAutomaticMemory(data.automaticEnabled === true);
    setSelectedObjectIds(
      Array.isArray(data.sourceObjectIds)
        ? data.sourceObjectIds.map(String)
        : [],
    );
    setSavedSourceObjectIds(
      Array.isArray(data.sourceObjectIds)
        ? data.sourceObjectIds.map(String)
        : [],
    );
    setMemory(String(data.content ?? ""));
    setSavedMemory(String(data.content ?? ""));
    setMemoryRevision(Number(data.revision ?? 0));
    setSources(
      rows(data.sources).map((source) => ({
        objectId: String(source.objectId),
        revisionId: String(source.revisionId),
      })),
    );
    setMemoryProvenance(rows(data.sources));
    setReviewedDrafts([]);
    setProposals(rows(pending.items ?? pending.proposals));
    setMemoryRequestPending(
      rows(pending.items ?? pending.proposals).some((item) =>
        ["prepared", "proposal", "conflict"].includes(String(item.status)),
      ),
    );
  };
  const openSource = async (source: CloudSourceReference) => {
    const data = await service({
      operation: "read-object",
      objectId: source.objectId,
      revisionId: source.revisionId,
    });
    const text = decodedObjectText(data);
    let messages: Chat["messages"] | undefined;
    if (
      source.sourceFormat === "gyro-portable-chat-v1" ||
      data.kind === "chat"
    ) {
      const content = record(JSON.parse(text));
      if (
        content.format !== "gyro-portable-chat-v1" ||
        !Array.isArray(content.messages)
      )
        throw new Error(
          "This source is not a supported read-only chat archive.",
        );
      messages = rows(content.messages).map((message) => {
        if (
          !["user", "assistant"].includes(String(message.role)) ||
          typeof message.text !== "string"
        )
          throw new Error("The source messages could not be verified.");
        return {
          role: String(message.role),
          text: message.text,
          createdAt: String(message.createdAt ?? ""),
        };
      });
    }
    setSourceReader({ source, text, messages });
    setNotice(
      "Opened the exact source revision read-only. Local chats and permissions were not changed.",
      "memory",
    );
  };
  const renderSources = (values: unknown) => {
    const references = Array.isArray(values) ? values.slice(0, 200) : [];
    return references.length ? (
      <ol className="gyro-cloud-source-list">
        {references.map((value, index) => {
          const source = cloudSourceReference(value);
          return (
            <li
              key={
                source
                  ? `${source.objectId}:${source.revisionId}:${index}`
                  : index
              }
            >
              {source ? (
                <>
                  <p>
                    <strong>Source {index + 1}</strong> · revision{" "}
                    {source.revisionId.slice(0, 8)}
                  </p>
                  <p>
                    {sourceRangeLabel(source.messageRange)}
                    {source.rescan
                      ? " · explicit rescan of changed content"
                      : ""}
                  </p>
                  <details>
                    <summary>Revision details</summary>
                    <p>
                      Cloud object: <code>{source.objectId}</code>
                    </p>
                    <p>
                      Revision: <code>{source.revisionId}</code>
                    </p>
                    {source.sha256 ? (
                      <p>
                        SHA-256: <code>{source.sha256}</code>
                      </p>
                    ) : null}
                  </details>
                  <button
                    type="button"
                    className="gyro-secondary-button"
                    disabled={busy}
                    onClick={(event) => {
                      sourceReaderTrigger.current = event.currentTarget;
                      void perform("memory", () => openSource(source));
                    }}
                  >
                    Read source revision
                  </button>
                </>
              ) : (
                <p role="alert">
                  This source reference is unavailable. Refresh the draft before
                  accepting it.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    ) : (
      <p>No source references were reported.</p>
    );
  };
  useEffect(() => {
    if (!sourceReader) return;
    sourceReaderElement.current?.focus({ preventScroll: true });
    sourceReaderElement.current?.scrollIntoView({ block: "nearest" });
  }, [sourceReader]);
  useEffect(() => {
    if (
      !projectId ||
      !savedAutomaticMemory ||
      !managedAvailable ||
      memoryRequestPending ||
      memoryDirty
    )
      return;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "visible" || actionBlock.current)
          return;
        void perform("memory", async () => {
          const result = await service({
            operation: "extract-memory",
            projectId,
            requestId: id(),
            sourceObjectIds: savedSourceObjectIds,
            automatic: true,
          });
          if (Array.isArray(result.rescanRequired)) {
            setRescanSources(rescanIds(result.rescanRequired));
            setRescanReferences(
              rows(result.rescanRequired).flatMap((value) => {
                const source = cloudSourceReference(value);
                return source ? [source] : [];
              }),
            );
            setSavedAutomaticMemory(false);
            setNotice(
              "Previously processed source content changed. Automatic extraction is paused here until you review the changes and explicitly rescan.",
            );
          }
          if (typeof result.jobId === "string") {
            setMemoryRequestPending(true);
            setJob({ id: result.jobId, status: "queued" });
            setNotice(
              "The daily memory draft was requested. Refresh drafts after it finishes to review its source revisions.",
              "memory",
            );
          }
        });
      },
      30 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
  }, [
    projectId,
    savedAutomaticMemory,
    savedSourceObjectIds.join(","),
    managedAvailable,
    memoryRequestPending,
    memoryDirty,
  ]);
  return (
    <>
      <SettingsGroup
        id="cloud-selected-sync"
        label="Selected sync & backups"
        attention={!!feedback.sync?.error}
        summary={
          limits
            ? `${limits.historyDays} days of history, within your storage limit`
            : "Nothing uploads until you review it"
        }
      >
        <p>
          Choose a chat or appearance settings, review the exact portable
          content, then upload. Tool actions, approval policies, credentials,
          machine paths and provider sessions are excluded. Attachments are not
          included automatically. Cloud data is encrypted in storage and
          readable by the Gyro service.
        </p>
        {blockFeedback("sync")}
        <div className="gyro-settings-transfer-actions">
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={() =>
              void perform("sync", async () => {
                const local = await actions.request({
                  operation: "local-chats",
                });
                setLocalChats(rows(local.items) as unknown as LocalChat[]);
                setLoaded((old) => ({ ...old, local: true }));
                await loadObjects();
              })
            }
          >
            Load selected-sync controls
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={() =>
              void perform("sync", async () => {
                const result = await service({ operation: "retry-uploads" });
                setNotice(
                  result.queued
                    ? "Uploads remain queued locally."
                    : "Queued uploads checked. Conflict copies are preserved.",
                );
                await loadObjects();
              })
            }
          >
            Retry queued uploads
          </button>
        </div>
        {loaded.local && !localChats.length ? (
          <p>
            No local chats were found on this Mac. Appearance settings and
            explicit attachments can still be reviewed.
          </p>
        ) : null}
        {loaded.sync && !objects.length ? (
          <p>
            No selected content is saved in Cloud yet. Review a local chat,
            appearance settings or attachment to begin.
          </p>
        ) : null}
        {localChats.length ? (
          <label className="gyro-cloud-text-field">
            Local chat{" "}
            <SettingsSelect
              aria-label="Chat to review for Cloud sync"
              value={selected}
              disabled={busy}
              onChange={(e) => setSelected(e.currentTarget.value)}
            >
              <option value="">Choose a chat</option>
              {localChats.map((chat) => (
                <option key={chat.localId} value={chat.localId}>
                  {chat.title}
                </option>
              ))}
            </SettingsSelect>
          </label>
        ) : null}
        <div className="gyro-settings-transfer-actions">
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy || !selected}
            onClick={() =>
              void perform("sync", async () => {
                setPreview(
                  await actions.request({
                    operation: "preview-chat",
                    localId: selected,
                  }),
                );
                setReviewed(false);
              })
            }
          >
            Review selected chat
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={() =>
              void perform("sync", async () => {
                setPreview(
                  await actions.request({
                    operation: "preview-settings",
                    preferences: actions.preferences(),
                  }),
                );
                setReviewed(false);
              })
            }
          >
            Review appearance settings
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={() =>
              void perform("sync", async () => {
                const value = await actions.request({
                  operation: "preview-attachment",
                });
                if (!value.cancelled) {
                  setPreview(value);
                  setReviewed(false);
                }
              })
            }
          >
            Choose an attachment to review
          </button>
        </div>
        {preview ? (
          <div>
            <h3>Review selected content</h3>
            {preview.kind === "chat" ? (
              <>
                <strong>{String(previewContent.title ?? "Chat")}</strong>
                <details>
                  <summary>Read all selected messages</summary>
                  {rows(previewContent.messages).map((message, index) => (
                    <p key={index}>
                      <strong>{String(message.role)}:</strong>{" "}
                      {String(message.text)}
                    </p>
                  ))}
                </details>
              </>
            ) : preview.kind === "report" ? (
              <pre className="gyro-cloud-read-only-text">
                {String(preview.content ?? "")}
              </pre>
            ) : preview.kind === "attachment" ? (
              <p>
                Selected file: {String(previewContent.name)} ·{" "}
                {(Number(previewContent.sizeBytes) / 1_000_000).toFixed(1)} MB.
                Only this file is selected; other files and paths stay on this
                Mac. Attachments up to 50 MiB are supported by this client.
                Review its contents before uploading.
              </p>
            ) : (
              <dl>
                {["theme", "density", "interfaceSize", "motionSpeed"].map(
                  (key) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{String(previewContent[key] ?? "")}</dd>
                    </div>
                  ),
                )}
              </dl>
            )}
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.currentTarget.checked)}
              />{" "}
              I reviewed this selected content
            </label>
            <div className="gyro-settings-transfer-actions">
              <button
                type="button"
                className="gyro-primary-button"
                disabled={busy || !reviewed}
                onClick={() =>
                  void perform("sync", async () => {
                    if (preview.kind === "restore-settings") {
                      actions.applySettings(previewContent);
                      setNotice(
                        "Restored the reviewed appearance settings. Security and provider settings were preserved.",
                      );
                    } else {
                      const result = await actions.request({
                        operation: "upload-preview",
                        ticket: preview.ticket,
                        reviewed: true,
                      });
                      setNotice(
                        result.queued
                          ? "Selected content is queued locally; retry when Cloud is available."
                          : "Selected content uploaded. Original local data is preserved.",
                      );
                      await loadObjects();
                    }
                    setPreview(undefined);
                    setReviewed(false);
                  })
                }
              >
                {preview.kind === "restore-settings"
                  ? "Apply reviewed appearance"
                  : "Upload reviewed content"}
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                onClick={() => setPreview(undefined)}
              >
                Discard selection
              </button>
            </div>
          </div>
        ) : null}
        {objects.map((o) => (
          <div key={o.objectId}>
            {(o.kind === "chat" || o.kind === "report") && o.headRevisionId ? (
              <label>
                <input
                  type="checkbox"
                  checked={selectedObjectIds.includes(o.objectId)}
                  disabled={busy}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedObjectIds((old) =>
                      checked
                        ? [...old, o.objectId]
                        : old.filter((id) => id !== o.objectId),
                    );
                  }}
                />{" "}
                Use as an approved memory source
              </label>
            ) : null}
            <SettingsRow
              label={
                o.kind === "chat"
                  ? "Saved chat"
                  : o.kind === "settings"
                    ? "Appearance settings"
                    : "Selected cloud object"
              }
              detail={
                o.pinned
                  ? "Pinned: automatic cleanup is disabled."
                  : `Updated ${new Date(o.updatedAt).toLocaleString()}`
              }
              value={
                o.headRevisionId ? "Version available" : "No committed version"
              }
            />
            <div className="gyro-settings-transfer-actions">
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy || !o.headRevisionId}
                onClick={() => void perform("sync", () => readObject(o))}
              >
                {o.kind === "report" ? "Read report" : "Restore separate copy"}
              </button>
              {o.kind === "report" && o.headRevisionId ? (
                <button
                  type="button"
                  className="gyro-secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void perform("sync", async () => {
                      const shared = await service({
                        operation: "create-share",
                        objectId: o.objectId,
                        revisionId: o.headRevisionId,
                        expiresInDays: 7,
                      });
                      setLink(String(shared.url ?? ""));
                      await loadShares();
                    })
                  }
                >
                  Create report link for 7 days
                </button>
              ) : null}
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform("sync", async () => {
                    const result = await service({
                      operation: "versions",
                      objectId: o.objectId,
                    });
                    setVersions((old) => ({
                      ...old,
                      [o.objectId]: rows(result.items),
                    }));
                  })
                }
              >
                Version history
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform("sync", async () => {
                    await service({
                      operation: "pin-object",
                      objectId: o.objectId,
                      pinned: !o.pinned,
                    });
                    await loadObjects();
                  })
                }
              >
                {o.pinned ? "Unpin Cloud object" : "Protect from cleanup"}
              </button>
            </div>
            {versions[o.objectId]?.map((version) => (
              <div key={String(version.revisionId)}>
                <p>
                  {new Date(String(version.createdAt)).toLocaleString()}{" "}
                  {version.conflict ? "· preserved conflict copy" : ""}
                </p>
                <button
                  type="button"
                  className="gyro-secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void perform("sync", () =>
                      readObject({
                        ...o,
                        headRevisionId: String(version.revisionId),
                      }),
                    )
                  }
                >
                  Read this version separately
                </button>
                <button
                  type="button"
                  className="gyro-secondary-button"
                  disabled={busy || version.revisionId === o.headRevisionId}
                  onClick={() =>
                    void perform("sync", async () => {
                      await service({
                        operation: "restore-version",
                        objectId: o.objectId,
                        revisionId: version.revisionId,
                        expectedHeadRevisionId: o.headRevisionId,
                      });
                      await loadObjects();
                      setNotice(
                        "Cloud version restored with conflict protection. Existing local copies were preserved.",
                      );
                    })
                  }
                >
                  Restore as Cloud head
                </button>
              </div>
            ))}
          </div>
        ))}
        {archive ? (
          <details open>
            <summary>Restored read-only chat: {archive.title}</summary>
            <p>
              This archive remains read-only. Continue by reviewing its text,
              choosing a local project and opening a fresh chat draft. The new
              chat uses this machine's provider and permission settings and
              waits for you to press Send.
            </p>
            {archive.projectId ? (
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform("sync", async () => {
                    await loadMemory(archive.projectId!);
                    revealMemory();
                  })
                }
              >
                Open this Cloud project's memory
              </button>
            ) : null}
            {archive.messages.map((message, index) => (
              <p key={index}>
                <strong>{message.role}:</strong> {message.text}
              </p>
            ))}
            {actions.continueChat ? (
              <>
                <label className="gyro-cloud-text-field">
                  Reviewed context for the new local chat
                  <textarea
                    className="gyro-cloud-content-input"
                    rows={8}
                    aria-label="Reviewed context for a new local chat"
                    value={continuationContext}
                    onChange={(event) =>
                      setContinuationContext(event.currentTarget.value)
                    }
                  />
                </label>
                <p>
                  {Array.from(continuationContext).length.toLocaleString()} /{" "}
                  {CLOUD_CONTINUATION_MAX_CHARS.toLocaleString()} characters.
                  Shorten long context before continuing; the full archive is
                  preserved. Existing local drafts are preserved too.
                </p>
                <button
                  type="button"
                  className="gyro-primary-button"
                  disabled={
                    busy ||
                    !continuationContext.trim() ||
                    Array.from(continuationContext.trim()).length >
                      CLOUD_CONTINUATION_MAX_CHARS
                  }
                  onClick={() =>
                    void perform("sync", async () => {
                      const context =
                        reviewedCloudContinuation(continuationContext);
                      const opened = await actions.continueChat!(context);
                      setNotice(
                        opened
                          ? "A fresh local draft is ready. Review it and press Send when ready."
                          : "Project selection cancelled. The archive is preserved.",
                      );
                    })
                  }
                >
                  Continue as new local chat
                </button>
              </>
            ) : null}
          </details>
        ) : null}
        {readOnlyReport !== undefined ? (
          <details open>
            <summary>Read-only Gyro Check report</summary>
            <p>
              This saved text cannot run a Check, execute tools or restore
              permissions.
            </p>
            <pre className="gyro-cloud-read-only-text">{readOnlyReport}</pre>
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={() => setReadOnlyReport(undefined)}
            >
              Close report
            </button>
          </details>
        ) : null}
      </SettingsGroup>
      <SettingsGroup
        id="cloud-report-links"
        label="Report links"
        attention={!!feedback.links?.error}
        summary={
          limits
            ? `Up to ${limits.activeLinks} active, expiring links`
            : "Revocable access to explicitly selected reports"
        }
      >
        {blockFeedback("links")}
        <p>
          Anyone with a report link can read that report until it expires or is
          revoked. Revocation cannot recall copies already downloaded.
        </p>
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy}
          onClick={() => void perform("links", loadShares)}
        >
          Refresh report links
        </button>
        {link ? (
          <label className="gyro-cloud-text-field">
            New report link{" "}
            <input
              className="gyro-cloud-content-input"
              aria-label="New report link"
              value={link}
              readOnly
            />
          </label>
        ) : null}
        {loaded.links && !shares.length ? (
          <p>
            No report links were returned. Create a link from a reviewed saved
            report.
          </p>
        ) : null}
        {!loaded.links ? (
          <p>
            Refresh to load your saved report links and their current status.
          </p>
        ) : null}
        {shares.map((share, index) => (
          <CloudReportLinkRow
            key={String(share.shareId ?? index)}
            share={share}
            accessState={accessState}
            busy={busy}
            onRevoke={() =>
              void perform("links", async () => {
                await service({
                  operation: "revoke-share",
                  shareId: share.shareId,
                });
                await loadShares();
                setLink("");
                setNotice(
                  "Report link revoked. Previously downloaded copies cannot be recalled.",
                );
              })
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        id="cloud-project-memory"
        label="Editable project memory"
        attention={!!feedback.memory?.error}
        summary="Review decisions, requirements, findings and unfinished work"
      >
        {blockFeedback("memory")}
        <p>
          Select a local chat above to identify its project. Memory is editable
          and does not replace complete backups. Reading or saving memory does
          not delete source chats. Extraction sends selected Cloud source text
          to OpenAI GPT-6 Luna and consumes your included managed allowance.
          Drafts are suggestions that require review.
        </p>
        {!managedAvailable ? (
          <p>
            {memoryAvailability.reason} Reading saved memory, reviewing sources
            and editing memory do not create a new AI request.
          </p>
        ) : null}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy || !selected}
          onClick={() => void perform("memory", openMemory)}
        >
          Open selected project's memory
        </button>
        {projectId ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={automaticMemory}
                disabled={busy || !managedAvailable}
                onChange={(event) =>
                  setAutomaticMemory(event.currentTarget.checked)
                }
              />{" "}
              Allow at most one daily memory draft from selected Cloud sources
              while this signed-in page is open. It consumes managed allowance
              and still requires review.
            </label>
            <label>
              Project memory{" "}
              <textarea
                className="gyro-cloud-content-input"
                rows={6}
                aria-label="Editable project memory"
                disabled={busy}
                value={memory}
                maxLength={128000}
                onChange={(e) => setMemory(e.currentTarget.value)}
              />
            </label>
            {memoryDirty ? (
              <p role="status">
                You have unsaved memory edits. Save them or reload saved memory
                before accepting a generated draft.
              </p>
            ) : null}
            {memoryProvenance.length ? (
              <details>
                <summary>Saved memory source revisions</summary>
                {renderSources(memoryProvenance)}
              </details>
            ) : null}
            <div className="gyro-settings-transfer-actions">
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform("memory", async () => {
                    const saved = await service({
                      operation: "save-memory",
                      projectId,
                      expectedRevision: memoryRevision,
                      content: memory,
                      sources,
                      automaticEnabled: automaticMemory,
                      sourceObjectIds: selectedObjectIds,
                    });
                    setSavedAutomaticMemory(automaticMemory);
                    setSavedSourceObjectIds([...selectedObjectIds]);
                    setSavedMemory(memory);
                    setMemoryRevision(
                      Number(saved.revision ?? memoryRevision + 1),
                    );
                    setNotice("Memory saved. Source chats are preserved.");
                  })
                }
              >
                Save edited memory
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform("memory", async () => {
                    await loadMemory(projectId);
                    setNotice(
                      "Saved memory and its pending drafts were reloaded.",
                    );
                  })
                }
              >
                {memoryDirty
                  ? "Reload saved memory (replaces unsaved edits)"
                  : "Refresh memory & drafts"}
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={
                  busy ||
                  !selectedObjectIds.length ||
                  !managedAvailable ||
                  memoryDirty ||
                  memoryRequestPending
                }
                onClick={() =>
                  void perform("memory", async () => {
                    const extraction = await service({
                      operation: "extract-memory",
                      projectId,
                      requestId: id(),
                      sourceObjectIds: selectedObjectIds,
                      automatic: false,
                    });
                    if (Array.isArray(extraction.rescanRequired)) {
                      setRescanSources(rescanIds(extraction.rescanRequired));
                      setRescanReferences(
                        rows(extraction.rescanRequired).flatMap((value) => {
                          const source = cloudSourceReference(value);
                          return source ? [source] : [];
                        }),
                      );
                      setSavedAutomaticMemory(false);
                      setNotice(
                        "Previously processed content changed. Review the changed source versions, then explicitly request a correction draft. No AI job was created.",
                      );
                      return;
                    }
                    if (typeof extraction.jobId !== "string") {
                      setNotice("No new memory job was created.");
                      return;
                    }
                    setMemoryMorePending(extraction.morePending === true);
                    setMemoryRequestPending(true);
                    setJob({ id: extraction.jobId, status: "queued" });
                    setNotice(
                      extraction.morePending
                        ? "A bounded memory batch was requested; more source content remains. This consumes managed allowance. Review the completed draft before requesting the next batch."
                        : "Memory draft requested from the selected Cloud sources. This consumes managed allowance. Refresh memory to review the completed draft.",
                    );
                  })
                }
              >
                {memoryMorePending
                  ? "Process next memory batch after review"
                  : "Prepare memory draft"}
              </button>
              {rescanSources.length ? (
                <button
                  type="button"
                  className="gyro-secondary-button"
                  disabled={
                    busy ||
                    !managedAvailable ||
                    memoryDirty ||
                    memoryRequestPending
                  }
                  onClick={() =>
                    void perform("memory", async () => {
                      const result = await service({
                        operation: "extract-memory",
                        projectId,
                        requestId: id(),
                        sourceObjectIds: selectedObjectIds,
                        rescanObjectIds: rescanSources,
                        automatic: false,
                      });
                      if (typeof result.jobId === "string") {
                        setMemoryRequestPending(true);
                        setMemoryMorePending(result.morePending === true);
                        setJob({ id: result.jobId, status: "queued" });
                        setRescanSources([]);
                        setRescanReferences([]);
                        setNotice(
                          "A correction draft was requested for the reviewed source changes. Existing human memory edits remain protected.",
                        );
                      }
                    })
                  }
                >
                  Review changes and rescan selected sources
                </button>
              ) : null}
            </div>
            {memoryRequestPending ? (
              <p>
                Review or reject the existing extraction before requesting
                another batch. Refresh memory & drafts to load its latest state.
              </p>
            ) : null}
            {rescanSources.length ? (
              <details open>
                <summary>
                  Changed source revisions requiring explicit rescan
                </summary>
                <p>
                  Review these changed revisions before requesting a correction.
                  Automatic drafts are paused here.
                </p>
                {renderSources(rescanReferences)}
              </details>
            ) : null}
          </>
        ) : null}
        {projectId && !proposals.length ? (
          <p>
            No processing or reviewable memory drafts were returned. Saved
            memory remains editable.
          </p>
        ) : null}
        {sourceReader ? (
          <section
            ref={sourceReaderElement}
            className="gyro-cloud-source-reader"
            aria-label="Read-only memory source revision"
            tabIndex={-1}
          >
            <h3>
              Read-only source revision{" "}
              {sourceReader.source.revisionId.slice(0, 8)}
            </h3>
            <p>
              {sourceRangeLabel(sourceReader.source.messageRange)}
              {sourceReader.source.rescan
                ? " · explicitly rescanned content"
                : ""}
            </p>
            <p>
              These are source records, not permission to execute tools or
              change this Mac.
            </p>
            {sourceExcerpt ? (
              sourceExcerpt.map((message) => (
                <div key={message.index}>
                  <strong>
                    {sourceReader.messages
                      ? `Message ${message.index + 1} · ${message.role}`
                      : "Selected source text"}
                  </strong>
                  <pre className="gyro-cloud-read-only-text">
                    {message.text}
                  </pre>
                </div>
              ))
            ) : (
              <p role="alert">
                The recorded range could not be matched to this revision. Read
                the complete source below before reviewing the proposal.
              </p>
            )}
            <details>
              <summary>Read complete source revision</summary>
              {sourceReader.messages ? (
                sourceReader.messages.map((message, index) => (
                  <div key={index}>
                    <strong>
                      Message {index + 1} · {message.role}
                    </strong>
                    <pre className="gyro-cloud-read-only-text">
                      {message.text}
                    </pre>
                  </div>
                ))
              ) : (
                <pre className="gyro-cloud-read-only-text">
                  {sourceReader.text}
                </pre>
              )}
            </details>
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={() => {
                setSourceReader(undefined);
                sourceReaderTrigger.current?.focus();
              }}
            >
              Close source revision
            </button>
          </section>
        ) : null}
        {proposals.map((proposal, index) => (
          <CloudMemoryDraftCard
            key={String(proposal.extractionId ?? index)}
            proposal={proposal}
            currentRevision={memoryRevision}
            busy={busy}
            memoryDirty={memoryDirty}
            reviewed={reviewedDrafts.includes(String(proposal.extractionId))}
            provenance={renderSources(proposal.sources)}
            onReviewedChange={(checked) =>
              setReviewedDrafts((old) =>
                checked
                  ? [...new Set([...old, String(proposal.extractionId)])]
                  : old.filter((value) => value !== proposal.extractionId),
              )
            }
            onRead={() =>
              void perform("memory", async () => {
                const value = await service({
                  operation: "memory-proposal",
                  projectId,
                  extractionId: proposal.extractionId,
                });
                setReviewedDrafts((old) =>
                  old.filter((value) => value !== proposal.extractionId),
                );
                setProposals((old) =>
                  old.map((item) =>
                    item.extractionId === proposal.extractionId
                      ? { ...item, ...value, loaded: true }
                      : item,
                  ),
                );
                setNotice(
                  "Read the proposal and the source revisions below before accepting it.",
                );
              })
            }
            onRefreshRequest={
              proposal.jobId
                ? () =>
                    void perform("memory", async () => {
                      const request = await service({
                        operation: "job",
                        id: proposal.jobId,
                      });
                      const pending = await service({
                        operation: "list-memory-proposals",
                        projectId,
                      });
                      setProposals(
                        rows(pending.items ?? pending.proposals).map((item) =>
                          item.extractionId === proposal.extractionId
                            ? { ...item, jobStatus: request.status }
                            : item,
                        ),
                      );
                      setReviewedDrafts([]);
                      setNotice(
                        `Existing memory request: ${String(request.status ?? "status unavailable")}. No new request was submitted.`,
                      );
                    })
                : undefined
            }
            onReview={(action) =>
              void perform("memory", async () => {
                const acknowledged = await service({
                  operation: "review-memory-proposal",
                  projectId,
                  extractionId: proposal.extractionId,
                  action,
                  expectedRevision: memoryRevision,
                });
                const remaining = proposals.filter(
                  (item) => item.extractionId !== proposal.extractionId,
                );
                setProposals(remaining);
                setReviewedDrafts((old) =>
                  old.filter((value) => value !== proposal.extractionId),
                );
                setMemoryRequestPending(
                  remaining.some((item) =>
                    ["prepared", "proposal", "conflict"].includes(
                      String(item.status),
                    ),
                  ),
                );
                if (
                  action === "accept" &&
                  typeof acknowledged.content === "string"
                ) {
                  setMemory(acknowledged.content);
                  setSavedMemory(acknowledged.content);
                  if (Number.isSafeInteger(acknowledged.revision))
                    setMemoryRevision(Number(acknowledged.revision));
                }
                const message =
                  action === "accept"
                    ? "The reviewed memory draft was accepted. Source chats remain unchanged."
                    : "The draft was rejected. Saved memory and source chats remain unchanged.";
                setNotice(message);
                try {
                  await loadMemory(projectId);
                } catch {
                  setNotice(
                    `${message} The saved memory refresh is unavailable; refresh it when connected.`,
                  );
                }
              })
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        id="cloud-managed-assistance"
        label="Managed assistance"
        attention={!!feedback.ai?.error}
        summary="Suggestions, never observed local Check evidence"
      >
        {blockFeedback("ai")}
        <p>
          {taskAvailability.reason} Saved request recovery and status reads do
          not submit a new AI request.
        </p>
        <label className="gyro-cloud-text-field">
          Task{" "}
          <SettingsSelect
            aria-label="Managed assistance task"
            value={task}
            disabled={busy || (jobAmbiguous && !job)}
            onChange={(e) => {
              setTask(e.currentTarget.value);
              setJobRequest(id());
              setJobAmbiguous(false);
              setJob(undefined);
            }}
          >
            {CLOUD_TASKS.map((definition) => (
              <option
                key={definition.id}
                value={definition.id}
                disabled={
                  !managedAvailable ||
                  (definition.premium && plan !== "premium")
                }
              >
                {definition.label}
                {definition.premium && plan !== "premium" ? " · Premium" : ""}
              </option>
            ))}
          </SettingsSelect>
        </label>
        <label className="gyro-cloud-text-field">
          Selected text to send{" "}
          <textarea
            className="gyro-cloud-content-input"
            rows={6}
            aria-label="Selected context for managed assistance"
            value={context}
            maxLength={128000}
            disabled={busy || (jobAmbiguous && !job)}
            aria-invalid={!!context && !contextFit.allowed}
            onChange={(e) => {
              setContext(e.currentTarget.value);
              setJobRequest(id());
              setJobAmbiguous(false);
              setJob(undefined);
            }}
          />
        </label>
        {contextFit.budget ? (
          <p>
            Selected text: {contextFit.textBytes.toLocaleString()} UTF-8 bytes ·{" "}
            {contextFit.remaining.toLocaleString()} bytes of request space
            remain. Quotes and line breaks also use request space. The complete
            text is preserved; shorten oversized context before sending. The
            service verifies final limits.
          </p>
        ) : null}
        {!!context && !contextFit.allowed ? (
          <p role="alert">
            This text exceeds the verified plan's request space. Select a
            smaller context; nothing has been truncated or sent.
          </p>
        ) : null}
        <p>
          Only the text above is sent to Gyro Cloud and OpenAI GPT-6 Luna for
          this request. It may contain private project content; remove
          credentials first. Managed tasks and memory extraction consume your
          included allowance. Results are suggestions, never observed local
          Check evidence or a passing Check result.
        </p>
        <div className="gyro-settings-transfer-actions">
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={
              busy ||
              !taskAvailability.allowed ||
              !contextFit.allowed ||
              !!job ||
              jobAmbiguous
            }
            onClick={() =>
              void perform("ai", async () => {
                if (!taskAvailability.allowed || !contextFit.allowed)
                  throw new Error(
                    "Review the task availability and context size before sending.",
                  );
                setJobAmbiguous(true);
                setJob(
                  await service({
                    operation: "submit-job",
                    task,
                    context,
                    sourceIds: [],
                    idempotencyKey: jobRequest,
                  }),
                );
              })
            }
          >
            Send reviewed text
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={busy}
            onClick={() =>
              void perform("ai", async () => {
                setJob(await service({ operation: "recover-last-job" }));
                setJobAmbiguous(true);
              })
            }
          >
            Recover latest request
          </button>
          {jobAmbiguous && !job ? (
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={busy}
              onClick={() =>
                void perform("ai", async () => {
                  try {
                    setJob(
                      await service({
                        operation: "recover-job",
                        idempotencyKey: jobRequest,
                      }),
                    );
                  } catch (error) {
                    if (String(error).includes("No saved Cloud request")) {
                      setJobAmbiguous(false);
                      setNotice(
                        "The service confirms no saved request for this key. You can submit the same reviewed text.",
                      );
                    } else throw error;
                  }
                })
              }
            >
              Recover request status without resubmitting
            </button>
          ) : null}
          {job?.id ? (
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={busy}
              onClick={() =>
                void perform("ai", async () =>
                  setJob(await service({ operation: "job", id: job.id })),
                )
              }
            >
              Refresh request status
            </button>
          ) : null}
          {job &&
          ["succeeded", "failed", "cancelled"].includes(String(job.status)) ? (
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={busy}
              onClick={() => {
                setJob(undefined);
                setJobAmbiguous(false);
                setJobRequest(id());
                setNotice(
                  "The existing result is unchanged. Review the text before submitting a new request.",
                  "ai",
                );
              }}
            >
              Prepare another reviewed request
            </button>
          ) : null}
        </div>
        {!job && !jobAmbiguous ? (
          <p>
            No managed request is selected. Review text to submit a task, or
            recover the latest existing request.
          </p>
        ) : null}
        {job ? (
          <div role="status">
            <strong>{String(job.status ?? "Request accepted")}</strong>
            {job.status === "uncertain" ? (
              <p>
                Usage is being reconciled. Do not submit this request again.
              </p>
            ) : null}
            {record(job.result).summary ? (
              <>
                <p>{String(record(job.result).summary)}</p>
                {rows(record(job.result).items).map((item, index) => (
                  <p key={index}>{String(item.text)}</p>
                ))}
                <p>AI suggestion · not observed local evidence</p>
              </>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>
      <SettingsGroup
        id="cloud-devices"
        label="Connected devices"
        attention={!!feedback.devices?.error}
        summary="Revoke a Cloud session without affecting local data"
      >
        {blockFeedback("devices")}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy}
          onClick={() => void perform("devices", loadDevices)}
        >
          Refresh devices
        </button>
        {loaded.devices && !devices.length ? (
          <p>No registered Cloud devices were returned.</p>
        ) : null}
        {!loaded.devices ? (
          <p>Refresh to view the devices with access to this Cloud account.</p>
        ) : null}
        {devices.map((device, index) => (
          <div key={cloudDeviceId(device) ?? index}>
            <SettingsRow
              label={String(device.label ?? "Gyro device")}
              detail={
                device.lastSeenAt
                  ? `Last seen ${new Date(String(device.lastSeenAt)).toLocaleString()} · ${cloudDeviceId(device)?.slice(0, 8) ?? "unverified device"}`
                  : "Cloud access only"
              }
              value={device.revokedAt ? "Revoked" : "Registered"}
            />
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={busy || !!device.revokedAt || !cloudDeviceId(device)}
              onClick={() =>
                void perform("devices", async () => {
                  await service({
                    operation: "revoke-device",
                    deviceId: cloudDeviceId(device),
                  });
                  setDevices((old) =>
                    old.map((row) =>
                      cloudDeviceId(row) === cloudDeviceId(device)
                        ? { ...row, revokedAt: new Date().toISOString() }
                        : row,
                    ),
                  );
                  setNotice("Device access revoked. Local data is preserved.");
                  try {
                    await loadDevices();
                  } catch {
                    setNotice(
                      "Device access was revoked, but the refreshed list is unavailable. Refresh devices when connected. Local data is preserved.",
                    );
                  }
                })
              }
            >
              Revoke device
            </button>
          </div>
        ))}
      </SettingsGroup>
      <SettingsGroup
        id="cloud-account-data"
        label="Cloud account data"
        attention={!!feedback.account?.error}
        summary="Export or deliberately delete hosted data"
      >
        {blockFeedback("account")}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy}
          onClick={() =>
            void perform("account", async () => {
              const data = await actions.request({
                operation: "export-account-files",
              });
              setNotice(
                data.cancelled ? "Export cancelled." : String(data.notice),
              );
            })
          }
        >
          Export account data
        </button>
        <p>
          Cloud deletion leaves local chats and provider credentials on this
          Mac. Financial records may be retained separately under the account
          policy.
        </p>
        <label className="gyro-cloud-text-field">
          Type DELETE CLOUD DATA to request deletion{" "}
          <input
            className="gyro-cloud-content-input"
            aria-label="Cloud deletion confirmation"
            value={deleteConfirmation}
            onChange={(e) => setDeleteConfirmation(e.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={busy || deleteConfirmation !== "DELETE CLOUD DATA"}
          onClick={() =>
            void perform("account", async () => {
              await service({
                operation: "delete-account",
                confirmation: deleteConfirmation,
              });
              setDeleteConfirmation("");
              setNotice(
                "Cloud deletion was requested. Local copies are preserved.",
              );
            })
          }
        >
          Request Cloud deletion
        </button>
      </SettingsGroup>
    </>
  );
}
