// Browser-side measurements and machine-independent assertions. The recorded
// same-machine baseline is for refactors; these contracts are the CI gate.
export function measureChatContract() {
  const resolved = new Map();
  const color = (token) => {
    if (resolved.has(token)) return resolved.get(token);
    const swatch = document.createElement("span");
    swatch.style.cssText = `display:none;color:var(${token})`;
    document.body.append(swatch);
    const value = getComputedStyle(swatch).color;
    swatch.remove();
    resolved.set(token, value);
    return value;
  };
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const text = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      size: parseFloat(style.fontSize),
      line: parseFloat(style.lineHeight),
    };
  };
  return [...document.querySelectorAll(".gyro-chat-surface")].map((surface) => {
    const canvas = surface.querySelector(".gyro-chat-thread-canvas") ?? surface;
    const find = (selector) => surface.querySelector(selector);
    const column = {
      turn: box(find(".gyro-chat-turn")),
      user: box(find(".gyro-user-message-bubble")),
      reply: box(find(".gyro-response")),
      work: box(find(".gyro-run")),
      changes: box(find(".gyro-chat-run-change-summary")),
      composer: box(find(".gyro-composer-shell")),
      actions: box(find(".gyro-response-actions")),
    };
    const scale =
      parseFloat(
        getComputedStyle(surface).getPropertyValue("--gyro-ui-scale"),
      ) || 1;
    const textNodes = [
      ...surface.querySelectorAll(".gyro-chat-turn *, .gyro-composer-shell *"),
    ].filter((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        [...node.childNodes].some(
          (child) =>
            child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
        )
      );
    });
    const tooSmall = textNodes
      .filter(
        (node) =>
          parseFloat(getComputedStyle(node).fontSize) < 12 * scale - 0.1,
      )
      .map((node) => ({
        selector: node.className,
        size: parseFloat(getComputedStyle(node).fontSize),
      }));
    const radius = (selector) => {
      const node = find(selector);
      return node ? getComputedStyle(node).borderTopLeftRadius : null;
    };
    const composer = find(".gyro-composer-shell");
    const composerInput = composer?.querySelector("textarea");
    const environment = box(find(".gyro-chat-environment-popover"));
    return {
      isThread: surface.classList.contains("is-thread"),
      composerChrome: {
        surface: box(surface),
        input: box(find(".gyro-composer-input")),
        toolbar: box(find(".gyro-composer-bar")),
        context: box(find(".gyro-composer-context-row")),
        contextFirst: box(find(".gyro-context-summary-item")),
        setupPlaceholderHidden: find(
          ".gyro-composer-input.is-setup-empty:not(:has(textarea:focus))",
        )
          ? getComputedStyle(composerInput, "::placeholder").opacity === "0"
          : null,
      },
      scale,
      canvas: box(canvas),
      column,
      environment,
      paneHeader: (() => {
        const header = find(".gyro-chat-thread-topbar");
        if (!header) return null;
        return {
          bounds: box(header),
          title: box(header.querySelector("strong[data-chat-pane-drag]")),
          menuCount: [
            ...header.querySelectorAll(
              'button[aria-label="More chat surfaces"]',
            ),
          ].filter((node) => node.getClientRects().length > 0).length,
          compact:
            surface.classList.contains("is-tiled") &&
            (surface.closest(".gyro-chat-grid-slot")?.clientWidth ??
              Infinity) <= 360,
          directToggleCount: [
            ...header.querySelectorAll(
              '.gyro-chat-surface-controls > button:not([data-chat-pane-action="close"])',
            ),
          ].filter((node) => node.getClientRects().length > 0).length,
        };
      })(),
      waitingRows: [
        ...document.querySelectorAll(
          ".gyro-session-row:is(.is-awaiting-approval, .is-awaiting-question)",
        ),
      ].map((row) => {
        const badge = row.querySelector(".gyro-session-time");
        const main = row.querySelector(".gyro-sidebar-thread-main");
        return {
          bounds: box(main),
          title: box(row.querySelector(".gyro-sidebar-thread-title")),
          badge: box(badge),
          color: getComputedStyle(badge).color,
          iconColor: getComputedStyle(badge.querySelector("svg")).color,
          expectedColor: color("--gyro-status-waiting"),
          tooltip: main.title,
          label: main.getAttribute("aria-label"),
        };
      }),
      actionHeaders: [
        ...surface.querySelectorAll(
          ".gyro-chat-run-change-summary > header, .gyro-run-header",
        ),
      ].map((header) => ({
        bounds: box(header),
        content: [...header.children]
          .flatMap((child) => {
            if (
              child.matches(
                ".gyro-change-summary-actions, .gyro-run-header-actions",
              )
            )
              return [...child.querySelectorAll("button")].map(box);
            if (child.tagName === "DIV") {
              const range = document.createRange();
              range.selectNodeContents(child);
              return [box(range)];
            }
            return [box(child)];
          })
          .filter((rect) => rect && rect.width > 0 && rect.height > 0),
      })),
      userText: text(find(".gyro-user-message-bubble p")),
      replyText: text(find(".gyro-response-body")),
      paragraphs: [...surface.querySelectorAll(".gyro-response-body > p")].map(
        text,
      ),
      narration: text(find(".gyro-run-row.is-say .gyro-run-row-label")),
      radii: {
        user: radius(".gyro-user-message-bubble"),
        code: radius(".gyro-response-code-block"),
        changes: radius(".gyro-chat-run-change-summary"),
        composer: radius(".gyro-composer-input"),
      },
      tooSmall,
      composerOverflow: composer
        ? composer.scrollWidth > composer.clientWidth + 1
        : false,
      emptyComposerClips:
        composerInput && !composerInput.value
          ? composerInput.scrollHeight > composerInput.clientHeight + 1
          : false,
      overflowElements:
        composer && composer.scrollWidth > composer.clientWidth + 1
          ? [...composer.querySelectorAll("*")]
              .filter((node) => {
                const rect = node.getBoundingClientRect();
                const outer = composer.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  (rect.right > outer.right + 1 ||
                    rect.left < outer.left - 1) &&
                  !["absolute", "fixed"].includes(
                    getComputedStyle(node).position,
                  )
                );
              })
              .slice(0, 12)
              .map((node) => ({
                selector: node.className,
                width: node.getBoundingClientRect().width,
              }))
          : [],
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      focusBorder: find(".gyro-composer-input")
        ? getComputedStyle(find(".gyro-composer-input")).outlineColor
        : null,
      expectedFocusBorder: color("--gyro-focus-ring"),
      lists: [
        ...surface.querySelectorAll(".gyro-response-body :is(ul, ol)"),
      ].map((list) => {
        const style = getComputedStyle(list);
        const body = list.closest(".gyro-response-body");
        return {
          ordered: list.tagName === "OL",
          inset: parseFloat(style.paddingInlineStart),
          gap: parseFloat(style.rowGap),
          marker: style.listStyleType,
          items: [...list.children]
            .filter((node) => node.tagName === "LI")
            .map((item) => {
              const range = document.createRange();
              range.selectNodeContents(item);
              const fragments = [...range.getClientRects()].filter(
                (rect) => rect.width > 0 && rect.height > 0,
              );
              return {
                textInset: fragments.length
                  ? Math.min(...fragments.map((rect) => rect.left)) -
                    body.getBoundingClientRect().left
                  : null,
                line: parseFloat(getComputedStyle(item).lineHeight),
              };
            }),
        };
      }),
      inkActions: [
        ...surface.querySelectorAll(
          ".gyro-send-button:not(:disabled):not(.is-stop), .gyro-chat-environment-popover-actions button.is-primary",
        ),
      ].map((node) => ({
        isSend: node.classList.contains("gyro-send-button"),
        background: getComputedStyle(node).backgroundColor,
        color: getComputedStyle(node).color,
        expectedBackground: color("--gyro-ink-bg"),
        expectedHoverBackground: color("--gyro-ink-hover"),
        expectedColor: color("--gyro-ink-text"),
        childColors: [...node.querySelectorAll("span, small")].map(
          (child) => getComputedStyle(child).color,
        ),
      })),
      decoratedRunHeaders: [
        ...surface.querySelectorAll(".gyro-run-header"),
      ].filter((node) => {
        const pseudo = getComputedStyle(node, "::before");
        return (
          pseudo.display !== "none" &&
          !["none", "normal", '""'].includes(pseudo.content)
        );
      }).length,
    };
  });
}

