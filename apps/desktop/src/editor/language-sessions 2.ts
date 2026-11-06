import { canonicalFileUri } from "./document-uri";

export type LanguageDocument = {
  path: string;
  root: string;
  languageId: string;
  command: string;
  content: string;
};
export type LanguageSession = {
  serverId: string;
  capabilities?: Record<string, unknown>;
  message: string;
  positionEncoding?: string;
};
export type LanguageResponse = {
  status: string;
  result?: unknown;
  error?: unknown;
  messages?: unknown[];
  documentVersion?: number;
};
export type LanguageTransport = {
  start(document: LanguageDocument): Promise<LanguageSession>;
  send(
    serverId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<LanguageResponse>;
  stop(serverId: string): Promise<unknown>;
};
type DocumentState = {
  desired: LanguageDocument;
  sent?: string;
  version: number;
  opened: boolean;
  queue: Promise<void>;
};
type ServerState = {
  session?: LanguageSession;
  promise: Promise<LanguageSession>;
};

/** One document stream across panes. Requests wait for pending buffer synchronization. */
export class LanguageSessions {
  private documents = new Map<string, DocumentState>();
  private servers = new Map<string, ServerState>();
  private disposed = false;

  constructor(
    private options: {
      transport: LanguageTransport;
      onState(
        document: LanguageDocument,
        status: "starting" | "ready" | "error",
        session?: LanguageSession,
        error?: string,
      ): void;
      onMessages(messages: unknown[] | undefined, root: string): void;
    },
  ) {}

  private key(document: LanguageDocument) {
    // JS/TS/JSX/TSX share one project server while each document keeps its language ID.
    return `${document.root}:${document.command}`;
  }

  private server(document: LanguageDocument) {
    if (this.disposed)
      return Promise.reject(new Error("Language session closed."));
    const key = this.key(document);
    let entry = this.servers.get(key);
    if (!entry) {
      this.options.onState(document, "starting");
      const created: ServerState = {
        promise: this.options.transport
          .start(document)
          .then(async (session) => {
            if (this.disposed) {
              await this.options.transport.stop(session.serverId);
              throw new Error("Language session closed.");
            }
            created.session = session;
            this.options.onState(document, "ready", session);
            return session;
          })
          .catch((error) => {
            this.servers.delete(key);
            if (!this.disposed)
              this.options.onState(document, "error", undefined, String(error));
            throw error;
          }),
      };
      this.servers.set(key, created);
      entry = created;
    }
    return entry.promise;
  }

  sync(document: LanguageDocument): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Language session closed."));
    const uri = canonicalFileUri(document.path);
    let state = this.documents.get(uri);
    let opening = Promise.resolve();
    if (
      state &&
      (this.key(state.desired) !== this.key(document) ||
        state.desired.languageId !== document.languageId)
    ) {
      const old = state;
      this.documents.delete(uri);
      const closed = old.queue.then(async () => {
        if (!old.opened) return;
        const session = await this.server(old.desired);
        await this.options.transport.send(
          session.serverId,
          "textDocument/didClose",
          { textDocument: { uri } },
        );
      });
      if (this.key(old.desired) === this.key(document)) opening = closed;
      else void closed.catch(() => undefined);
      state = undefined;
    }
    if (!state) {
      state = { desired: document, opened: false, version: 0, queue: opening };
      this.documents.set(uri, state);
    }
    state.desired = document;
    const current = state;
    current.queue = current.queue
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || this.documents.get(uri) !== current) return;
        const session = await this.server(current.desired);
        if (this.disposed || this.documents.get(uri) !== current) return;
        const wanted = current.desired;
        if (current.sent === wanted.content && current.opened) return;
        const version = current.version + 1;
        const response = await this.options.transport.send(
          session.serverId,
          current.opened ? "textDocument/didChange" : "textDocument/didOpen",
          current.opened
            ? {
                textDocument: { uri, version },
                contentChanges: [{ text: wanted.content }],
              }
            : {
                textDocument: {
                  uri,
                  version,
                  languageId: wanted.languageId,
                  text: wanted.content,
                },
              },
        );
        this.assertResponse(response);
        current.version = response.documentVersion ?? version;
        current.sent = wanted.content;
        current.opened = true;
        if (current.desired.content === wanted.content)
          this.options.onMessages(response.messages, wanted.root);
      });
    return current.queue;
  }

  syncForRequest(source: LanguageDocument, target: LanguageDocument) {
    if (this.key(source) !== this.key(target))
      return Promise.reject(
        new Error(
          "The target uses a different language-server workspace. This rename cannot safely update it.",
        ),
      );
    return this.sync(target);
  }

  async request(
    document: LanguageDocument,
    method: string,
    params: Record<string, unknown>,
  ) {
    await this.sync(document);
    const uri = canonicalFileUri(document.path);
    const siblings = [...this.documents.entries()].filter(
      ([, state]) => this.key(state.desired) === this.key(document),
    );
    await Promise.all(siblings.map(([, state]) => state.queue));
    const state = this.documents.get(uri);
    if (!state?.opened) throw new Error("Language document unavailable.");
    const content = state.sent;
    const version = state.version;
    const snapshots = siblings.map(([target, sibling]) => ({
      target,
      sibling,
      content: sibling.desired.content,
      version: sibling.version,
    }));
    const session = await this.server(document);
    const response = await this.options.transport.send(
      session.serverId,
      method,
      {
        ...params,
        textDocument: { uri: canonicalFileUri(document.path) },
      },
    );
    this.assertResponse(response);
    if (
      this.disposed ||
      this.documents.get(uri) !== state ||
      state.desired.content !== content ||
      state.version !== version ||
      snapshots.some(
        (snapshot) =>
          this.documents.get(snapshot.target) !== snapshot.sibling ||
          snapshot.sibling.desired.content !== snapshot.content ||
          snapshot.sibling.version !== snapshot.version,
      )
    )
      throw new Error("The document changed. Try again.");
    this.options.onMessages(response.messages, document.root);
    return response.result;
  }

  version(path: string) {
    return this.documents.get(canonicalFileUri(path))?.version;
  }
  ready(document: LanguageDocument) {
    return this.servers.get(this.key(document))?.session;
  }

  async reconcile(documents: LanguageDocument[]) {
    const desired = new Set(
      documents.map((document) => canonicalFileUri(document.path)),
    );
    const closing: Promise<unknown>[] = [];
    for (const [uri, state] of this.documents) {
      if (desired.has(uri)) continue;
      this.documents.delete(uri);
      closing.push(
        state.queue
          .then(async () => {
            if (!state.opened) return;
            const session = await this.server(state.desired);
            await this.options.transport.send(
              session.serverId,
              "textDocument/didClose",
              { textDocument: { uri } },
            );
          })
          .catch(() => undefined),
      );
    }
    await Promise.allSettled([
      ...closing,
      ...documents.map((document) => this.sync(document)),
    ]);
    const activeServers = new Set(
      [...this.documents.values()].map((state) => this.key(state.desired)),
    );
    for (const [key, entry] of this.servers) {
      if (activeServers.has(key)) continue;
      this.servers.delete(key);
      void entry.promise
        .then((session) => this.options.transport.stop(session.serverId))
        .catch(() => undefined);
    }
  }

  async poll() {
    await Promise.allSettled(
      [...this.servers.values()].map(async (entry) => {
        if (!entry.session) return;
        const response = await this.options.transport.send(
          entry.session.serverId,
          "$/gyro/poll",
          {},
        );
        const document = [...this.documents.values()].find(
          (value) => this.servers.get(this.key(value.desired)) === entry,
        );
        if (document)
          this.options.onMessages(response.messages, document.desired.root);
      }),
    );
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled(
      [...this.servers.values()].map(async (entry) => {
        const session = await entry.promise;
        await this.options.transport.stop(session.serverId);
      }),
    );
    this.documents.clear();
    this.servers.clear();
  }

  private assertResponse(response: LanguageResponse) {
    if (response.status === "error")
      throw new Error(
        JSON.stringify(response.error ?? "Language request failed."),
      );
  }
}
