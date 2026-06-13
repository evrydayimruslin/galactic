# Interfaces

An Interface is a static HTML page your Agent ships alongside its code. It
renders inside a locked sandbox on your Agent's public page and can call your
Agent's functions through a message bridge — nothing else. Think of it as a
visual front door for your Agent: viewers can see and try it without leaving
the page, and every function call bills exactly like a call from the
Functions playground.

## Declaring interfaces

Add `interfaces` to your `manifest.json` and include the files in your upload:

```jsonc
{
  "name": "Task Tracker",
  "version": "1.0.0",
  "type": "mcp",
  "entry": { "functions": "index.ts" },
  "functions": { "list_tasks": { "description": "List tasks" },
                 "add_task": { "description": "Add a task" } },
  "interfaces": [
    {
      "id": "dashboard",                       // slug-safe, unique
      "label": "Dashboard",                    // shown on the tab/picker
      "description": "Live task overview",     // optional
      "entry": "interfaces/dashboard.html",    // file in your upload
      "functions": ["list_tasks", "add_task"], // bridge allowlist
      "min_height": 360                         // optional, px
    }
  ]
}
```

Rules enforced at upload:

- `entry` must be a relative path inside your bundle ending in `.html` —
  no `..`, no leading `/`.
- One **self-contained** file per interface, at most **1 MiB**. Inline your
  CSS and JS; there is no way to load external scripts (see the sandbox).
- `functions` is the complete list of your functions the interface may call.
  Names not present on your manifest are silently pruned.
- The platform computes a content hash of your file at upload and serves it
  from an immutable, content-addressed URL. You never manage `hash` —
  anything you put there is overwritten. Unchanged interfaces keep their URL
  (and viewers' browser caches) across versions; changed ones roll atomically.

## The sandbox (what your HTML can and cannot do)

Your interface runs in an iframe with `sandbox="allow-scripts allow-forms"`
on a separate origin, under a CSP that denies all network access:

- **Can**: run inline JS, style itself (inline styles + https stylesheets),
  show images (`data:`, `blob:`, `https:`), use forms for input.
- **Cannot**: `fetch`/XHR anywhere, read cookies or storage, open popups,
  submit forms to a server (`form-action 'none'`), navigate the parent, or
  touch anything outside its frame.

The **only** I/O channel is the bridge below. Calls run with the *viewer's*
session and bill the viewer at your function prices, subject to the same
permissions as the Functions playground. Signed-out viewers can see your
interface but calls return a `SIGN_IN_REQUIRED` error — render a friendly
hint for that case.

## The bridge snippet

Paste this once in your interface's `<head>`. It performs the handshake and
gives you `ul.call`, `ul.context`, and `ul.resize`:

```html
<script>
(function () {
  var port = null, queue = [], pending = {}, nextId = 1;
  function flush() {
    if (!port) return;
    while (queue.length) {
      var item = queue.shift(), id = nextId++;
      pending[id] = item;
      port.postMessage({ type: "call", id: id, functionName: item.fn, args: item.args || {} });
    }
  }
  window.ul = {
    context: null, // { agent: {id, slug, name}, interfaceId, signedIn, minHeight }
    call: function (fn, args) {
      return new Promise(function (resolve, reject) {
        queue.push({ fn: fn, args: args, resolve: resolve, reject: reject });
        flush();
      });
    },
    resize: function (height) {
      if (port) port.postMessage({ type: "resize", height: height });
    },
  };
  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || d.type !== "ul-interface-connect" || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    window.ul.context = d.context;
    port.onmessage = function (e) {
      var m = e.data;
      if (!m || m.type !== "result" || !(m.id in pending)) return;
      var item = pending[m.id];
      delete pending[m.id];
      if (m.success) item.resolve(m.result);
      else {
        var err = new Error((m.error && m.error.message) || "Call failed");
        err.code = m.error && m.error.type;
        item.reject(err);
      }
    };
    flush();
    document.dispatchEvent(new CustomEvent("ul-ready"));
  });
  parent.postMessage({ type: "ul-interface-hello" }, "*");
})();
</script>
```

Usage — two timing rules matter:

1. The host can connect while your document is still parsing, so `ul-ready`
   may fire before your later scripts register a listener. Check
   `ul.context` directly as the fallback.
2. Measure heights only after layout settles (`requestAnimationFrame` or
   `window.load`) — `scrollHeight` read mid-parse undershoots badly.

```html
<script>
function init() {
  if (!ul.context.signedIn) { /* show a sign-in hint */ }
  ul.call("list_tasks", {}).then(function (result) { /* render */ })
    .catch(function (err) { /* err.code: SIGN_IN_REQUIRED, NOT_ALLOWED, ... */ });
  requestAnimationFrame(function () { ul.resize(document.body.scrollHeight); });
}
if (window.ul && ul.context) init();
else document.addEventListener("ul-ready", init);
</script>
```

If your page never sends the hello, the host shows "the interface has not
connected" after ~12 seconds — that means the snippet is missing or broken.

## Protocol reference

| Message | Direction | Shape |
|---|---|---|
| hello | frame → window.parent | `{ type: "ul-interface-hello" }` (send on load; re-send is fine) |
| connect | parent → frame | `{ type: "ul-interface-connect", context }` + a `MessagePort` — all further traffic uses the port |
| call | frame → port | `{ type: "call", id, functionName, args? }` (`id` string or number, unique per call) |
| result | parent → port | `{ type: "result", id, success, result?, receiptId?, error?: { type, message } }` |
| resize | frame → port | `{ type: "resize", height }` (clamped 120–900 px) |

Error types: `SIGN_IN_REQUIRED`, `NOT_ALLOWED` (not on your allowlist),
`BAD_ARGS`, `TOO_LARGE` (args over 64 KiB), `BUSY` (over 4 calls in flight),
`RATE_LIMITED` (over 30 calls/min), `RUN_FAILED`.

## Tips

- Treat the interface as a demo and control surface, not an SPA: render
  fast, call functions on user action, keep state in your Agent.
- Show prices: viewers pay your per-call function prices; gratuitous
  background polling will burn their credits and the rate limit.
- Test signed-out: the render is public even when calls are not.
- A full working example ships in `examples/interface-demo/`.