export function checkChatContract(state, panes) {
  const failures = [];
  if (!panes.length) return [`${state}: chat surface missing`];
  const expectedPanes = state.startsWith("three-")
    ? 3
    : /^(?:split|stacked)-/.test(state)
      ? 2
      : 1;
  if (panes.length !== expectedPanes)
    failures.push(
      `${state}: expected ${expectedPanes} independent panes, found ${panes.length}`,
    );
  const near = (a, b) => Math.abs(a - b) <= 1;
  panes.forEach((pane, index) => {
    const label = `${state} pane ${index + 1}`;
    const composer = pane.column.composer;
    if (pane.paneHeader) {
      const header = pane.paneHeader;
      if (header.menuCount > 1)
        failures.push(`${label}: duplicate pane overflow menus`);
      if (
        header.compact &&
        (header.directToggleCount ||
          !header.menuCount ||
          !header.title ||
          header.title.width < 80 * pane.scale)
      )
        failures.push(
          `${label}: compact header must retain a readable title and accessible overflow`,
        );
    }
    if (/^(approval|question)-/.test(state) && !pane.waitingRows.length)
      failures.push(`${label}: waiting sidebar fixture missing`);
    for (const row of pane.waitingRows) {
      if (
        !row.title ||
        row.title.width < row.bounds.width / 2 ||
        row.badge.width > 30 * pane.scale
      )
        failures.push(`${label}: waiting indicator consumes the chat title`);
      if (
        row.color !== row.expectedColor ||
        row.iconColor !== row.expectedColor
      )
        failures.push(
          `${label}: waiting status must use its semantic attention color`,
        );
      if (
        !/approval|question/.test(row.tooltip) ||
        !/approval|question/.test(row.label)
      )
        failures.push(
          `${label}: waiting status must keep its full tooltip and accessible label`,
        );
    }
    for (const header of pane.actionHeaders) {
      for (const [i, rect] of header.content.entries()) {
        if (
          rect.left < header.bounds.left - 1 ||
          rect.right > header.bounds.right + 1
        )
          failures.push(`${label}: header content escapes its card`);
        if (
          header.content
            .slice(i + 1)
            .some(
              (other) =>
                Math.min(rect.right, other.right) -
                  Math.max(rect.left, other.left) >
                  1 &&
                Math.min(rect.bottom, other.bottom) -
                  Math.max(rect.top, other.top) >
                  1,
            )
        )
          failures.push(
            `${label}: header actions overlap status or file counts`,
          );
      }
    }
    for (const list of pane.lists) {
      if (
        Math.abs(list.inset - (list.ordered ? 24 : 16) * pane.scale) > 0.15 ||
        Math.abs(list.gap - 8 * pane.scale) > 0.15 ||
        list.marker !== (list.ordered ? "decimal" : "disc")
      )
        failures.push(`${label}: list marker gutter or rhythm is incorrect`);
      for (const item of list.items)
        if (
          (item.textInset !== null &&
            item.textInset < (list.ordered ? 28 : 20) * pane.scale - 0.2) ||
          Math.abs(item.line - 24 * pane.scale) > 0.15
        )
          failures.push(
            `${label}: list text must hang inside the column and use the shared reading line-height`,
          );
    }
    if (!composer) {
      failures.push(`${label}: composer missing`);
      return;
    }
    const chrome = pane.composerChrome;
    if (chrome.setupPlaceholderHidden === false)
      failures.push(
        `${label}: provider prompt must replace the empty placeholder`,
      );
    if (
      !chrome.input ||
      !chrome.toolbar ||
      chrome.input.bottom > chrome.toolbar.top + 1
    )
      failures.push(
        `${label}: rounded input must sit above the independent toolbar`,
      );
    if (
      chrome.context &&
      (chrome.context.bottom > chrome.input.top + 1 ||
        !near(chrome.contextFirst.left, composer.left + 4 * pane.scale))
    )
      failures.push(
        `${label}: workspace context must sit above the input, aligned left`,
      );
    if (
      !pane.isThread &&
      (chrome.surface.bottom - composer.bottom > 40 * pane.scale ||
        composer.bottom > chrome.surface.bottom + 1)
    )
      failures.push(
        `${label}: new-chat composer must stay at the bottom of its pane`,
      );

    const expectedWidth = Math.min(760, pane.canvas.width - 48 * pane.scale);
    if (!near(composer.width, expectedWidth))
      failures.push(
        `${label}: composer width ${composer.width.toFixed(2)}, expected ${expectedWidth.toFixed(2)}`,
      );
    for (const name of ["turn", "user", "reply", "work", "changes"]) {
      const element = pane.column[name];
      if (
        element &&
        (!near(element.left, composer.left) ||
          !near(element.right, composer.right))
      )
        failures.push(`${label}: ${name} column edges differ from composer`);
    }
    if (pane.column.actions && !near(pane.column.actions.left, composer.left))
      failures.push(`${label}: reply actions do not start on column edge`);
    for (const name of ["userText", "replyText", "narration"]) {
      const metrics = pane[name];
      if (
        metrics &&
        (Math.abs(metrics.size - 15 * pane.scale) > 0.1 ||
          Math.abs(metrics.line - 24 * pane.scale) > 0.15)
      )
        failures.push(
          `${label}: ${name} must use the shared reading size/line-height`,
        );
    }
    for (const paragraph of pane.paragraphs)
      if (
        Math.abs(paragraph.size - 15 * pane.scale) > 0.1 ||
        Math.abs(paragraph.line - 24 * pane.scale) > 0.15
      )
        failures.push(
          `${label}: paragraph text must use the shared reading size/line-height`,
        );
    for (const [name, radius] of Object.entries(pane.radii)) {
      if (radius && parseFloat(radius) !== (name === "composer" ? 18 : 12))
        failures.push(`${label}: ${name} radius is ${radius}`);
    }
    if (pane.tooSmall.length)
      failures.push(
        `${label}: ${pane.tooSmall.length} text elements below metadata floor`,
      );
    if (state.startsWith("environment-") && !pane.environment)
      failures.push(`${label}: Environment regression fixture must stay open`);
    if (
      pane.environment &&
      pane.environment.left < pane.canvas.right + 12 * pane.scale - 1 &&
      pane.environment.right > pane.canvas.left + 1
    )
      failures.push(
        `${label}: Environment must leave a reading gap beside the canvas`,
      );
    if (
      state.includes("interaction-composer-focus-visible") &&
      pane.focusBorder !== pane.expectedFocusBorder
    )
      failures.push(`${label}: composer focus must use the chosen accent ring`);
    for (const action of pane.inkActions)
      if (
        action.background !==
          (action.isSend && state.includes("interaction-send-hover")
            ? action.expectedHoverBackground
            : action.expectedBackground) ||
        action.color !== action.expectedColor ||
        action.childColors.some((value) => value !== action.expectedColor)
      )
        failures.push(`${label}: primary action must use readable neutral ink`);
    if (pane.composerOverflow || pane.pageOverflow)
      failures.push(`${label}: horizontal overflow`);
    if (pane.emptyComposerClips)
      failures.push(`${label}: empty composer clips its placeholder`);
    if (pane.decoratedRunHeaders)
      failures.push(`${label}: run header has a decorative status ring/check`);
  });
  return failures;
}
