export interface LaunchWidgetDocumentOptions {
  appHtml: string;
  context?: Record<string, unknown>;
  surfaceId: string;
  toolId: string;
  toolSlug: string;
  widgetId: string;
}

export interface LaunchWidgetBridgeMessage {
  args?: unknown;
  context?: unknown;
  event?: unknown;
  functionName?: unknown;
  height?: unknown;
  requestId?: unknown;
  result?: unknown;
  snapshot?: unknown;
  success?: unknown;
  surfaceId?: unknown;
  type?: unknown;
  widgetName?: unknown;
}

export function createLaunchWidgetSurfaceId(
  toolId: string,
  widgetId: string,
): string {
  const entropy = Math.random().toString(36).slice(2, 10);
  return `launch-${slugPart(toolId)}-${slugPart(widgetId)}-${entropy}`;
}

export function buildLaunchWidgetDocument(
  options: LaunchWidgetDocumentOptions,
): string {
  const bridgeScript = buildLaunchWidgetBridgeScript(options);

  if (options.appHtml.includes("<head>")) {
    return options.appHtml.replace("<head>", `<head>${bridgeScript}`);
  }
  if (options.appHtml.includes("<html>")) {
    return options.appHtml.replace(
      "<html>",
      `<html><head>${bridgeScript}</head>`,
    );
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    bridgeScript,
    "</head>",
    "<body>",
    options.appHtml,
    "</body>",
    "</html>",
  ].join("");
}

export function isLaunchWidgetBridgeMessage(
  value: unknown,
): value is LaunchWidgetBridgeMessage {
  return Boolean(value && typeof value === "object" && "type" in value);
}

