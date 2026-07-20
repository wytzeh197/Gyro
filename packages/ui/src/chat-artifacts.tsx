import { useMemo, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileText,
  Globe2,
  ListChecks,
  Network,
  Table2,
  Terminal,
} from "lucide-react";
import type { ChatArtifact, SessionEvent, WorkbenchPaneTab } from "./types";

const MAX_ARTIFACTS = 8;
const MAX_COLUMNS = 12;
const MAX_ROWS = 100;

export type ChatArtifactActions = {
  onOpenFiles?: () => void;
  onOpenTool?: (tool: WorkbenchPaneTab) => void;
  onSendPrompt?: (prompt: string) => void;
};

export function chatArtifactsFromEvent(event: SessionEvent): ChatArtifact[] {
  const payload = recordValue(event.payload);
  if (!Array.isArray(payload?.artifacts)) return [];
  return payload.artifacts
    .slice(0, MAX_ARTIFACTS)
    .map(normalizeChatArtifact)
    .filter((artifact): artifact is ChatArtifact => Boolean(artifact));
}

export function ChatArtifacts({
  actions,
  artifacts,
}: {
  actions?: ChatArtifactActions;
  artifacts: ChatArtifact[];
}) {
  if (!artifacts.length) return null;
  return (
    <div className="gyro-chat-artifacts" aria-label="Interactive artifacts">
      {artifacts.map((artifact) => (
        <ChatArtifactCard
          actions={actions}
          artifact={artifact}
          key={artifact.id}
        />
      ))}
    </div>
  );
}

