// Page-local element selection. Observations are untrusted data, never instructions.
(function createBrowserAnnotations(window, document, api) {
  const {
    assignRef,
    resolveRef,
    roleOf,
    nameOf,
    isCredentialField,
    isVisible,
    pageState,
    pointerFeedback,
    epoch,
  } = api;
  let revision = 0;
  let active = false;
  let token = "";
  let selection = null;
  let error = "";
  let hover = null;
  let timer = 0;
  let priorFocus = null;
  let shield = null;
  const ownedSelector =
    "[data-gyro-browser-pointer],[data-gyro-browser-target],[data-gyro-browser-annotation-shield]";
  const own = (node) =>
    node?.nodeType === 1 &&
    (node.matches(ownedSelector) || node.closest(ownedSelector));
  const changed = (records) => {
    if (
      records.some(
        (record) =>
          !own(record.target) &&
          !(
            record.type === "childList" &&
            [...record.addedNodes, ...record.removedNodes].every(own)
          ),
      )
    )
      revision++;
  };
  const observer = new MutationObserver(changed);
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const state = () => {
    changed(observer.takeRecords());
    return {
      documentEpoch: epoch,
      revision,
      url: location.href,
      viewport: pageState().viewport,
    };
  };
  const same = (a, b) =>
    a &&
    b &&
    a.documentEpoch === b.documentEpoch &&
    a.revision === b.revision &&
    a.url === b.url &&
    ["width", "height", "deviceScaleFactor", "scrollX", "scrollY"].every(
      (key) => a.viewport?.[key] === b.viewport?.[key],
    );
  const protectedElement = (el) =>
    !el ||
    isCredentialField(el) ||
    !!el.closest(
      "iframe,frame,object,embed,input,textarea,select,[contenteditable]:not([contenteditable=false])",
    );
  const hit = (x, y) => {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= window.innerWidth ||
      y >= window.innerHeight
    )
      return null;
    if (shield) shield.style.pointerEvents = "none";
    let el;
    try {
      el = document.elementFromPoint(x, y);
    } finally {
      if (shield) shield.style.pointerEvents = "auto";
    }
    // Open shadow roots can be inspected; closed roots remain host observations.
    for (let depth = 0; depth < 8 && el?.shadowRoot; depth++) {
      const inner = el.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  const parentOf = (el) => el?.parentElement || el?.getRootNode?.()?.host;
  const visualTarget = (el) => {
    if (!el || protectedElement(el)) return el;
    // Preserve controls and media. Inline copy inherits its nearest visible card.
    if (el.closest("button,a,[role=button],img,svg,canvas,video"))
      return el.closest("button,a,[role=button],img,svg,canvas,video");
    for (
      let node = el, depth = 0;
      node && depth < 5;
      node = parentOf(node), depth++
    ) {
      if (node === document.body || node === document.documentElement) break;
      const css = getComputedStyle(node);
      if (
        node.matches("article,li,[role=group]") ||
        css.backgroundColor !== "rgba(0, 0, 0, 0)" ||
        parseFloat(css.borderTopWidth) > 0 ||
        css.boxShadow !== "none"
      )
        return node;
    }
    return el;
  };
  const protectedRects = () => {
    const rects = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (own(el)) continue;
        if (protectedElement(el) && isVisible(el)) {
          const r = el.getBoundingClientRect();
          rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          if (rects.length > 500)
            throw new Error("Too many protected fields to capture safely.");
        }
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return rects;
  };
  const outlineFor = (el) => {
    const rect = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    const w = el.offsetWidth || rect.width,
      h = el.offsetHeight || rect.height;
    const fallback = () => ({
      path: `M0 0H${rect.width}V${rect.height}H0Z`,
      matrix: [1, 0, 0, 1, rect.x, rect.y],
      exact: false,
    });
    if (!w || !h) return fallback();
    let matrix;
    const quad = el.getBoxQuads?.()[0];
    if (quad) {
      if (
        Math.abs(quad.p3.x - quad.p2.x - quad.p4.x + quad.p1.x) > 0.5 ||
        Math.abs(quad.p3.y - quad.p2.y - quad.p4.y + quad.p1.y) > 0.5
      )
        return fallback();
      matrix = [
        (quad.p2.x - quad.p1.x) / w,
        (quad.p2.y - quad.p1.y) / w,
        (quad.p4.x - quad.p1.x) / h,
        (quad.p4.y - quad.p1.y) / h,
        quad.p1.x,
        quad.p1.y,
      ];
    } else {
      for (let node = parentOf(el); node; node = parentOf(node))
        if (getComputedStyle(node).transform !== "none") return fallback();
      const m = new DOMMatrix(
        css.transform === "none" ? undefined : css.transform,
      );
      if (!m.is2D) return fallback();
      const xs = [0, m.a * w, m.c * h, m.a * w + m.c * h];
      const ys = [0, m.b * w, m.d * h, m.b * w + m.d * h];
      matrix = [
        m.a,
        m.b,
        m.c,
        m.d,
        rect.x - Math.min(...xs),
        rect.y - Math.min(...ys),
      ];
    }
    const value = (v, size) =>
      v.endsWith("%") ? (parseFloat(v) * size) / 100 : parseFloat(v);
    const radius = (v) => {
      const [x, y = x] = v.trim().split(/\s+/);
      return [Math.max(0, value(x, w) || 0), Math.max(0, value(y, h) || 0)];
    };
    let [tl, tr, br, bl] = [
      css.borderTopLeftRadius,
      css.borderTopRightRadius,
      css.borderBottomRightRadius,
      css.borderBottomLeftRadius,
    ].map(radius);
    const scale = Math.min(
      1,
      w / (tl[0] + tr[0] || 1),
      w / (bl[0] + br[0] || 1),
      h / (tl[1] + bl[1] || 1),
      h / (tr[1] + br[1] || 1),
    );
    [tl, tr, br, bl] = [tl, tr, br, bl].map((r) => r.map((n) => n * scale));
    const arc = (r, x, y) =>
      r[0] && r[1] ? `A${r[0]} ${r[1]} 0 0 1 ${x} ${y}` : `L${x} ${y}`;
    let path = `M${tl[0]} 0H${w - tr[0]}${arc(tr, w, tr[1])}V${h - br[1]}${arc(br, w - br[0], h)}H${bl[0]}${arc(bl, 0, h - bl[1])}V${tl[1]}${arc(tl, tl[0], 0)}Z`;
    const clip = css.clipPath;
    if (clip && clip !== "none") {
      const polygon = clip.match(/^polygon\((.+)\)$/);
      const ellipse = clip.match(/^(circle|ellipse)\(([^)]+)\)$/);
      if (polygon) {
        const points = polygon[1].split(",").map((p) => p.trim().split(/\s+/));
        if (
          points.length < 3 ||
          points.some(
            (p) => p.length !== 2 || p.some((v) => !/^[-\d.]+(px|%)?$/.test(v)),
          )
        )
          return fallback();
        path =
          points
            .map(([x, y], i) => `${i ? "L" : "M"}${value(x, w)} ${value(y, h)}`)
            .join("") + "Z";
      } else if (ellipse) {
        const [radii, center = "50% 50%"] = ellipse[2].split(/\s+at\s+/);
        const rs = radii.trim().split(/\s+/),
          cs = center.trim().split(/\s+/);
        if (
          cs.length !== 2 ||
          [...rs, ...cs].some((v) => !/^[-\d.]+(px|%)?$/.test(v))
        )
          return fallback();
        const rx = value(
          rs[0],
          ellipse[1] === "circle" ? Math.hypot(w, h) / Math.SQRT2 : w,
        );
        const ry = ellipse[1] === "circle" ? rx : value(rs[1] || rs[0], h);
        const cx = value(cs[0], w),
          cy = value(cs[1], h);
        path = `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
      } else return fallback();
    }
    // SVG paths have their own local coordinate system.
    if (el instanceof SVGElement) {
      const ctm = el.getScreenCTM?.();
      const d = el.localName === "path" ? el.getAttribute("d") : null;
      if (!ctm || !d || d.length > 10000) return fallback();
      return {
        path: d,
        matrix: [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f],
        exact: true,
      };
    }
    return { path, matrix, exact: css.maskImage === "none" };
  };
  let outlineLayer = null;
  let frame = 0;
  let pointer = null;
  const paintOutline = () => {
    if (!active) return;
    if (hover?.isConnected && !protectedElement(hover)) {
      const shape = outlineFor(hover);
      if (!outlineLayer) {
        outlineLayer = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        outlineLayer.setAttribute("data-gyro-browser-target", "");
        outlineLayer.setAttribute("aria-hidden", "true");
        outlineLayer.style.cssText =
          "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;overflow:hidden";
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#0874df");
        path.setAttribute("stroke-width", "2");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        outlineLayer.append(path);
        document.documentElement.append(outlineLayer);
      }
      const path = outlineLayer.firstChild;
      path.setAttribute("stroke-dasharray", shape.exact ? "" : "5 3");
      path.setAttribute("d", shape.path);
      path.setAttribute("transform", `matrix(${shape.matrix.join(" ")})`);
      outlineLayer.dataset.outlineAccuracy = shape.exact ? "shape" : "bounds";
    } else {
      outlineLayer?.remove();
      outlineLayer = null;
    }
    frame = requestAnimationFrame(paintOutline);
  };

  const selector = (el) => {
    const parts = [];
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      const tag = el.localName;
      if (!tag) break;
      if (el.id && el.id.length < 100) {
        parts.unshift("#" + CSS.escape(el.id));
        break;
      }
      const siblings = el.parentElement
        ? [...el.parentElement.children].filter(
            (node) => node.localName === tag,
          )
        : [];
      parts.unshift(
        tag +
          (siblings.length > 1
            ? ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")"
            : ""),
      );
    }
    return parts.join(" > ").slice(0, 500);
  };
  const describe = (el) => {
    if (protectedElement(el) || !isVisible(el))
      throw new Error(
        "Select a visible page element outside form fields or embedded frames.",
      );
    const rect = el.getBoundingClientRect();
    const styles = {};
    const computed = getComputedStyle(el);
    for (const key of [
      "display",
      "position",
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "text-align",
      "padding",
      "margin",
      "gap",
      "border-radius",
      "width",
      "height",
    ])
      styles[key] = computed.getPropertyValue(key).slice(0, 160);
    // Never serialize HTML, field values, URL-bearing styles, or arbitrary attributes.
    let text = "";
    let visited = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (text.length < 400 && visited++ < 200) {
      const node = walker.nextNode();
      if (!node) break;
      if (
        !protectedElement(node.parentElement) &&
        isVisible(node.parentElement) &&
        !node.parentElement.closest("script,style,noscript")
      )
        text += " " + node.textContent;
    }
    return {
      schema: "gyro.browser-annotation.v1",
      framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED",
      ...state(),
      capturedAt: new Date().toISOString(),
      ref: assignRef(el),
      tag: el.localName,
      role: roleOf(el),
      name: nameOf(el, false),
      text: text.replace(/\s+/g, " ").trim().slice(0, 400),
      selector: selector(el),
      shadowRoot: el.getRootNode() !== document,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles,
      outline: outlineFor(el),
      protectedRects: protectedRects(),
    };
  };
  const stop = () => {
    active = false;
    clearTimeout(timer);
    pointerFeedback.clear();
    cancelAnimationFrame(frame);
    outlineLayer?.remove();
    outlineLayer = null;
    pointer = null;
    shield?.remove();
    shield = null;
    hover = null;
  };
  const heartbeat = () => {
    clearTimeout(timer);
    // A closed panel or disconnected host must never leave a page swallowing input.
    if (active) timer = setTimeout(stop, 3000);
  };
  const choose = (el) => {
    try {
      selection = describe(el);
      error = "";
      stop();
    } catch (cause) {
      error = String(cause.message);
    }
  };
  const suppress = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!active) return;
      pointer = { x: event.clientX, y: event.clientY };
      hover = visualTarget(hit(pointer.x, pointer.y));
    },
    true,
  );
  for (const kind of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
  ]) {
    window.addEventListener(
      kind,
      (event) => {
        if (!active) return;
        suppress(event);
        if (kind === "click")
          choose(hover || visualTarget(hit(event.clientX, event.clientY)));
      },
      true,
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!active) return;
      if (event.key === "Escape") {
        suppress(event);
        selection = null;
        error = "";
        stop();
        priorFocus?.focus?.({ preventScroll: true });
      } else if (event.key === "Enter" || event.key === " ") {
        suppress(event);
        choose(hover || document.activeElement);
      } else if (event.key === "Tab") {
        suppress(event);
        // Keep keyboard selection out of subframes, where parent handlers cannot
        // intercept Enter or Escape. Never activate controls while choosing.
        const candidates = [...document.querySelectorAll("a,button,[tabindex]")]
          .slice(0, 2000)
          .filter(
            (el) =>
              !protectedElement(el) &&
              isVisible(el) &&
              !el.matches(":disabled") &&
              el.tabIndex >= 0,
          );
        if (candidates.length) {
          const index = candidates.indexOf(document.activeElement);
          const next =
            candidates[
              (index + (event.shiftKey ? -1 : 1) + candidates.length) %
                candidates.length
            ];
          next.focus();
          hover = next;
          pointer = null;
        }
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        suppress(event);
        const candidate =
          event.key === "ArrowUp"
            ? parentOf(hover)
            : pointer
              ? hit(pointer.x, pointer.y)
              : hover?.firstElementChild;
        if (candidate && !protectedElement(candidate) && isVisible(candidate))
          hover = candidate;
      } else suppress(event);
    },
    true,
  );
  window.addEventListener("pagehide", stop);
  return {
    state,
    request(options = {}) {
      const action = options.action;
      if (action === "start") {
        if (
          typeof options.token !== "string" ||
          !options.token ||
          options.token.length > 100
        )
          return { ok: false, error: "Invalid annotation selection." };
        stop();
        token = options.token;
        active = true;
        selection = null;
        error = "";
        priorFocus = document.activeElement;
        // A transparent hit layer also intercepts clicks over embedded frames.
        // Merely listening on the parent document would let those clicks through.
        shield = document.createElement("div");
        shield.setAttribute("data-gyro-browser-annotation-shield", "");
        shield.setAttribute("aria-hidden", "true");
        shield.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:crosshair;pointer-events:auto";
        document.documentElement.append(shield);
        paintOutline();
        heartbeat();
      } else if (action === "point") {
        if (!same(options.captureState, state()))
          return {
            ok: false,
            error:
              "This capture is stale. Return to Live and select the element again.",
          };
        try {
          selection = describe(hit(options.x, options.y));
          token = options.token;
          error = "";
          stop();
        } catch (cause) {
          return { ok: false, error: String(cause.message) };
        }
      } else if (action === "validate" || action === "capture") {
        const candidate = options.annotation;
        const el = resolveRef(candidate?.ref);
        // The ref is only valid in this document. Never re-target a replacement by selector.
        if (
          !candidate ||
          candidate.documentEpoch !== epoch ||
          candidate.url !== location.href ||
          !el
        )
          return {
            ok: false,
            error: "This element is stale. Select it again in Live.",
          };
        try {
          if (action === "capture") stop();
          const annotation = describe(el);
          if (
            action === "capture" &&
            (!same(candidate, annotation) ||
              !["x", "y", "width", "height"].every(
                (key) => candidate.rect?.[key] === annotation.rect[key],
              ))
          )
            return {
              ok: false,
              error:
                "The page changed before capture. Select the element again.",
            };
          return { ok: true, annotation };
        } catch (cause) {
          return { ok: false, error: String(cause.message) };
        }
      } else {
        if (token !== options.token)
          return { ok: true, active: false, annotation: null };
        if (action === "stop") {
          stop();
          selection = null;
          error = "";
        } else if (action !== "read")
          return { ok: false, error: "Unknown annotation action." };
        heartbeat();
      }
      return {
        ok: true,
        active,
        annotation: selection,
        selectionEnded: action === "read" && !active,
        error: error || undefined,
      };
    },
  };
});
