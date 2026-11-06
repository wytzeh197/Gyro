import { SquareTerminal } from "lucide-react";

import {
  keepAliveStatusLabel,
  type KeepAliveWatch,
} from "./chat-keep-alive.ts";

export function ChatKeepAlive({
  onOpen,
  onRelaunch,
  onStop,
  watch,
}: {
  watch: KeepAliveWatch;
  onStop?: (paneId: string) => void;
  onOpen?: (paneId: string) => void;
  onRelaunch?: (paneId: string) => void;
}) {
  const status = keepAliveStatusLabel(watch);
  const isLive = watch.phase === "watching" || watch.phase === "relaunching";
  const canStop = isLive && onStop;
  const canRelaunch = !isLive && onRelaunch;
  return (
    <section
      aria-label={`${status} ${watch.title}`}
      className={`gyro-keep-alive is-${watch.phase}`}
    >
      <span
        aria-hidden="true"
        className={`gyro-keep-alive-dot is-${watch.phase}`}
      />
      <div className="gyro-keep-alive-text">
        <strong>
          {status} · {watch.title}
        </strong>
        <small title={watch.command}>{watch.command}</small>
      </div>
      <span className="gyro-keep-alive-actions">
        {canStop ? (
          <button
            onClick={() => onStop?.(watch.paneId)}
            title={`Stop ${watch.title}`}
            type="button"
          >
            Stop
          </button>
        ) : null}
        {canRelaunch ? (
          <button
            onClick={() => onRelaunch?.(watch.paneId)}
            title={`Relaunch ${watch.title}`}
            type="button"
          >
            Relaunch
          </button>
        ) : null}
        {onOpen ? (
          <button
            onClick={() => onOpen(watch.paneId)}
            title={`Show ${watch.title} in Terminal`}
            type="button"
          >
            <SquareTerminal aria-hidden="true" size={13} />
            Terminal
          </button>
        ) : null}
      </span>
    </section>
  );
}