function ChatArtifactCard({
  actions,
  artifact,
}: {
  actions?: ChatArtifactActions;
  artifact: ChatArtifact;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const icon = artifactIcon(artifact.kind);
  return (
    <section
      className={`gyro-chat-artifact is-${artifact.kind}`}
      aria-label={`${artifact.title} ${artifact.kind}`}
    >
      <button
        aria-expanded={isExpanded}
        className="gyro-chat-artifact-header"
        onClick={() => setIsExpanded((value) => !value)}
        type="button"
      >
        <span className="gyro-chat-artifact-heading">
          {icon}
          <span>
            <strong>{artifact.title}</strong>
            <small>{artifactLabel(artifact.kind)}</small>
          </span>
        </span>
        {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {isExpanded ? (
        <div className="gyro-chat-artifact-body">
          <ChatArtifactContent actions={actions} artifact={artifact} />
        </div>
      ) : null}
    </section>
  );
}

function ChatArtifactContent({
  actions,
  artifact,
}: {
  actions?: ChatArtifactActions;
  artifact: ChatArtifact;
}) {
  if (artifact.kind === "decision") {
    return (
      <>
        {artifact.summary ? <p>{artifact.summary}</p> : null}
        <div className="gyro-chat-artifact-options">
          {artifact.options.map((option) => (
            <button
              className={option.recommended ? "is-recommended" : undefined}
              key={option.id}
              onClick={() =>
                actions?.onSendPrompt?.(
                  option.prompt ?? `Choose ${option.label}.`,
                )
              }
              type="button"
            >
              <span>
                <strong>{option.label}</strong>
                {option.recommended ? <small>Recommended</small> : null}
              </span>
              {option.description ? <em>{option.description}</em> : null}
            </button>
          ))}
        </div>
      </>
    );
  }
  if (artifact.kind === "command") {
    return (
      <>
        {artifact.purpose ? <p>{artifact.purpose}</p> : null}
        <div className="gyro-chat-artifact-command">
          <code>{artifact.command}</code>
          <button
            aria-label="Copy command"
            onClick={() => copyText(artifact.command)}
            title="Copy command"
            type="button"
          >
            <Copy size={14} />
          </button>
        </div>
        <div className="gyro-chat-artifact-meta">
          {artifact.workingDirectory ? (
            <span>{artifact.workingDirectory}</span>
          ) : null}
          {artifact.risk ? <span>Risk: {artifact.risk}</span> : null}
        </div>
        <div className="gyro-chat-artifact-footer-actions">
          {actions?.onSendPrompt ? (
            <button
              onClick={() =>
                actions.onSendPrompt?.(
                  `Run this command with the normal approval checks: ${artifact.command}`,
                )
              }
              type="button"
            >
              Run with approval
            </button>
          ) : null}
          {actions?.onOpenTool ? (
            <button
              onClick={() => actions.onOpenTool?.("terminal")}
              type="button"
            >
              Open terminal
            </button>
          ) : null}
        </div>
      </>
    );
  }
  if (artifact.kind === "completion") {
    return (
      <>
        <p>{artifact.summary}</p>
        {artifact.items?.length ? (
          <ul className="gyro-chat-artifact-checks">
            {artifact.items.map((item, index) => (
              <li
                className={`is-${item.status}`}
                key={`${item.label}-${index}`}
              >
                {item.status === "failed" ? (
                  <CircleAlert size={14} />
                ) : (
                  <Check size={14} />
                )}
                <span>
                  <strong>{item.label}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {artifact.files?.length ? (
          <ArtifactFooterAction
            label={`Open ${artifact.files.length} changed ${artifact.files.length === 1 ? "file" : "files"}`}
            onClick={() => actions?.onOpenTool?.("diff")}
          />
        ) : null}
      </>
    );
  }
  if (artifact.kind === "workspace") {
    return (
      <>
        <ul className="gyro-chat-artifact-files">
          {artifact.files.map((file) => (
            <li key={file.path}>
              <FileText size={14} />
              <span>
                <strong>{file.path}</strong>
                {file.description ? <small>{file.description}</small> : null}
              </span>
            </li>
          ))}
        </ul>
        <ArtifactFooterAction
          label="Open workspace"
          onClick={actions?.onOpenFiles}
        />
      </>
    );
  }
  if (artifact.kind === "preview") {
    return (
      <>
        {artifact.description ? <p>{artifact.description}</p> : null}
        {artifact.url ? (
          <code className="gyro-chat-artifact-url">{artifact.url}</code>
        ) : null}
        <ArtifactFooterAction
          label="Open preview"
          onClick={() => actions?.onOpenTool?.("browser")}
        />
      </>
    );
  }
  if (artifact.kind === "table") {
    return <ArtifactTable artifact={artifact} />;
  }
  if (artifact.kind === "diagram") {
    return (
      <div className="gyro-chat-artifact-diagram">
        {artifact.nodes.map((node) => {
          const outgoing = artifact.edges.filter(
            (edge) => edge.from === node.id,
          );
          return (
            <div key={node.id}>
              <strong>{node.label}</strong>
              {outgoing.length ? (
                <span>
                  →{" "}
                  {outgoing
                    .map((edge) => {
                      const target = artifact.nodes.find(
                        (node) => node.id === edge.to,
                      );
                      return `${edge.label ? `${edge.label}: ` : ""}${target?.label ?? edge.to}`;
                    })
                    .join(" · ")}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <>
      <p>{artifact.content}</p>
      <div className="gyro-chat-artifact-footer-actions">
        <button
          onClick={() =>
            actions?.onSendPrompt?.(
              artifact.operation === "forget"
                ? `Forget this memory: ${artifact.content}`
                : `Save this to memory: ${artifact.content}`,
            )
          }
          type="button"
        >
          {artifact.operation === "forget" ? "Forget" : "Save to memory"}
        </button>
        <button onClick={() => copyText(artifact.content)} type="button">
          Copy
        </button>
      </div>
    </>
  );
}

function ArtifactTable({
  artifact,
}: {
  artifact: Extract<ChatArtifact, { kind: "table" }>;
}) {
  const csv = useMemo(
    () =>
      [artifact.columns, ...artifact.rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\n"),
    [artifact.columns, artifact.rows],
  );
  return (
    <>
      <div className="gyro-chat-artifact-table-wrap">
        <table>
          <thead>
            <tr>
              {artifact.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {artifact.columns.map((_, columnIndex) => (
                  <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ArtifactFooterAction label="Copy CSV" onClick={() => copyText(csv)} />
    </>
  );
}

function ArtifactFooterAction({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  if (!onClick) return null;
  return (
    <div className="gyro-chat-artifact-footer-actions">
      <button onClick={onClick} type="button">
        {label}
      </button>
    </div>
  );
}

function normalizeChatArtifact(value: unknown): ChatArtifact | undefined {
  const item = recordValue(value);
  const id = stringValue(item?.id);
  const title = stringValue(item?.title);
  const kind = stringValue(item?.kind);
  if (!id || !title || !kind) return undefined;
  const status = artifactStatus(item?.status);
  if (kind === "decision") {
    const options = arrayValue(item?.options)
      .slice(0, 5)
      .map((value) => {
        const option = recordValue(value);
        const optionId = stringValue(option?.id);
        const label = stringValue(option?.label);
        if (!optionId || !label) return undefined;
        return {
          id: optionId,
          label,
          description: stringValue(option?.description),
          prompt: stringValue(option?.prompt),
          recommended: option?.recommended === true,
        };
      })
      .filter((option): option is NonNullable<typeof option> =>
        Boolean(option),
      );
    return options.length
      ? {
          id,
          kind,
          title,
          status,
          summary: stringValue(item?.summary),
          options,
        }
      : undefined;
  }
  if (kind === "command") {
    const command = stringValue(item?.command);
    if (!command) return undefined;
    const risk =
      item?.risk === "low" || item?.risk === "review" || item?.risk === "high"
        ? item.risk
        : undefined;
    return {
      id,
      kind,
      title,
      status,
      command,
      purpose: stringValue(item?.purpose),
      workingDirectory: stringValue(item?.workingDirectory),
      risk,
    };
  }
  if (kind === "completion") {
    const summary = stringValue(item?.summary);
    if (!summary) return undefined;
    const items: Extract<ChatArtifact, { kind: "completion" }>["items"] = [];
    for (const value of arrayValue(item?.items).slice(0, 20)) {
      const entry = recordValue(value);
      const label = stringValue(entry?.label);
      const entryStatus = entry?.status;
      if (
        label &&
        (entryStatus === "passed" ||
          entryStatus === "failed" ||
          entryStatus === "skipped" ||
          entryStatus === "changed")
      ) {
        items.push({
          label,
          status: entryStatus,
          detail: stringValue(entry?.detail),
        });
      }
    }
    return {
      id,
      kind,
      title,
      status,
      summary,
      items,
      files: stringArray(item?.files, 30),
    };
  }
  if (kind === "workspace") {
    const files = arrayValue(item?.files)
      .slice(0, 30)
      .flatMap((value) => {
        const file = recordValue(value);
        const path = stringValue(file?.path);
        return path
          ? [{ path, description: stringValue(file?.description) }]
          : [];
      });
    return files.length ? { id, kind, title, status, files } : undefined;
  }
  if (kind === "preview")
    return {
      id,
      kind,
      title,
      status,
      url: stringValue(item?.url),
      description: stringValue(item?.description),
    };
  if (kind === "table") {
    const columns = stringArray(item?.columns, MAX_COLUMNS);
    const rows = arrayValue(item?.rows)
      .slice(0, MAX_ROWS)
      .map((row) => stringArray(row, columns.length));
    return columns.length
      ? { id, kind, title, status, columns, rows }
      : undefined;
  }
  if (kind === "diagram") {
    const nodes = arrayValue(item?.nodes)
      .slice(0, 40)
      .flatMap((value) => {
        const node = recordValue(value);
        const nodeId = stringValue(node?.id);
        const label = stringValue(node?.label);
        return nodeId && label ? [{ id: nodeId, label }] : [];
      });
    const edges = arrayValue(item?.edges)
      .slice(0, 80)
      .flatMap((value) => {
        const edge = recordValue(value);
        const from = stringValue(edge?.from);
        const to = stringValue(edge?.to);
        return from && to
          ? [{ from, to, label: stringValue(edge?.label) }]
          : [];
      });
    return nodes.length ? { id, kind, title, status, nodes, edges } : undefined;
  }
  if (kind === "memory") {
    const content = stringValue(item?.content);
    const operation = item?.operation;
    return content &&
      (operation === "save" || operation === "edit" || operation === "forget")
      ? { id, kind, title, status, content, operation }
      : undefined;
  }
  return undefined;
}

function artifactIcon(kind: ChatArtifact["kind"]) {
  const props = { "aria-hidden": true, size: 16 } as const;
  if (kind === "decision") return <ListChecks {...props} />;
  if (kind === "command") return <Terminal {...props} />;
  if (kind === "completion") return <Check {...props} />;
  if (kind === "workspace") return <FileText {...props} />;
  if (kind === "preview") return <Globe2 {...props} />;
  if (kind === "table") return <Table2 {...props} />;
  if (kind === "diagram") return <Network {...props} />;
  return <Brain {...props} />;
}

function artifactLabel(kind: ChatArtifact["kind"]) {
  if (kind === "completion") return "Receipt";
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}

function artifactStatus(value: unknown) {
  return value === "streaming" ||
    value === "ready" ||
    value === "stale" ||
    value === "failed" ||
    value === "completed"
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function stringValue(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 4_000)
    : undefined;
}
function stringArray(value: unknown, max: number) {
  return arrayValue(value)
    .slice(0, max)
    .flatMap((item) => {
      const text = stringValue(item);
      return text ? [text] : [];
    });
}
function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}
