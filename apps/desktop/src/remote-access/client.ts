import type {
  Control,
  HostEvent,
  HostInfo,
  HostOperation,
  HostRequest,
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
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

/** Captures a host for its entire lifetime. It can never fall back to local IPC. */
export class RemoteHostClient implements HostClient {
  readonly target: HostTarget;
  private leases = new Map<string, number>();
  private disposed = false;
  private unsubscribe?: () => void;
  private subscription = 0;
  private watchId?: string;
  private terminalInputs = new Map<string, Promise<unknown>>();
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
      return this.ports.invoke<T>("remote_host_request", {
        hostId: this.hostId,
        request,
      });
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
    if (operation.op === "claim" || operation.op === "transferControl") {
      const control = result as Control;
      if (operation.op === "claim")
        this.leases.set(operation.sessionId, control.generation);
      else this.leases.delete(operation.sessionId);
    }
    if (operation.op === "release") this.leases.delete(operation.sessionId);
    if (operation.op === "createSession") {
      const created = result as { session: { id: string }; control: Control };
      this.leases.set(created.session.id, created.control.generation);
    }
    return result;
  }
  forgetControl(sessionId: string) {
    this.leases.delete(sessionId);
  }
  async subscribe(sessionId: string, handler: (event: HostEvent) => void) {
    const generation = ++this.subscription;
    const watchId = crypto.randomUUID();
    this.watchId = watchId;
    this.unsubscribe?.();
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
      )
        handler(payload.event);
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
    } catch (error) {
      unlisten();
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
