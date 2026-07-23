import React from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./App";
import { consumeExternalReturnRevalidation } from "./lib/external-navigation";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Launch app root not found");
}

if (consumeExternalReturnRevalidation()) {
  // Stripe and other cross-origin flows can restore a frozen document whose
  // JS predates the current deployment. Reload before React paints that shell.
  window.location.reload();
} else {
  // A tiny, observable boot sentinel helps deployment smoke distinguish a module
  // that actually executed from an HTML shell whose hashed asset failed to load.
  // Keep the value stable; changing this line also intentionally rotates the
  // content-hashed entry asset after cache-routing fixes.
  root.dataset.launchClient = "booted";
  // v0.4.43 removed the poisoning route, but its first production edge rollout
  // briefly exposed the new hashes through old routing. Rotate once more after
  // the fixed route has propagated so even a client that hit that transition
  // receives a fresh, safe module URL.
  root.dataset.launchRoutingRevision = "2";

  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
