import React from "react";

export function AppFailure({ startup = false }: { startup?: boolean }) {
  return (
    <main className="gyro-root-error" role="alert">
      <h1>{startup ? "Gyro couldn’t load." : "Gyro hit a rendering error."}</h1>
      <p>Reload the window to try again.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload Gyro
      </button>
    </main>
  );
}
