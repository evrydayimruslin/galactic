import React from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./App";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Launch app root not found");
}

// A tiny, observable boot sentinel helps deployment smoke distinguish a module
// that actually executed from an HTML shell whose hashed asset failed to load.
// Keep the value stable; changing this line also intentionally rotates the
// content-hashed entry asset after cache-routing fixes.
root.dataset.launchClient = "booted";

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
