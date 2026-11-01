import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { editorFilePolicy, isWorkspaceTrusted, resolveLanguage, workspaceRootForPath, type EditorBuffer, type LanguageServerState } from "@gyro-dev/ui";
import { isTauriRuntime } from "../tauri-runtime";
import { LanguageSessions, type LanguageDocument, type LanguageResponse, type LanguageSession } from "./language-sessions";

export function useLanguageSessions(options: {
  roots: string[];
  buffers: Record<string, EditorBuffer>;
  languageOverrides: Record<string, string>;
  trust: Record<string, "trusted" | "restricted">;
  onState(state: LanguageServerState): void;
  onMessages(messages: unknown[] | undefined, root: string): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const manager = useRef<LanguageSessions>();
  const lifetime = useRef(0);
  const getManager = useCallback(() => {
    if (!manager.current) manager.current = new LanguageSessions({
    transport: {
      start: document => invoke<LanguageSession>("lsp_start", { request: {
        workspacePath: document.root, languageId: document.languageId, command: document.command,
      } }),
      send: (serverId, method, params) => invoke<LanguageResponse>("lsp_request", { request: { serverId, method, params } }),
      stop: serverId => invoke("lsp_stop", { serverId }),
    },
    onState: (document, status, session, error) => latest.current.onState({
      id: `${document.root}:${document.languageId}:${document.command}`,
      languageId: document.languageId, command: document.command, activePath: document.path,
      serverId: session?.serverId, status: error?.includes("not found") ? "not-installed" : status,
      message: error ?? session?.message,
    }),
    onMessages: (messages, root) => latest.current.onMessages(messages, root),
    });
    return manager.current;
  }, []);
  const documentFor = useCallback((path: string): LanguageDocument | undefined => {
    const { roots, buffers, languageOverrides, trust } = latest.current;
    const root = workspaceRootForPath(roots, path);
    const buffer = buffers[path];
    if (!root || !buffer || !isWorkspaceTrusted(trust, root) || !isTauriRuntime()) return;
    const policy = editorFilePolicy(path, buffer.content, buffer.sizeBytes, buffer.truncated);
    const language = resolveLanguage({ path, override: languageOverrides[path] });
    if (!language.lsp || policy.binary || policy.limited || path.startsWith("gyro-diff:")) return;
    return { path, root, content: buffer.content, languageId: language.lsp.languageId ?? language.id, command: language.lsp.command };
  }, []);
  useEffect(() => {
    const documents = Object.keys(options.buffers).flatMap(path => {
      const document = documentFor(path);
      return document ? [document] : [];
    });
    void getManager().reconcile(documents);
  }, [options.buffers, options.roots, options.languageOverrides, options.trust, documentFor, getManager]);
  useEffect(() => {
    const sessionManager = getManager();
    const generation = ++lifetime.current;
    const interval = window.setInterval(() => { if (document.visibilityState !== "hidden") void sessionManager.poll(); }, 1000);
    return () => {
      window.clearInterval(interval);
      // StrictMode immediately re-runs this effect. Keep its shared native
      // session alive when that replacement setup claims the same manager.
      queueMicrotask(() => {
        if (lifetime.current !== generation || manager.current !== sessionManager) return;
        manager.current = undefined;
        void sessionManager.dispose();
      });
    };
  }, [getManager]);
  const request = useCallback(async (path: string, method: string, params: Record<string, unknown>) => {
    const document = documentFor(path);
    if (!document) throw new Error("A ready language server in a trusted workspace is required.");
    return getManager().request(document, method, params);
  }, [documentFor, getManager]);
  const ready = useCallback((path?: string) => {
    const document = path ? documentFor(path) : undefined;
    return document ? getManager().ready(document) : undefined;
  }, [documentFor, getManager]);
  const version = useCallback((path: string) => getManager().version(path), [getManager]);
  const synchronize = useCallback(async (path: string, sourcePath?: string) => {
    const document = documentFor(path);
    if (!document) throw new Error("An editable document in a trusted language-server workspace is required.");
    if (sourcePath) {
      const source = documentFor(sourcePath);
      if (!source) throw new Error("The source language-server workspace is no longer available.");
      await getManager().syncForRequest(source, document);
    } else await getManager().sync(document);
  }, [documentFor, getManager]);
  return { request, ready, version, synchronize };
}
