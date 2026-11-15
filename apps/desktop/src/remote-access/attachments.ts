import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { askTextValue, type ChatAttachment } from "@gyro-dev/ui";
import {
  chatAttachmentKindForPath, chatAttachmentPickerFilters, chatAttachmentPickerTitle,
  type ChatAttachmentPickerKind,
} from "../chat-attachment-picker";
import type { NativePorts } from "./client";

// Prepared files stay on the client until Send transfers them to the selected host.
// Scope keys prevent a delayed picker/drop from attaching to a different chat.
const drafts = new Map<string, ChatAttachment[]>();
function readDraft(key: string): ChatAttachment[] {
  if (drafts.has(key)) return drafts.get(key)!;
  try {
    const value = JSON.parse(localStorage.getItem(`gyro.remote.attachments.${key}`) ?? "[]");
    if (Array.isArray(value) && value.length <= 16) {
      const attachments = value.filter((item) => item && typeof item.id === "string"
        && typeof item.path === "string" && typeof item.name === "string"
        && ["image", "video", "workspace-file"].includes(item.kind));
      drafts.set(key, attachments);
      return attachments;
    }
  } catch {}
  return [];
}
function writeDraft(key: string, items: ChatAttachment[]) {
  drafts.set(key, items);
  try { localStorage.setItem(`gyro.remote.attachments.${key}`, JSON.stringify(items)); } catch {}
}
export function clearRemoteAttachments(hostId: string, draftKey: string, ids: string[]) {
  const key = `${hostId}:${draftKey}`;
  const sent = new Set(ids);
  writeDraft(key, readDraft(key).filter((item) => !sent.has(item.id)));
}
export function useRemoteAttachments(
  hostId: string, draftKey: string, ports: NativePorts, onError: (error: string) => void,
) {
  const key = `${hostId}:${draftKey}`;
  const [, refresh] = useState(0);
  const pending = useRef(Promise.resolve());
  const [preparing, setPreparing] = useState(false);
  const attachments = readDraft(key);
  function change(scope: string, items: ChatAttachment[]) {
    writeDraft(scope, items);
    refresh((value) => value + 1);
  }
  function add(scope: string, attachment: ChatAttachment) {
    const items = readDraft(scope);
    const limit = attachment.kind === "image" ? 10 : attachment.kind === "video" ? 2 : 16;
    if (items.length >= 16 || items.filter((item) => item.kind === attachment.kind).length >= limit)
      throw new Error("This message has reached its attachment limit.");
    change(scope, [...items, attachment]);
  }
  function enqueue(task: () => Promise<void>) {
    setPreparing(true);
    const next = pending.current.then(task).catch((reason) => onError(String(reason)));
    pending.current = next;
    void next.finally(() => { if (pending.current === next) setPreparing(false); });
  }
  function prepare(paths: string[], files: File[] = []) {
    const scope = key;
    enqueue(async () => {
      for (const source of [...paths, ...files]) {
        const name = typeof source === "string" ? source.split(/[\\/]/).pop()! : source.name;
        const kind = chatAttachmentKindForPath("any", name);
        if (kind === "workspace-file")
          throw new Error("Use Add context to attach a file from the host project.");
        const limit = kind === "video" ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
        if (typeof source !== "string" && source.size > limit)
          throw new Error(`${name} exceeds the ${limit / 1024 / 1024} MB attachment limit.`);
        const prepared = typeof source !== "string" && ports.prepareMedia
          ? await ports.prepareMedia(source, kind)
          : await ports.invoke<ChatAttachment>("prepare_chat_attachment", {
              request: {
                sessionId: "new", path: typeof source === "string" ? source : "",
                name, kind, ...(typeof source === "string" ? {} : {
                  bytes: Array.from(new Uint8Array(await source.arrayBuffer())),
                }),
              },
            });
        add(scope, { ...prepared, previewUrl: prepared.previewUrl ?? convertFileSrc(prepared.path) });
      }
    });
  }
  async function pick(kind: ChatAttachmentPickerKind) {
    const scope = key;
    if (kind === "workspace-file") {
      const path = await askTextValue({ title: "Attach host project file (relative path, e.g. src/main.ts)" });
      if (path?.trim()) add(scope, {
        id: crypto.randomUUID(), kind: "workspace-file",
        name: path.trim().split("/").pop()!, path: path.trim(), relativePath: path.trim(),
        size: 0, available: true,
      });
      return;
    }
    try {
      const selected = await open({
        multiple: true, directory: false,
        title: chatAttachmentPickerTitle(kind), filters: chatAttachmentPickerFilters(kind),
      });
      if (selected) {
        // Keep the scope captured before the native dialog opened.
        const paths = typeof selected === "string" ? [selected] : selected;
        enqueue(async () => {
          for (const path of paths) {
            const mediaKind = chatAttachmentKindForPath("any", path);
            if (mediaKind === "workspace-file")
              throw new Error("Use Add context to attach a file from the host project.");
            const prepared = await ports.invoke<ChatAttachment>("prepare_chat_attachment", {
              request: { sessionId: "new", path, kind: mediaKind },
            });
            add(scope, { ...prepared, previewUrl: prepared.previewUrl ?? convertFileSrc(prepared.path) });
          }
        });
      }
    } catch (reason) { onError(String(reason)); }
  }
  return {
    attachments, preparing, pick,
    files: (files: File[]) => prepare([], files),
    paths: (paths: string[]) => prepare(paths),
    remove: (id: string) => change(key, (drafts.get(key) ?? []).filter((item) => item.id !== id)),
    clear: (scope: string, sent: ChatAttachment[]) => {
      const ids = new Set(sent.map((item) => item.id));
      change(`${hostId}:${scope}`, (drafts.get(`${hostId}:${scope}`) ?? []).filter((item) => !ids.has(item.id)));
    },
    move: (from: string, to: string) => {
      change(`${hostId}:${to}`, readDraft(`${hostId}:${from}`));
      change(`${hostId}:${from}`, []);
    },
  };
}