function buildLaunchWidgetBridgeScript(
  options: LaunchWidgetDocumentOptions,
): string {
  const context = options.context || {};
  return `<script>
(function () {
  var _surfaceId = ${scriptJson(options.surfaceId)};
  var _toolId = ${scriptJson(options.toolId)};
  var _toolSlug = ${scriptJson(options.toolSlug)};
  var _widgetName = ${scriptJson(options.widgetId)};
  var _context = ${scriptJson(context)};
  var _pending = {};
  var _stateProvider = null;
  var _actions = {};
  var _commandContext = null;

  function post(type, payload) {
    parent.postMessage(Object.assign({
      type: type,
      id: _surfaceId,
      surfaceId: _surfaceId,
      surface_id: _surfaceId,
      toolId: _toolId,
      toolSlug: _toolSlug,
      appUuid: _toolId,
      appSlug: _toolSlug,
      widgetName: _widgetName,
      widget_id: _widgetName
    }, payload || {}), "*");
  }

  function readState() {
    if (typeof _stateProvider !== "function") return null;
    try {
      var snapshot = _stateProvider();
      if (snapshot && typeof snapshot === "object") {
        if (!snapshot.surface_id) snapshot.surface_id = _surfaceId;
        if (!snapshot.widget_id) snapshot.widget_id = _widgetName;
        if (!snapshot.app_id) snapshot.app_id = _toolId;
        if (!snapshot.app_slug) snapshot.app_slug = _toolSlug;
      }
      return snapshot;
    } catch (err) {
      post("ul-widget-event", {
        event: {
          kind: "error",
          label: "Widget state provider failed",
          error: err && err.message ? err.message : String(err),
          created_at: new Date().toISOString()
        }
      });
      return null;
    }
  }

  function reportState(snapshot) {
    if (snapshot && typeof snapshot === "object") {
      if (!snapshot.surface_id) snapshot.surface_id = _surfaceId;
      if (!snapshot.widget_id) snapshot.widget_id = _widgetName;
      if (!snapshot.app_id) snapshot.app_id = _toolId;
      if (!snapshot.app_slug) snapshot.app_slug = _toolSlug;
      post("ul-widget-state", { snapshot: snapshot });
    }
    return snapshot;
  }

  function reportActions() {
    var actions = Object.keys(_actions).map(function (id) {
      return _actions[id].declaration;
    });
    post("ul-widget-actions", { actions: actions });
    return actions;
  }

  window.ulAction = function (functionName, args) {
    if (typeof functionName !== "string" || !functionName) {
      return Promise.reject(new Error("ulAction requires a function name"));
    }
    var requestId = _surfaceId + ":" + Date.now() + ":" +
      Math.random().toString(36).slice(2);
    var callArgs = args && typeof args === "object" ? Object.assign({}, args) : {};
    if (_commandContext) {
      callArgs = Object.assign({}, callArgs, {
        _widget_action: true,
        _widget_surface_id: _surfaceId,
        _widget_id: _widgetName,
        _widget_action_id: _commandContext.actionId,
        _widget_turn_id: _commandContext.turnId,
        _agentic_surface_action: Boolean(_commandContext.agenticActionId || _commandContext.agenticInterfaceId),
        _agentic_surface_id: _commandContext.agenticSurfaceId,
        _agentic_interface_id: _commandContext.agenticInterfaceId,
        _agentic_action_id: _commandContext.agenticActionId,
        _agentic_turn_id: _commandContext.turnId,
        _agentic_component_id: _commandContext.agenticComponentId
      });
    }
    return new Promise(function (resolve, reject) {
      _pending[requestId] = { resolve: resolve, reject: reject };
      post("ul-widget-action-request", {
        requestId: requestId,
        functionName: functionName,
        args: callArgs
      });
    });
  };

  window.ulOpenWidget = function (widgetName, context) {
    post("ul-open-widget", { widgetName: widgetName, context: context || {} });
  };

  window.ulWidgetContext = _context;
  window.ulWidget = {
    surfaceId: _surfaceId,
    widgetName: _widgetName,
    context: window.ulWidgetContext,
    reportState: function (snapshotOrProvider) {
      if (typeof snapshotOrProvider === "function") {
        _stateProvider = snapshotOrProvider;
        return reportState(readState());
      }
      _stateProvider = function () { return snapshotOrProvider; };
      return reportState(snapshotOrProvider);
    },
    refreshContext: function () {
      return reportState(readState());
    },
    registerAction: function (action, handler) {
      if (!action || typeof action !== "object" || typeof action.id !== "string" || !action.id) {
        throw new Error("ulWidget.registerAction requires an action object with id");
      }
      _actions[action.id] = {
        declaration: action,
        handler: typeof handler === "function" ? handler : null
      };
      reportActions();
      return action.id;
    },
    registerViewAction: function (action, handler) {
      var declaration = Object.assign({ mode: "ui", confirmation: "none" }, action || {});
      return window.ulWidget.registerAction(declaration, handler);
    },
    logEvent: function (event) {
      var payload = event && typeof event === "object" ? event : {
        kind: "system",
        label: String(event || "")
      };
      if (!payload.created_at) payload.created_at = new Date().toISOString();
      post("ul-widget-event", { event: payload });
      return payload;
    }
  };

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ul-widget-action-response") {
      var requestId = data.requestId;
      var pending = requestId && _pending[requestId];
      if (!pending) return;
      delete _pending[requestId];
      if (data.success) pending.resolve(data.result);
      else pending.reject(new Error(data.error || "Widget action failed"));
      return;
    }
    if (data.type !== "ul-widget-command") return;
    var targetSurfaceId = data.surfaceId || data.surface_id;
    if (targetSurfaceId && targetSurfaceId !== _surfaceId) return;
    var actionId = data.actionId || data.action_id;
    var turnId = data.turnId || data.turn_id;
    var entry = actionId ? _actions[actionId] : null;
    if (!entry || typeof entry.handler !== "function") {
      post("ul-widget-action-result", {
        result: {
          surface_id: _surfaceId,
          widget_id: _widgetName,
          action_id: actionId || "",
          turn_id: turnId,
          ok: false,
          error: actionId ? "No live handler registered for action " + actionId : "Missing action id"
        }
      });
      return;
    }
    var previousCommandContext = _commandContext;
    _commandContext = {
      actionId: actionId,
      turnId: turnId,
      agenticSurfaceId: data.agenticSurfaceId || data.agentic_surface_id,
      agenticInterfaceId: data.agenticInterfaceId || data.agentic_interface_id,
      agenticActionId: data.agenticActionId || data.agentic_action_id,
      agenticComponentId: data.agenticComponentId || data.agentic_component_id
    };
    Promise.resolve()
      .then(function () { return entry.handler(data.args || {}, data); })
      .then(function (result) {
        _commandContext = previousCommandContext;
        post("ul-widget-action-result", {
          result: {
            surface_id: _surfaceId,
            widget_id: _widgetName,
            action_id: actionId,
            turn_id: turnId,
            ok: true,
            data: result,
            snapshot: readState() || undefined
          }
        });
      })
      .catch(function (err) {
        _commandContext = previousCommandContext;
        post("ul-widget-action-result", {
          result: {
            surface_id: _surfaceId,
            widget_id: _widgetName,
            action_id: actionId,
            turn_id: turnId,
            ok: false,
            error: err && err.message ? err.message : String(err),
            snapshot: readState() || undefined
          }
        });
      });
  });

  function reportHeight() {
    if (!document.body) return;
    var h = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body.scrollHeight,
      document.body.offsetHeight
    );
    post("ul-widget-resize", { height: Math.ceil(Math.max(120, h + 2)) });
  }

  function startResizeObservers() {
    setTimeout(reportHeight, 50);
    setTimeout(reportHeight, 250);
    if (typeof MutationObserver === "function") {
      new MutationObserver(function () { setTimeout(reportHeight, 30); }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { setTimeout(reportHeight, 30); }).observe(document.body);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startResizeObservers);
  } else {
    startResizeObservers();
  }
  post("ul-widget-ready");
})();
</script>`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").slice(0, 32) ||
    "widget";
}
