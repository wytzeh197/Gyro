import type {
  Control,
  HostEvent,
  HostInfo,
  HostOperation,
  HostRequest,
  Snapshot,
} from "./types";
export type HostTarget = { kind: "local" } | { kind: "remote"; hostId: string };
export interface HostClient {
  readonly target: HostTarget;
  capabilities(): Promise<HostInfo>;
  request<T>(operation: HostOperation, requestId?: string): Promise<T>;
  subscribe(
    sessionId: string,
    handler: (event: HostEvent) => void,
  ): Promise<() => void>;
  dispose(): void;
}
export interface NativePorts {
  prepareMedia?: (file: File, kind: "image" | "video") => Promise<import("@gyro-dev/ui").ChatAttachment>;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

// All clients for a host share the transport's budget. Keep eight of its
// sixteen streams free for watches and native uploads. Interactive operations
// receive available slots first; a regular request is admitted after at most
// three interactive requests while both queues have work.
const hostBudgets = new Map<string, { active: number; waiting: Array<() => void>; interactive: Array<() => void>; interactiveRun: number }>();
function interactiveOperation(operation: HostOperation): boolean {
  if (operation.op === "terminal") return !["list", "read"].includes(operation.action);
  if (operation.op === "git") return !["status", "branches"].includes(operation.action);
  return ["claim", "release", "requestControl", "transferControl", "createSession", "renameSession", "setModel", "attachWorkspaceFile", "submit", "stop", "approval", "question", "writeFile", "path", "readFile", "search", "requestStatus"].includes(operation.op);
}
async function scheduled<T>(host: string, send: () => Promise<T>, interactive: boolean): Promise<T> {
  let budget = hostBudgets.get(host);
  if (!budget) hostBudgets.set(host, budget = { active: 0, waiting: [], interactive: [], interactiveRun: 0 });
  if (budget.active >= 8) await new Promise<void>((resolve) => (interactive ? budget!.interactive : budget!.waiting).push(resolve));
  else budget.active++;
  try { return await send(); }
  finally {
    let next: (() => void) | undefined;
    if (budget.interactive.length && (!budget.waiting.length || budget.interactiveRun < 3)) {
      next = budget.interactive.shift();
      budget.interactiveRun = Math.min(3, budget.interactiveRun + 1);
    } else {
      next = budget.waiting.shift();
      budget.interactiveRun = 0;
    }
    if (next) next();
    else if (--budget.active === 0) hostBudgets.delete(host);
  }
}
type TerminalInput = Extract<HostOperation, { op: "terminal" }>;
type InputBatch = { operation: TerminalInput; byteLength: number; resolve: (value: unknown) => void; reject: (reason: unknown) => void };
const MAX_INPUT_FRAME_BYTES = 60 * 1024;
const MAX_PENDING_INPUT_BYTES = 128 * 1024;

function terminalInputPieces(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  const pieces: Array<{input: string; byteLength: number}> = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + MAX_INPUT_FRAME_BYTES, bytes.length);
    // UTF-8 continuation bytes cannot begin the next frame.
    if (end < bytes.length) while ((bytes[end]! & 0xc0) === 0x80) end--;
    pieces.push({input: decoder.decode(bytes.subarray(offset, end)), byteLength: end - offset});
    offset = end;
  }
  return pieces.length ? pieces : [{input: "", byteLength: 0}];
}

