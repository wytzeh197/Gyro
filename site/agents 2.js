// Agent rotator: the headline names one agent at a time, the pill resizes to
// fit it, and the roster underneath doubles as the control. The page ships
// with the first agent in place, so this only adds motion. It pauses while
// off screen, while the tab is hidden, and while a mouse rests on the roster,
// and never auto-advances under reduced motion.
const section = document.querySelector("[data-agent-rotator]");
const slot = section?.querySelector("[data-agent-slot]");
if (section && slot) {
  const words = [...slot.querySelectorAll("[data-agent-word]")];
  const picks = [...section.querySelectorAll("[data-agent-pick]")];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const cycle = () =>
    parseFloat(getComputedStyle(section).getPropertyValue("--agent-cycle")) ||
    2600;
  let current = words.findIndex((word) => word.classList.contains("is-on"));
  let visible = false;
  let hovered = false;
  let timer = 0;
  let startedAt = 0;
  let remaining = cycle();

  const fit = () => {
    const style = getComputedStyle(slot);
    const chrome =
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth);
    slot.style.width = `${words[current].offsetWidth + chrome}px`;
  };

  const show = (next) => {
    if (next === current) return;
    words.forEach((word, index) => {
      word.classList.toggle("is-on", index === next);
      word.classList.toggle("is-out", index === current);
    });
    picks.forEach((pick, index) => {
      pick.classList.remove("is-on");
      pick.setAttribute("aria-pressed", String(index === next));
    });
    // Re-adding the class after a reflow restarts the progress bar.
    void picks[next].offsetWidth;
    picks[next].classList.add("is-on");
    current = next;
    fit();
  };

  const running = () =>
    visible && !hovered && !document.hidden && !reduced.matches;

  const advance = () => {
    timer = 0;
    show((current + 1) % words.length);
    remaining = cycle();
    sync();
  };

  function sync() {
    section.classList.toggle("is-rotating", !reduced.matches);
    section.classList.toggle("is-paused", !running());
    if (timer) {
      clearTimeout(timer);
      timer = 0;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
    }
    if (!running()) return;
    startedAt = performance.now();
    timer = setTimeout(advance, remaining);
  }

  section.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-agent-pick]");
    if (!pick) return;
    show(picks.indexOf(pick));
    remaining = cycle();
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    sync();
  });
  const roster = picks[0]?.closest("ul");
  roster?.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    hovered = true;
    sync();
  });
  roster?.addEventListener("pointerleave", () => {
    hovered = false;
    sync();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(section);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
  addEventListener("resize", fit);
  document.fonts?.ready.then(fit);
  fit();
  sync();
}
