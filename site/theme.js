/*
 * Theme handling for every page.
 *
 * This is a blocking classic script in <head> rather than part of app.js: a
 * deferred module runs after the document is parsed, so the page would flash
 * dark before switching to light. The site's CSP forbids inline scripts, so it
 * has to be its own file.
 *
 * The toggle is wired here too, because app.js only loads on the home and
 * install pages while the header toggle appears on all four.
 *
 * Dark is the default for everyone; only an explicit choice is stored.
 */
(function () {
  var STORAGE_KEY = "gyro.site-theme";

  function apply(theme) {
    if (theme === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
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
      return null; // Storage can be blocked; the dark default still applies.
    }
  }

  // Before first paint, so there is no flash.
  if (stored() === "light") document.documentElement.dataset.theme = "light";

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
