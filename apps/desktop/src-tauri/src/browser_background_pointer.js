// Page-local input for an agent's private webview. Never moves the OS cursor
// or focuses the parent window. The broker checks policy and screenshot freshness.
(function createBackgroundPointer(agent, window, document) {
  return function backgroundPointer(options) {
    const { action, x, y, toX = x, toY = y } = options;
    if (!["hover", "click", "secondary-click", "drag"].includes(action)) {
      return { ok: false, error: "unsupported browser pointer action" };
    }
    const points =
      action === "drag"
        ? [
            [x, y],
            [toX, toY],
          ]
        : [[x, y]];
    for (const [px, py] of points) {
      if (
        !Number.isFinite(px) ||
        !Number.isFinite(py) ||
        px < 0 ||
        py < 0 ||
        px >= window.innerWidth ||
        py >= window.innerHeight
      ) {
        return {
          ok: false,
          error: "pointer coordinates are outside the browser viewport",
        };
      }
      const target = agent.pointerTarget({ x: px, y: py });
      if (
        !target.ok ||
        target.blocked ||
        (action !== "hover" && target.sensitive)
      ) {
        return {
          ok: false,
          error:
            target.error ||
            target.blockedReason ||
            "this target needs user takeover",
        };
      }
    }
    const target = document.elementFromPoint(x, y);
    if (!target || target.closest("[disabled],[inert]")) {
      return { ok: false, error: "pointer target is unavailable or disabled" };
    }
    const button = action === "secondary-click" ? 2 : 0;
    const send = (element, type, px, py, buttons = 0) => {
      const EventClass = type.startsWith("pointer")
        ? window.PointerEvent
        : window.MouseEvent;
      return element.dispatchEvent(
        new EventClass(type, {
          bubbles: !["pointerenter", "mouseenter"].includes(type),
          cancelable: true,
          view: window,
          clientX: px,
          clientY: py,
          button,
          buttons,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    };
    const move = (element, px, py, buttons = 0) => {
      send(element, "pointermove", px, py, buttons);
      send(element, "mousemove", px, py, buttons);
    };
    send(target, "pointerover", x, y);
    send(target, "mouseover", x, y);
    send(target, "pointerenter", x, y);
    send(target, "mouseenter", x, y);
    move(target, x, y);
    if (action !== "hover") {
      const buttons = button === 2 ? 2 : 1;
      const pointerDefault = send(target, "pointerdown", x, y, buttons);
      const mouseDefault =
        pointerDefault && send(target, "mousedown", x, y, buttons);
      if (mouseDefault && typeof target.focus === "function")
        target.focus({ preventScroll: true });
      let release = target;
      if (action === "drag") {
        for (let step = 1; step <= 12; step++) {
          const px = x + ((toX - x) * step) / 12;
          const py = y + ((toY - y) * step) / 12;
          // Keep events in the originating page element for canvas and pointer
          // drag handlers. This does not emulate a native HTML drag-and-drop.
          move(target, px, py, buttons);
        }
        release = document.elementFromPoint(toX, toY) || target;
        // The originating element also needs the release when it owns a drag.
        send(target, "pointerup", toX, toY);
        send(target, "mouseup", toX, toY);
        if (release !== target) {
          send(release, "pointerup", toX, toY);
          send(release, "mouseup", toX, toY);
        }
      } else {
        send(release, "pointerup", x, y);
        send(release, "mouseup", x, y);
        send(
          release,
          action === "secondary-click" ? "contextmenu" : "click",
          x,
          y,
        );
      }
    }
    return {
      ok: true,
      inputMode: "page-events",
      verification:
        "Re-observe the result. Background input cannot provide trusted OS events, native menus, HTML drag-and-drop, or CSS hover state.",
    };
  };
});
