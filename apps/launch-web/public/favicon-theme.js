// Theme-aware favicon. Chromium ignores prefers-color-scheme inside an SVG
// favicon, and CSP forbids inline scripts — so swap it from this self-hosted
// file: white mark on dark UI, black on light. Chromium also tends to ignore an
// href change on an existing favicon <link>, so we replace the element entirely
// (remove + re-append) to force the browser to re-read it.
(function () {
  function isDark() {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      return false;
    }
  }

  function apply(dark) {
    var existing = document.querySelectorAll('link[rel~="icon"]');
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
    }
    var link = document.createElement("link");
    link.id = "favicon";
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = dark ? "/favicon-white.svg" : "/favicon-black.svg";
    document.head.appendChild(link);
  }

  apply(isDark());

  try {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function (e) {
      apply(e.matches);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {
    /* no live updates — the initial apply() still set the right icon */
  }
})();
