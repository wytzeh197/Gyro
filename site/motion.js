// Load one theme's film only when its stage is visible. The picture is the
// first-paint and no-JavaScript fallback; explicit playback also works with
// reduced motion and data-saving preferences.
const stage = document.querySelector(".product-stage");
const video = stage?.querySelector(".workflow-film");
const toggle = stage?.querySelector(".motion-toggle");
if (stage && video && toggle) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let visible = false;
  let userChoice = null;
  let revision = 0;
  const wantsMotion = () =>
    userChoice ?? (!reduced.matches && !navigator.connection?.saveData);
  const paint = () => {
    toggle.textContent = video.paused ? "Play demo" : "Pause demo";
    toggle.setAttribute(
      "aria-label",
      video.paused
        ? "Play sample workflow video"
        : "Pause sample workflow video",
    );
  };
  async function sync() {
    const current = ++revision;
    if (!visible || document.hidden || !wantsMotion()) {
      video.pause();
      paint();
      return;
    }
    const theme =
      document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const source = `assets/motion/workflow-${theme}.mp4?v=2`;
    if (video.getAttribute("src") !== source) {
      video.classList.remove("is-playing");
      video.src = source;
      video.load();
    }
    try {
      await video.play();
      if (
        current !== revision &&
        (!visible || document.hidden || !wantsMotion())
      )
        video.pause();
    } catch {
      // Autoplay can be denied; leave the accessible manual play button.
    }
    paint();
  }
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    userChoice = video.paused;
    void sync();
  });
  video.addEventListener("playing", () => {
    video.classList.add("is-playing");
    paint();
  });
  video.addEventListener("pause", paint);
  video.addEventListener("error", () => {
    video.classList.remove("is-playing");
    paint();
  });
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      void sync();
    },
    { threshold: 0.15 },
  ).observe(stage);
  new MutationObserver(() => {
    video.pause();
    video.classList.remove("is-playing");
    // A paused film must not remain visible after the page theme changes.
    video.removeAttribute("src");
    video.load();
    void sync();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  reduced.addEventListener("change", () => {
    userChoice = null;
    void sync();
  });
  document.addEventListener("visibilitychange", sync);
}
