/**
 * Lightweight first paint while the full App module loads.
 * Intentionally avoids packages/ui and other heavy imports.
 */
export function EarlyShell() {
  return (
    <div className="gyro-early-shell" data-early-shell="true">
      <aside className="gyro-early-shell-sidebar" aria-hidden="true">
        <div className="gyro-early-shell-brand">Gyro</div>
        <div className="gyro-early-shell-nav">
          <span className="is-active">Chat</span>
          <span>CLI</span>
          <span>IDE</span>
        </div>
        <div className="gyro-early-shell-footer">
          <span className="gyro-early-shell-optimizing" role="status">
            <span className="gyro-early-shell-spinner" aria-hidden="true" />
            Optimizing Gyro
          </span>
        </div>
      </aside>
      <main className="gyro-early-shell-main">
        <div className="gyro-early-shell-hero">
          <h1>What should we build?</h1>
          <div className="gyro-early-shell-composer" aria-hidden="true">
            <div className="gyro-early-shell-input">Do anything</div>
            <div className="gyro-early-shell-composer-row">
              <span>Choose model</span>
              <span className="gyro-early-shell-send" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