/** Captures a host for its entire lifetime. It can never fall back to local IPC. */
export class RemoteHostClient implements HostClient {
  readonly target: HostTarget;
  private leases = new Map<string, number>();
  private disposed = false;
  private supportsLiveCatchup = false;
  private unsubscribe?: () => void;
  private subscription = 0;
  private watchId?: string;
  private inputBatches = new Map<string, InputBatch[]>();
  private leaseTimes = new Map<string, number>();
  private terminalInputs = new Map<string, Promise<unknown>>();
  private imagePreviews = new Map<string, Promise<string | undefined>>();
  private imageUrls = new Set<string>();
  readonly hostId: string;
  private ports: NativePorts;
  constructor(hostId: string, ports: NativePorts) {
    this.hostId = hostId;
    this.ports = ports;
    this.target = { kind: "remote", hostId };
  }
  capabilities() {
    return this.request<HostInfo>({ op: "hello" });
  }
  async request<T>(
    operation: HostOperation,
    requestId: string = crypto.randomUUID(),
  ): Promise<T> {
    if (this.disposed) throw new Error("This host connection was closed");
    const session = "sessionId" in operation ? operation.sessionId : undefined;
    const request: HostRequest = {
      id: requestId,
      operation,
      lease: session ? this.leases.get(session) : undefined,
    };
    const send = () => {
      if (this.disposed) throw new Error("This host connection was closed");
      return scheduled(this.hostId, () => {
        if (this.disposed) throw new Error("This host connection was closed");
        return this.ports.invoke<T>("remote_host_request", { hostId: this.hostId, request });
      }, interactiveOperation(operation));
    };
    let result: T;
    if (
      operation.op === "terminal" &&
      operation.action === "input" &&
      operation.paneId
    ) {
      const paneId = operation.paneId;
      const previous = this.terminalInputs.get(paneId) ?? Promise.resolve();
      const current = previous.then(send);
      this.terminalInputs.set(paneId, current);
      try {
        result = await current;
      } finally {
        if (this.terminalInputs.get(paneId) === current)
          this.terminalInputs.delete(paneId);
      }
    } else result = await send();
    if (this.disposed)
      throw new Error("Host changed while the request was running");
    if (operation.op === "hello")
      this.supportsLiveCatchup =
        (result as HostInfo).capabilities?.includes("liveCatchup") ?? false;
    if (operation.op === "claim" || operation.op === "transferControl") {
      const control = result as Control;
      if (operation.op === "claim") {
        this.leases.set(operation.sessionId, control.generation);
        this.leaseTimes.set(operation.sessionId, performance.now());
      }
      else this.leases.delete(operation.sessionId);
    }
    if (operation.op === "release") this.leases.delete(operation.sessionId);
    if (operation.op === "createSession") {
      const created = result as { session: { id: string }; control: Control };
      this.leases.set(created.session.id, created.control.generation);
    }
    return result;
  }
  /** Queue before claiming control. Never retry uncertain bytes after a drop. */
  input<T>(operation: TerminalInput): Promise<T> {
    if (operation.action !== "input" || !operation.paneId) return Promise.reject(new Error("Invalid terminal input"));
    if (this.disposed) return Promise.reject(new Error("This host connection was closed"));
    const key = `${operation.sessionId}:${operation.paneId}`;
    const text = operation.input ?? "";
    if (text.length > MAX_PENDING_INPUT_BYTES)
      return Promise.reject(new Error("The terminal paste is too large. Paste a smaller amount."));
    const bytes = new TextEncoder().encode(text);
    const queued = this.inputBatches.get(key);
    const pendingBytes = queued?.reduce((total, item) => total + item.byteLength, 0) ?? 0;
    if (bytes.length + pendingBytes > MAX_PENDING_INPUT_BYTES)
      return Promise.reject(new Error("Terminal input is backed up or the paste is too large. Wait for the host or paste a smaller amount."));
    const queue = queued ?? [];
    if (!queued) this.inputBatches.set(key, queue);
    const replies = terminalInputPieces(bytes).map((piece) => new Promise<T>((resolve, reject) => {
      queue.push({operation: {...operation, input: piece.input}, byteLength: piece.byteLength,
        resolve: resolve as (value: unknown) => void, reject});
    }));
    if (!queued) setTimeout(() => void this.flushInput(key), 10);
    return Promise.all(replies).then((values) => values[values.length - 1]!);
  }
  private async flushInput(key: string) {
    const queue = this.inputBatches.get(key)!;
    const sessionId = queue[0]?.operation.sessionId;
    try {
      while (queue.length) {
        const first = queue[0]!.operation;
        if (!this.leases.has(first.sessionId) || performance.now() - (this.leaseTimes.get(first.sessionId) ?? 0) > 10_000)
          await this.request({ op: "claim", sessionId: first.sessionId });
        const batch: InputBatch[] = [];
        let input = "", inputBytes = 0;
        while (queue.length && inputBytes + queue[0]!.byteLength <= MAX_INPUT_FRAME_BYTES) {
          const item = queue.shift()!; batch.push(item); input += item.operation.input ?? ""; inputBytes += item.byteLength;
        }
        if (!batch.length) throw new Error("Terminal input chunk exceeds the host limit");
        try {
          const result = await this.request({ ...first, input });
          for (const item of batch) item.resolve(result);
        } catch (error) {
          for (const item of batch) item.reject(error);
          throw error;
        }
      }
    } catch (error) {
      for (const item of queue) item.reject(error);
      if (sessionId) this.forgetControl(sessionId);
    } finally { this.inputBatches.delete(key); }
  }
  previewImage(sessionId: string, path: string): Promise<string | undefined> {
    const key = `${sessionId}:${path}`;
    const cached = this.imagePreviews.get(key);
    if (cached) return cached;
    const result = (async () => {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0, revision: string | undefined, mime = "", total: number | undefined;
      do {
        const chunk = await this.request<{
          data: string; nextOffset: number; total: number; revision: string; mimeType: string;
        }>({ op: "readImage", sessionId, path, offset });
        if (!chunk || !Number.isSafeInteger(chunk.total) || chunk.total <= 0 || chunk.total > 10 * 1024 * 1024
            || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= offset || chunk.nextOffset > chunk.total
            || chunk.nextOffset - offset > 256 * 1024
            || typeof chunk.data !== "string" || chunk.data.length > Math.ceil((256 * 1024) / 3) * 4
            || typeof chunk.revision !== "string" || !chunk.revision
            || !["image/png", "image/jpeg", "image/webp"].includes(chunk.mimeType)
            || (total !== undefined && total !== chunk.total)
            || (mime && mime !== chunk.mimeType)
            || (revision && revision !== chunk.revision))
          throw new Error("The host image changed or returned invalid metadata. Open it again.");
        total = chunk.total;
        revision = chunk.revision;
        mime = chunk.mimeType;
        const decoded = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
        if (decoded.length !== chunk.nextOffset - offset)
          throw new Error("Incomplete host image.");
        parts.push(decoded);
        offset = chunk.nextOffset;
        if (offset === chunk.total) break;
      } while (!this.disposed);
      if (this.disposed) return undefined;
      const url = URL.createObjectURL(new Blob(parts, { type: mime }));
      this.imageUrls.add(url);
      return url;
    })();
    this.imagePreviews.set(key, result);
    void result.catch(() => this.imagePreviews.delete(key));
    return result;
  }
  forgetControl(sessionId: string) {
    this.leases.delete(sessionId);
    this.leaseTimes.delete(sessionId);
  }
  async subscribe(sessionId: string, handler: (event: HostEvent) => void) {
    const generation = ++this.subscription;
    const watchId = crypto.randomUUID();
    this.watchId = watchId;
    this.unsubscribe?.();
    let catchingUp = true;
    const buffered: HostEvent[] = [];
    const unlisten = await this.ports.listen<{
      hostId: string;
      watchId: string;
      event: HostEvent;
    }>("gyro://remote-host-event", ({ payload }) => {
      if (
        !this.disposed &&
        generation === this.subscription &&
        payload.hostId === this.hostId &&
        payload.watchId === watchId &&
        payload.event.sessionId === sessionId
      ) {
        if (catchingUp) buffered.push(payload.event);
        else handler(payload.event);
      }
    });
    if (this.disposed || generation !== this.subscription) {
      unlisten();
      return () => {};
    }
    this.unsubscribe = unlisten;
    try {
      await this.ports.invoke("remote_host_watch", {
        hostId: this.hostId,
        sessionId,
        watchId,
      });
      // Listen first, then read the host's bounded current-turn catch-up. Live
      // frames arriving during that read wait so sequence ordering can dedupe
      // the overlap without dropping the beginning of an already-running turn.
      const snapshot = await this.request<Snapshot>({
        op: "snapshot",
        sessionId,
        ...(this.supportsLiveCatchup ? { includeLiveEvents: true } : {}),
      });
      if (!this.disposed && generation === this.subscription) {
        if (snapshot.liveCheckpoint) handler({ sessionId, topic: "checkpoint", payload: {
          events: snapshot.liveEvents ?? [], truncated: snapshot.liveTruncated ?? false,
        } });
        else for (const payload of snapshot.liveEvents ?? [])
          handler({
            sessionId,
            topic: "provider",
            payload: payload as unknown as Record<string, unknown>,
          });
        catchingUp = false;
        for (const event of buffered) handler(event);
      }
    } catch (error) {
      unlisten();
      void this.ports
        .invoke("remote_host_watch", {
          hostId: this.hostId,
          sessionId: null,
          watchId,
        })
        .catch(() => {});
      throw error;
    }
    return () => {
      unlisten();
      if (generation === this.subscription) {
        this.subscription++;
        void this.ports
          .invoke("remote_host_watch", {
            hostId: this.hostId,
            sessionId: null,
            watchId,
          })
          .catch(() => {});
      }
    };
  }
  dispose() {
    this.disposed = true;
    for (const url of this.imageUrls) URL.revokeObjectURL(url);
    this.imageUrls.clear();
    this.imagePreviews.clear();
    this.subscription++;
    this.unsubscribe?.();
    // Release authority, never stop work. No mutation is replayed after a failure.
    for (const [sessionId, lease] of this.leases)
      void this.ports
        .invoke("remote_host_request", {
          hostId: this.hostId,
          request: {
            id: crypto.randomUUID(),
            operation: { op: "release", sessionId },
            lease,
          },
        })
        .catch(() => {});
    this.leases.clear();
    if (this.watchId)
      void this.ports
        .invoke("remote_host_watch", {
          hostId: this.hostId,
          sessionId: null,
          watchId: this.watchId,
        })
        .catch(() => {});
  }
}
