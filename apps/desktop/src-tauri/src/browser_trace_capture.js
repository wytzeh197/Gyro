(function (postBridge) {
  const captureDuration = 5000;
  let active;

  function snapshot() {
    if (!active) return null;
    return { id: active.id, sequence: active.sequence, click: active.click, events: active.events, done: active.done };
  }

  function publish() {
    active.sequence++;
    postBridge({ kind: "trace", trace: snapshot() });
  }

  function arm(options) {
    if (window !== window.top || location.origin !== options.origin) return { ok: false };
    active = { id: options.id, origins: [options.origin, options.apiOrigin], armedAt: performance.now(), sequence: 0, click: null, events: [], done: false };
    return { ok: true };
  }

  window.addEventListener("click", (event) => {
    const now = performance.now();
    if (!active || active.click || !event.isTrusted || now - active.armedAt >= 60000) return;
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest("button, a[href], [role=button], input[type=submit], input[type=button]");
    if (!element) return;
    const label = element.getAttribute("aria-label") || (element.tagName === "INPUT" ? "" : element.textContent) || element.tagName.toLowerCase();
    active.click = { label: label.trim().slice(0, 120) };
    active.clickedAt = now;
    const capture = active;
    publish();
    setTimeout(() => {
      if (active !== capture) return;
      active.done = true;
      publish();
    }, captureDuration);
  }, true);

  function observe(entry, startedAt = performance.now()) {
    const now = performance.now();
    if (!active?.click || active.done || startedAt < active.clickedAt ||
        now - active.clickedAt > captureDuration || active.events.length >= 24) return;
    active.events.push({ ...entry, elapsedMs: Math.round(now - active.clickedAt) });
    publish();
  }

  function network(entry, startedAt) {
    if (!active?.click || !Number.isFinite(startedAt)) return;
    try {
      const url = new URL(entry.url, location.href);
      if (!active.origins.includes(url.origin)) return;
      observe({ kind: "request", method: entry.method, origin: url.origin, path: url.pathname.slice(0, 400), status: entry.status }, startedAt);
    } catch (_) {}
  }

  function consoleError(entry) {
    if (!active?.click || !["console-error", "page-error", "unhandled-rejection"].includes(entry.kind)) return;
    let path = null;
    try {
      if (entry.source) {
        const source = new URL(entry.source, location.href);
        if (source.origin === location.origin) path = source.pathname.slice(0, 400);
      }
    } catch (_) {}
    observe({ kind: "console", message: entry.message.slice(0, 500), path, line: entry.line });
  }

  function stop(options) {
    if (active?.id === options.id) active = undefined;
    return { ok: true };
  }

  return { arm, snapshot, network, consoleError, stop };
})
