/*
 * Theme handling for every page.
 *
 * This is a blocking classic script in <head> rather than part of app.js: a
 * deferred module runs after the document is parsed, so the page would flash
 * the wrong theme. The site's CSP forbids inline scripts, so it has to be its
 * own file.
 *
 * The toggle is wired here too, because app.js only loads on the home and
 * install pages while the header toggle appears on all four.
 *
 * Light is the default for everyone; only an explicit choice is stored.
 */
(function () {
  var STORAGE_KEY = "gyro.site-theme";

  function apply(theme) {
    if (theme === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    var color = document.querySelector('meta[name="theme-color"]');
    if (color) {
      color.setAttribute("content", theme === "light" ? "#ffffff" : "#0c0c0c");
    }
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var index = 0; index < toggles.length; index += 1) {
      toggles[index].setAttribute(
        "aria-label",
        theme === "light" ? "Switch to dark theme" : "Switch to light theme",
      );
    }
  }

  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null; // Storage can be blocked; the light default still applies.
    }
  }

  // Before first paint, so there is no flash.
  apply(stored() === "dark" ? "dark" : "light");

  function wire() {
    apply(
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    );
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var index = 0; index < toggles.length; index += 1) {
      toggles[index].addEventListener("click", function () {
        var next =
          document.documentElement.dataset.theme === "light" ? "dark" : "light";
        apply(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch (error) {
          // Storage can be blocked; the toggle still works for this page view.
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();

// A quiet, mouse-only dot field shared by every page.
(function () {
  function wireDots() {
    var media = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    var canvas = document.createElement("canvas");
    canvas.className = "pointer-dots";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    var context = canvas.getContext("2d");
    if (!context) { canvas.remove(); return; }
    var pointer = null;
    var frame = 0;
    var width = 0;
    var height = 0;
    function draw() {
      frame = 0;
      context.clearRect(0, 0, width, height);
      if (!media.matches || !pointer) return;
      var light = document.documentElement.dataset.theme === "light";
      var radius = 190;
      var spacing = 24;
      for (var y = Math.max(12, Math.floor((pointer.y - radius) / spacing) * spacing + 12); y < Math.min(height, pointer.y + radius); y += spacing) {
        for (var x = Math.max(12, Math.floor((pointer.x - radius) / spacing) * spacing + 12); x < Math.min(width, pointer.x + radius); x += spacing) {
          var distance = Math.hypot(x - pointer.x, y - pointer.y) / radius;
          if (distance >= 1) continue;
          var opacity = Math.pow(1 - distance, 1.6) * (light ? 0.19 : 0.24);
          context.fillStyle = "rgba(" + (light ? "50,52,62," : "220,222,232,") + opacity + ")";
          context.beginPath();
          context.arc(x, y, 1, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(draw);
    }
    function resize() {
      width = innerWidth;
      height = innerHeight;
      var ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      schedule();
    }
    function clear() { pointer = null; schedule(); }
    window.addEventListener("pointermove", function (event) {
      if (!media.matches || event.pointerType !== "mouse") { clear(); return; }
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    }, { passive: true });
    document.documentElement.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("resize", resize, { passive: true });
    media.addEventListener("change", clear);
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    resize();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireDots);
  else wireDots();
})();
