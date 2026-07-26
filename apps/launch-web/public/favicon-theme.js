// Resolve the persisted theme before the application and its styles load. This
// self-hosted file stays compatible with the site's no-inline-script CSP.
// Chromium ignores prefers-color-scheme inside an SVG favicon and tends to
// ignore href changes on an existing favicon link, so the icon is replaced when
// the resolved theme changes.
(function () {
  var storageKey = "galactic.theme";
  var mediaQuery = null;
  var appliedFaviconTheme = null;
  var appliedThemeColor = null;

  function getMediaQuery() {
    if (mediaQuery) return mediaQuery;
    try {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      return mediaQuery;
    } catch (e) {
      return null;
    }
  }

  function getPreference() {
    try {
      var value = window.localStorage.getItem(storageKey);
      return value === "light" || value === "dark" || value === "system"
        ? value
        : "system";
    } catch (e) {
      return "system";
    }
  }

  function resolveTheme() {
    var preference = getPreference();
    if (preference !== "system") return preference;
    var query = getMediaQuery();
    return query && query.matches ? "dark" : "light";
  }

  function applyFavicon(theme) {
    if (theme === appliedFaviconTheme) return;
    var existing = document.querySelectorAll('link[rel~="icon"]');
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
    }
    var link = document.createElement("link");
    link.id = "favicon";
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = theme === "dark" ? "/favicon-white.svg" : "/favicon-black.svg";
    document.head.appendChild(link);
    appliedFaviconTheme = theme;
  }

  function applyThemeColor(theme) {
    var color = theme === "dark" ? "#0a0806" : "#efe9e1";
    if (color === appliedThemeColor) return;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.id = "theme-color";
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", color);
    appliedThemeColor = color;
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    if (root.getAttribute("data-theme") !== theme) {
      root.setAttribute("data-theme", theme);
    }
    if (root.style.colorScheme !== theme) {
      root.style.colorScheme = theme;
    }
    applyFavicon(theme);
    applyThemeColor(theme);
  }

  function synchronize() {
    applyTheme(resolveTheme());
  }

  synchronize();

  var query = getMediaQuery();
  if (query) {
    var onChange = function (e) {
      if (getPreference() === "system") applyTheme(e.matches ? "dark" : "light");
    };
    if (query.addEventListener) query.addEventListener("change", onChange);
    else if (query.addListener) query.addListener(onChange);
  }

  window.addEventListener("storage", function (event) {
    if (event.key === storageKey || event.key === null) synchronize();
  });

  // Same-document localStorage writes do not emit a storage event. React
  // applies data-theme synchronously, so observe that single attribute to keep
  // browser chrome and Chromium's favicon aligned with the selected preference.
  if (window.MutationObserver) {
    var observer = new window.MutationObserver(function () {
      var theme = document.documentElement.getAttribute("data-theme");
      if (theme === "light" || theme === "dark") {
        applyFavicon(theme);
        applyThemeColor(theme);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
})();
