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
      toggles[index].hidden = false;
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

// Native disclosure navigation works without this enhancement.
(function () {
  function wireNavigation() {
    var menus = document.querySelectorAll(".mobile-nav");
    for (var i = 0; i < menus.length; i++) {
      var menu = menus[i];
      menu.addEventListener("click", function (event) {
        if (event.target.closest("a")) this.open = false;
      });
      menu.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          this.open = false;
          this.querySelector("summary").focus();
        }
      });
    }
    var header = document.querySelector(".site-header");
    if (header) {
      var update = function () { header.classList.toggle("is-at-top", window.scrollY <= 8); };
      update();
      window.addEventListener("scroll", update, { passive: true });
      window.addEventListener("pageshow", update);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireNavigation);
  else wireNavigation();
})();
