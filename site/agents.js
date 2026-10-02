// Progressive enhancement of the source-mark roster. Automatic changes are
// visual only; a manual choice persists until the visitor explicitly resumes.
const section = document.querySelector("[data-agent-rotator]");
const slot = section?.querySelector("[data-agent-slot]");
if (section && slot) {
  const words = [...slot.querySelectorAll("[data-agent-word]")];
  const picks = [...section.querySelectorAll("[data-agent-pick]")];
  const footprint = slot.closest(".agent-footprint");
  const roster = section.querySelector(".agent-roster");
  const toggle = section.querySelector("[data-agent-toggle]");
  const selected = section.querySelector("[data-agent-selected]");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const cycle = 4500;
  let current = Math.max(0, words.findIndex((word) => word.classList.contains("is-on")));
  let visible = false;
  let hovered = false;
  let focused = false;
  let manualPause = false;
  let suspended = false;
  let timer = 0;
  let startedAt = 0;
  let remaining = cycle;

  function fit() {
    const style = getComputedStyle(slot);
    const chrome = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
      .reduce((total, value) => total + (parseFloat(value) || 0), 0);
    // Reserve the largest name, so "Use" and the second line never move.
    if (footprint) footprint.style.width = `${Math.max(...words.map((word) => word.offsetWidth)) + chrome}px`;
    slot.style.width = `${words[current].offsetWidth + chrome}px`;
  }

  function stop(account = true) {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    if (account) remaining = Math.max(0, remaining - (performance.now() - startedAt));
  }

  function show(next) {
    words.forEach((word, index) => word.classList.toggle("is-on", index === next));
    picks.forEach((pick, index) => {
      pick.classList.remove("is-on");
      pick.setAttribute("aria-pressed", String(index === next));
    });
    void picks[next].offsetWidth; // Restart exactly one synchronized progress bar.
    picks[next].classList.add("is-on");
    current = next;
    if (selected) selected.textContent = picks[next].textContent.trim();
    fit();
  }

  function running() {
    return visible && !hovered && !focused && !manualPause && !suspended && !document.hidden && !reduced.matches;
  }

  function sync() {
    stop();
    section.classList.toggle("is-rotating", !reduced.matches);
    section.classList.toggle("is-manual", manualPause);
    section.classList.toggle("is-paused", !running());
    if (toggle) {
      toggle.hidden = reduced.matches;
      toggle.textContent = manualPause ? "Resume rotation" : "Pause rotation";
    }
    if (!running()) return;
    startedAt = performance.now();
    timer = setTimeout(() => {
      timer = 0;
      show((current + 1) % words.length);
      remaining = cycle;
      sync();
    }, remaining);
  }

  picks.forEach((pick, index) => {
    pick.disabled = false;
    pick.addEventListener("click", () => {
      stop(false);
      manualPause = true;
      remaining = cycle;
      show(index);
      sync();
    });
  });
  toggle?.addEventListener("click", () => {
    manualPause = !manualPause;
    if (!manualPause) { stop(false); remaining = cycle; }
    sync();
  });
  roster?.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    hovered = true;
    sync();
  });
  roster?.addEventListener("pointerleave", () => { hovered = false; sync(); });
  section.addEventListener("focusin", (event) => {
    focused = event.target?.matches?.(":focus-visible") ?? true;
    sync();
  });
  section.addEventListener("focusout", (event) => {
    focused = Boolean(event.relatedTarget && section.contains(event.relatedTarget));
    sync();
  });
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  });
  function checkViewport() {
    const rect = section.getBoundingClientRect();
    visible = rect.bottom > 0 && rect.top < innerHeight;
    sync();
  }
  observer?.observe(section);
  if (!observer) addEventListener("scroll", checkViewport, { passive: true });
  document.addEventListener("visibilitychange", sync);
  if (reduced.addEventListener) reduced.addEventListener("change", sync);
  else reduced.addListener?.(sync);
  addEventListener("resize", () => { fit(); if (!observer) checkViewport(); });
  addEventListener("pagehide", () => { suspended = true; observer?.disconnect(); sync(); });
  addEventListener("pageshow", () => { suspended = false; if (observer) observer.observe(section); else checkViewport(); sync(); });
  document.fonts?.ready.then(fit);
  fit();
  if (!observer) checkViewport();
  sync();
}
