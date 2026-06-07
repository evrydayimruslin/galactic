// Ultralight Layout — Complete Rewrite
// World-class light-mode UI with white/black monochrome design language

export function getLayoutHTML(options: {
  title?: string;
  activeAppId?: string;
  initialView: "home" | "dashboard" | "app" | "leaderboard" | "profile";
  appCode?: string;
  appName?: string;
  embed?: boolean;
  /** Which dashboard section to show initially (capabilities, billing, keys). Defaults to capabilities. */
  dashSection?: string;
  /** Profile slug for /u/:slug pages */
  profileSlug?: string;
  /** Server-side feature flag for GPU deployment/runtime surfaces. */
  gpuSupportEnabled?: boolean;
}): string {
  const {
    title = "Ultralight",
    activeAppId,
    initialView,
    appCode,
    appName,
    embed = false,
    profileSlug,
    gpuSupportEnabled = false,
  } = options;
  // Map legacy dashboard sections to new unified capabilities section
  let dashSection = options.dashSection || "capabilities";
  if (dashSection === "library" || dashSection === "marketplace") {
    dashSection = "capabilities";
  }

  const escapedCode = appCode
    ? appCode.replace(/\\\\/g, "\\\\\\\\").replace(/\`/g, "\\\\\`").replace(
      /\\$/g,
      "\\\\\\$",
    )
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Ultralight</title>
  <meta name="description" content="Deploy tools that existing agents can install, run, compose, and pay for with Light.">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%230a0a0a'/%3E%3Cstop offset='100%25' stop-color='%23333333'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M6 4 L6 22 Q6 28 12 28 L12 28 L12 4 L17 4 L17 28 Q17 28 20 28 Q26 28 26 22 L26 4 L21 4 L21 22 Q21 24 20 24 L12 24 Q10.5 24 10.5 22 L10.5 4 Z' fill='url(%23g)'/%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* ============================================
       CSS RESET
       ============================================ */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      -webkit-font-smoothing: auto;
      -moz-osx-font-smoothing: auto;
      text-rendering: optimizeLegibility;
      scroll-behavior: smooth;
      overscroll-behavior: none;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      line-height: 1.6;
      color: var(--text-primary);
      background: var(--bg-base);
      min-height: 100vh;
      overflow-x: hidden;
    }

    a { color: inherit; text-decoration: none; }
    button { font-family: inherit; cursor: pointer; border: none; background: none; }
    input, textarea, select { font-family: inherit; }
    img, svg { display: block; max-width: 100%; }
    ul, ol { list-style: none; }

    /* ============================================
       CSS VARIABLES — DESIGN TOKENS
       ============================================ */
    :root {
      /* Background — white/light monochrome */
      --bg-base: #ffffff;
      --bg-raised: #fafafa;
      --bg-overlay: #ffffff;
      --bg-hover: rgba(0,0,0,0.04);
      --bg-active: rgba(0,0,0,0.06);
      --bg-subtle: rgba(0,0,0,0.02);

      /* Borders — subtle grays */
      --border: rgba(0,0,0,0.08);
      --border-strong: rgba(0,0,0,0.15);
      --border-focus: rgba(0,0,0,0.4);

      /* Text — black monochrome */
      --text-primary: #0a0a0a;
      --text-secondary: #555;
      --text-muted: #999;
      --text-inverse: #ffffff;

      /* Accent — black monochrome (no blue) */
      --accent: #0a0a0a;
      --accent-hover: #333;
      --accent-soft: rgba(0,0,0,0.06);
      --accent-text: #0a0a0a;

      /* Semantic */
      --success: #22c55e;
      --success-soft: rgba(34,197,94,0.1);
      --error: #ef4444;
      --error-soft: rgba(239,68,68,0.08);
      --warning: #f59e0b;
      --warning-soft: rgba(245,158,11,0.08);

      /* Spacing scale */
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-10: 40px;
      --space-12: 48px;
      --space-16: 64px;
      --space-20: 80px;

      /* Radius */
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --radius-full: 9999px;

      /* Shadows — subtle light-mode shadows */
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 30px rgba(0,0,0,0.1);
      --shadow-xl: 0 16px 50px rgba(0,0,0,0.12);
      --shadow-glow: 0 0 0 3px rgba(0,0,0,0.06);

      /* Typography */
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;

      /* Z-index scale */
      --z-dropdown: 100;
      --z-sticky: 200;
      --z-overlay: 300;
      --z-modal: 400;
      --z-toast: 500;
      --z-tooltip: 600;

      /* Transitions */
      --transition-fast: 120ms ease;
      --transition-base: 200ms ease;
      --transition-slow: 300ms ease;

      /* Layout */
      --nav-height: 64px;
      --content-max: 1200px;
      --content-narrow: 720px;
    }

    /* ============================================
       TYPOGRAPHY SYSTEM
       ============================================ */
    .text-display {
      font-size: 48px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.03em;
    }

    .text-h1 {
      font-size: 32px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.02em;
    }

    .text-h2 {
      font-size: 24px;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -0.015em;
    }

    .text-h3 {
      font-size: 18px;
      font-weight: 600;
      line-height: 1.4;
      letter-spacing: -0.01em;
    }

    .text-body {
      font-size: 14px;
      font-weight: 400;
      line-height: 1.6;
    }

    .text-body-lg {
      font-size: 16px;
      font-weight: 400;
      line-height: 1.6;
    }

    .text-small {
      font-size: 13px;
      font-weight: 400;
      line-height: 1.5;
    }

    .text-caption {
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      letter-spacing: 0.01em;
    }

    .text-mono {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 400;
    }

    .text-secondary { color: var(--text-secondary); }
    .text-muted { color: var(--text-muted); }
    .text-accent { color: var(--accent-text); }

    /* ============================================
       LAYOUT — TOP NAV + MAIN CONTENT
       ============================================ */
    .app-wrapper {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* Top Navigation */
    .top-nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: var(--z-sticky);
      height: var(--nav-height);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 var(--space-6);
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .nav-left {
      display: flex;
      align-items: center;
      gap: var(--space-6);
    }

    .nav-logo {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      font-weight: 600;
      font-size: 15px;
      color: var(--text-primary);
      cursor: pointer;
      transition: opacity var(--transition-fast);
    }

    .nav-logo:hover { opacity: 0.8; }

    .nav-links {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .nav-link {
      padding: var(--space-2) var(--space-3);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      border-radius: var(--radius-sm);
      transition: all var(--transition-fast);
    }

    .nav-link:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .nav-link.active {
      color: var(--text-primary);
      background: var(--bg-active);
    }

    .nav-right {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    /* Main Content */
    .main-content {
      flex: 1;
      width: 100%;
      max-width: var(--content-max);
      margin: 0 auto;
      padding: var(--space-8) var(--space-6);
      padding-top: calc(var(--nav-height) + var(--space-12));
    }

    .main-content.narrow {
      max-width: var(--content-narrow);
    }

    .main-content.full {
      max-width: 100%;
    }

    /* ============================================
       BUTTON STYLES
       ============================================ */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      padding: 0 var(--space-4);
      height: 36px;
      font-size: 13px;
      font-weight: 500;
      border-radius: var(--radius-md);
      transition: all var(--transition-fast);
      white-space: nowrap;
      user-select: none;
      position: relative;
      overflow: hidden;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .btn-sm {
      height: 30px;
      padding: 0 var(--space-3);
      font-size: 12px;
      border-radius: var(--radius-sm);
    }

    .btn-lg {
      height: 42px;
      padding: 0 var(--space-6);
      font-size: 14px;
      border-radius: var(--radius-lg);
    }

    .btn-icon {
      width: 36px;
      height: 36px;
      padding: 0;
      border-radius: var(--radius-md);
    }

    .btn-icon.sm {
      width: 30px;
      height: 30px;
    }

    /* Primary */
    .btn-primary {
      background: var(--accent);
      color: white;
      border: 1px solid transparent;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
      box-shadow: var(--shadow-glow);
    }

    .btn-primary:active {
      transform: scale(0.98);
    }

    /* Secondary */
    .btn-secondary {
      background: var(--bg-raised);
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
      border-color: rgba(0,0,0,0.2);
    }

    .btn-secondary:active {
      background: var(--bg-active);
    }

    /* Ghost */
    .btn-ghost {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid transparent;
    }

    .btn-ghost:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .btn-ghost:active {
      background: var(--bg-active);
    }

    /* Danger */
    .btn-danger {
      background: var(--error-soft);
      color: var(--error);
      border: 1px solid transparent;
    }

    .btn-danger:hover {
      background: rgba(239,68,68,0.2);
    }

    /* ============================================
       CARD STYLES
       ============================================ */
    .card {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      transition: all var(--transition-base);
    }

    .card-interactive:hover {
      border-color: var(--border-strong);
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }

    .card-interactive:active {
      transform: translateY(0);
    }

    .card-header {
      padding: var(--space-5) var(--space-5) 0;
    }

    .card-body {
      padding: var(--space-5);
    }

    .card-footer {
      padding: var(--space-4) var(--space-5);
      border-top: 1px solid var(--border);
      background: var(--bg-subtle);
    }

    .card-compact .card-body {
      padding: var(--space-4);
    }

    /* App Card */
    .app-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      cursor: pointer;
    }

    .app-card .app-card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .app-card .app-card-desc {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .app-card .app-card-meta {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      font-size: 12px;
      color: var(--text-muted);
    }

    /* ============================================
       INPUT / FORM STYLES
       ============================================ */
    .input {
      width: 100%;
      height: 36px;
      padding: 0 var(--space-3);
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-base);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      transition: all var(--transition-fast);
      outline: none;
    }

    .input:hover {
      border-color: rgba(0,0,0,0.2);
    }

    .input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    .input::placeholder {
      color: var(--text-muted);
    }

    .input-lg {
      height: 42px;
      padding: 0 var(--space-4);
      font-size: 14px;
    }

    textarea.input {
      height: auto;
      min-height: 80px;
      padding: var(--space-3);
      resize: vertical;
      line-height: 1.5;
    }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .input-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .input-hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    .input-error {
      border-color: var(--error) !important;
      box-shadow: 0 0 0 3px var(--error-soft) !important;
    }

    /* App management form classes */
    .section-card {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      margin-bottom: var(--space-4);
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: var(--space-4);
    }

    .trust-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-4);
    }

    .trust-card-header .section-title {
      margin-bottom: 0;
    }

    .trust-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border: 1px solid var(--border);
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      white-space: nowrap;
    }

    .trust-status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .trust-status.ok {
      color: var(--success);
      border-color: rgba(34, 197, 94, 0.25);
      background: var(--success-soft);
    }

    .trust-status.ok::before {
      background: var(--success);
    }

    .trust-status.warn {
      color: var(--warning);
      border-color: rgba(245, 158, 11, 0.25);
      background: var(--warning-soft);
    }

    .trust-status.warn::before {
      background: var(--warning);
    }

    .trust-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-3);
      margin-bottom: var(--space-4);
    }

    .trust-field {
      min-width: 0;
      padding: var(--space-3);
      border: 1px solid var(--border);
      background: var(--bg-base);
      border-radius: var(--radius-md);
    }

    .trust-field-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .trust-field-value {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      font-size: 13px;
      color: var(--text-primary);
    }

    .trust-field-value code {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .trust-copy-btn {
      flex: 0 0 auto;
      padding: 2px 6px;
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .trust-copy-btn:hover {
      color: var(--text-primary);
      border-color: var(--border-strong);
    }

    .trust-chip-row,
    .marketplace-trust-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .trust-chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border: 1px solid var(--border);
      background: var(--bg-base);
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.5;
      white-space: nowrap;
    }

    .trust-note {
      margin-top: var(--space-3);
      padding-top: var(--space-3);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
    }

    .form-label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .form-input,
    .input-field {
      width: 100%;
      height: 36px;
      padding: 0 var(--space-3);
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-base);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      transition: all var(--transition-fast);
      outline: none;
    }

    .form-input:hover,
    .input-field:hover { border-color: rgba(0,0,0,0.2); }

    .form-input:focus,
    .input-field:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

    .form-input::placeholder,
    .input-field::placeholder { color: var(--text-muted); }

    select.form-input,
    select.input-field { cursor: pointer; }

    .form-input-sm {
      height: 32px;
      font-size: 12px;
      padding: 0 var(--space-2);
    }

    /* Search input */
    .search-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-input-wrapper svg {
      position: absolute;
      left: var(--space-3);
      width: 16px;
      height: 16px;
      color: var(--text-muted);
      pointer-events: none;
    }

    .search-input-wrapper .input {
      padding-left: 36px;
    }

    /* ============================================
       TOAST NOTIFICATIONS
       ============================================ */
    .toast-container {
      position: fixed;
      bottom: var(--space-6);
      right: var(--space-6);
      z-index: var(--z-toast);
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      min-width: 280px;
      max-width: 420px;
      background: var(--bg-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      font-size: 13px;
      color: var(--text-primary);
      pointer-events: auto;
      animation: toast-in 0.3s ease forwards;
    }

    .toast.toast-out {
      animation: toast-out 0.2s ease forwards;
    }

    .toast-success { border-left: 3px solid var(--success); }
    .toast-error   { border-left: 3px solid var(--error); }
    .toast-warning { border-left: 3px solid var(--warning); }
    .toast-info    { border-left: 3px solid var(--accent); }

    .toast-close {
      margin-left: auto;
      padding: var(--space-1);
      color: var(--text-muted);
      cursor: pointer;
      border-radius: var(--radius-sm);
      transition: color var(--transition-fast);
    }

    .toast-close:hover { color: var(--text-primary); }

    @keyframes toast-in {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes toast-out {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to   { opacity: 0; transform: translateY(8px) scale(0.96); }
    }

    /* ============================================
       MODAL / OVERLAY STYLES
       ============================================ */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--z-modal);
      background: rgba(0,0,0,0.3);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
      animation: fade-in 0.2s ease;
    }

    .modal-backdrop.hidden { display: none; }

    .modal {
      width: 100%;
      max-width: 520px;
      max-height: 85vh;
      background: var(--bg-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-xl);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: modal-in 0.25s ease;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-5) var(--space-6);
      border-bottom: 1px solid var(--border);
    }

    .modal-header h2 {
      font-size: 16px;
      font-weight: 600;
    }

    .modal-body {
      padding: var(--space-6);
      overflow-y: auto;
      flex: 1;
    }

    .modal-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-6);
      border-top: 1px solid var(--border);
    }

    @keyframes modal-in {
      from { opacity: 0; transform: scale(0.95) translateY(8px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* ============================================
       AUTH POPUP OVERLAY
       ============================================ */
    .auth-overlay {
      position: fixed;
      inset: 0;
      z-index: var(--z-modal);
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
      animation: fade-in 0.3s ease;
    }

    .auth-overlay.hidden { display: none; }

    .auth-card {
      position: relative;
      width: 100%;
      max-width: 400px;
      background: var(--bg-base);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-xl);
      padding: var(--space-10) var(--space-8);
      text-align: center;
      animation: modal-in 0.3s ease;
    }

    .auth-card h2 {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: var(--space-2);
      letter-spacing: -0.02em;
    }

    .auth-card p {
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: var(--space-8);
      line-height: 1.6;
    }

    .auth-divider {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      margin: var(--space-6) 0;
      color: var(--text-muted);
      font-size: 12px;
    }

    .auth-divider::before,
    .auth-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    .auth-provider-btn {
      width: 100%;
      height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      background: var(--bg-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      transition: all var(--transition-fast);
      cursor: pointer;
      margin-bottom: var(--space-3);
    }

    .auth-provider-btn:hover {
      background: var(--bg-hover);
      border-color: rgba(0,0,0,0.2);
    }

    /* ============================================
       TAB SYSTEM
       ============================================ */
    /* Pill tabs variant */
    .tabs-pill {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-1);
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      width: fit-content;
    }

    .tabs-pill .tab {
      padding: var(--space-2) var(--space-3);
      border-bottom: none;
      border-radius: var(--radius-sm);
      margin-bottom: 0;
    }

    .tabs-pill .tab.active {
      background: var(--bg-raised);
      color: var(--text-primary);
      box-shadow: var(--shadow-sm);
    }

    /* ============================================
       ANIMATIONS & TRANSITIONS
       ============================================ */
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .btn-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle;
    }

    @keyframes slide-up {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes slide-down {
      from { opacity: 0; transform: translateY(-12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes slide-in-right {
      from { opacity: 0; transform: translateX(12px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    @keyframes scale-in {
      from { opacity: 0; transform: scale(0.95); }
      to   { opacity: 1; transform: scale(1); }
    }

    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    .animate-in { animation: slide-up 0.3s ease forwards; }
    .animate-fade { animation: fade-in 0.2s ease forwards; }
    .animate-spin { animation: spin 1s linear infinite; }
    .animate-pulse { animation: pulse 2s ease-in-out infinite; }

    .skeleton {
      background: linear-gradient(90deg, var(--bg-subtle) 25%, var(--bg-hover) 50%, var(--bg-subtle) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s ease-in-out infinite;
      border-radius: var(--radius-md);
    }

    /* Staggered children */
    .stagger > * {
      opacity: 0;
      animation: slide-up 0.3s ease forwards;
    }
    .stagger > *:nth-child(1) { animation-delay: 0ms; }
    .stagger > *:nth-child(2) { animation-delay: 50ms; }
    .stagger > *:nth-child(3) { animation-delay: 100ms; }
    .stagger > *:nth-child(4) { animation-delay: 150ms; }
    .stagger > *:nth-child(5) { animation-delay: 200ms; }
    .stagger > *:nth-child(6) { animation-delay: 250ms; }

    /* ============================================
       CONNECTION STATE MACHINE STYLES
       ============================================ */
    .connection-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-3);
      font-size: 12px;
      font-weight: 500;
      border-radius: var(--radius-full);
      transition: all var(--transition-base);
    }

    .connection-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .connection-badge[data-state="connected"] {
      background: var(--success-soft);
      color: var(--success);
    }
    .connection-badge[data-state="connected"] .connection-dot {
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
    }

    .connection-badge[data-state="connecting"] {
      background: var(--warning-soft);
      color: var(--warning);
    }
    .connection-badge[data-state="connecting"] .connection-dot {
      background: var(--warning);
      animation: pulse 1.5s ease-in-out infinite;
    }

    .connection-badge[data-state="disconnected"] {
      background: var(--bg-active);
      color: var(--text-muted);
    }
    .connection-badge[data-state="disconnected"] .connection-dot {
      background: var(--text-muted);
    }

    .connection-badge[data-state="error"] {
      background: var(--error-soft);
      color: var(--error);
    }
    .connection-badge[data-state="error"] .connection-dot {
      background: var(--error);
    }

    /* ============================================
       LANDING PAGE / HERO STYLES
       ============================================ */
    .hero {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      text-align: left;
      padding: var(--space-20) var(--space-6) var(--space-10);
      max-width: 820px;
      margin: 0 auto;
    }

    .hero h1 {
      font-size: 56px;
      font-weight: 600;
      line-height: 1.05;
      letter-spacing: -0.035em;
      margin-bottom: var(--space-5);
      color: var(--text-primary);
    }

    .hero-actions {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }

    .hero-eyebrow {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-secondary);
      margin-bottom: var(--space-5);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .hero-subcopy {
      max-width: 660px;
      color: var(--text-secondary);
      font-size: 18px;
      line-height: 1.55;
      margin-bottom: var(--space-6);
    }

    .hero-secondary-link {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 0 var(--space-5);
      color: var(--text-primary);
      border: 1px solid var(--border);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
    }

    .hero-secondary-link:hover {
      background: var(--bg-hover);
    }

    .hero-market-strip {
      width: 100%;
      margin-top: var(--space-10);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }

    .hero-market-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-4);
      align-items: center;
      min-height: 44px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }

    .hero-market-row:last-child {
      border-bottom: none;
    }

    .hero-market-title {
      min-width: 0;
      color: var(--text-primary);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hero-market-meta {
      color: var(--text-muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-4);
      margin-top: var(--space-16);
      width: 100%;
      max-width: 900px;
    }

    .hero-stat {
      text-align: center;
      padding: var(--space-6);
    }

    .hero-stat .stat-value {
      font-size: 36px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }

    .hero-stat .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: var(--space-1);
    }

    /* Code showcase on landing */
    .code-showcase {
      width: 100%;
      max-width: 640px;
      margin: var(--space-12) auto 0;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .code-showcase-header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
    }

    .code-showcase-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--bg-active);
    }

    .code-showcase pre {
      padding: var(--space-5);
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.7;
      color: var(--text-secondary);
      overflow-x: auto;
    }

    /* ============================================
       DASHBOARD STYLES
       ============================================ */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: var(--space-16) var(--space-8);
      color: var(--text-muted);
    }

    .empty-state svg {
      width: 48px;
      height: 48px;
      margin-bottom: var(--space-4);
      opacity: 0.4;
    }

    .empty-state h3 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: var(--space-2);
    }

    .empty-state p {
      font-size: 14px;
      max-width: 360px;
      margin-bottom: var(--space-6);
    }

    .shell-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      padding: var(--space-8) var(--space-5);
      text-align: center;
      color: var(--text-muted);
    }

    .shell-state.shell-state-compact {
      padding: var(--space-6) var(--space-4);
    }

    .shell-state-icon {
      width: 36px;
      height: 36px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-hover);
      color: var(--text-secondary);
    }

    .shell-state-empty .shell-state-icon {
      background: var(--bg-subtle);
      color: var(--text-muted);
    }

    .shell-state-error .shell-state-icon {
      background: var(--error-soft);
      color: var(--error);
    }

    .shell-state-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .shell-state-desc {
      font-size: 13px;
      line-height: 1.5;
      max-width: 360px;
      color: var(--text-muted);
    }

    /* ============================================
       APP LIST STYLES (replaces app-grid)
       ============================================ */
    .app-list {
      display: flex;
      flex-direction: column;
    }

    .app-row {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-3);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .app-row:first-child {
      border-top: none;
    }

    .app-row:hover {
      background: var(--bg-hover);
    }

    .app-row-emoji {
      font-size: 20px;
      width: 32px;
      text-align: center;
      flex-shrink: 0;
    }

    .app-row-info {
      flex: 1;
      min-width: 0;
    }

    .app-row-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .app-row-version {
      font-size: 11px;
      padding: 1px 6px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 500;
    }

    .app-row-fn-count {
      font-size: 11px;
      padding: 1px 6px;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-weight: 500;
    }

    .app-row-desc {
      font-size: 13px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    /* ============================================
       SETTINGS SIDEBAR LAYOUT
       ============================================ */
    .settings-layout {
      display: flex;
      gap: var(--space-8);
      min-height: 60vh;
    }

    .settings-sidebar {
      width: 200px;
      flex-shrink: 0;
      position: fixed;
      top: calc(var(--nav-height) + var(--space-8));
      align-self: flex-start;
    }

    .settings-sidebar-item {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-3);
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
      border-left: 2px solid transparent;
    }

    .settings-sidebar-item:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .settings-sidebar-item.active {
      color: var(--text-primary);
      font-weight: 600;
      border-left-color: var(--accent);
      background: var(--bg-subtle);
    }

    .settings-content {
      flex: 1;
      min-width: 0;
      margin-left: calc(200px + var(--space-8));
    }

    .settings-panel {
      animation: fade-in 0.15s ease;
    }

    .settings-sidebar-back {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      font-size: 13px;
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);
      margin-bottom: var(--space-3);
      border-left: 2px solid transparent;
    }

    .settings-sidebar-back:hover {
      color: var(--text-primary);
    }

    .nav-copy-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      background: var(--bg-hover);
      border: none;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .nav-copy-btn:hover {
      background: var(--text-primary);
      color: var(--bg-base);
    }

    .app-overview-header {
      margin-bottom: var(--space-6);
      padding-bottom: var(--space-6);
      border-bottom: 1px solid var(--border);
    }

    .app-overview-header h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: var(--space-2);
    }

    .app-panel-name {
      font-size: 22px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }

    .app-section-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-muted);
      margin-top: var(--space-1);
      margin-bottom: var(--space-5);
    }

    .app-overview-meta {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .app-overview-meta .meta-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    /* ============================================
       MARKETPLACE STYLES
       ============================================ */
    .marketplace-search {
      width: 100%;
      padding: var(--space-2) var(--space-3);
      font-size: 13px;
      border: 1px solid var(--border);
      border-radius: 0;
      background: var(--bg-base);
      color: var(--text-primary);
      outline: none;
      transition: border-color var(--transition-fast);
    }

    .marketplace-search:focus {
      border-color: var(--text-primary);
    }

    .marketplace-search::placeholder {
      color: var(--text-tertiary);
    }

    .marketplace-filters {
      display: flex;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }

    .marketplace-filter {
      padding: var(--space-1) var(--space-3);
      font-size: 12px;
      border: 1px solid var(--border);
      border-radius: 0;
      background: var(--bg-base);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .marketplace-filter:hover {
      border-color: var(--text-primary);
      color: var(--text-primary);
    }

    .marketplace-filter.active {
      background: var(--text-primary);
      color: var(--bg-base);
      border-color: var(--text-primary);
    }

    .marketplace-results {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      margin-top: var(--space-4);
    }

    .market-list-link {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      text-decoration: none;
      color: inherit;
      transition: background var(--transition-fast);
    }
    .market-list-link:hover {
      background: var(--bg-raised);
    }

    .marketplace-card {
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--border);
      background: var(--bg-base);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .marketplace-card:hover {
      border-color: var(--text-primary);
    }

    .marketplace-card-header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-2);
      position: relative;
    }

    .marketplace-heart {
      position: absolute;
      right: 0;
      top: 0;
      cursor: pointer;
      padding: 2px;
      color: var(--border);
      transition: color 0.15s ease;
    }
    .marketplace-heart:hover {
      color: var(--text-tertiary);
    }
    .marketplace-heart.saved {
      color: #e06b6b;
    }
    .marketplace-heart.saved:hover {
      color: #c55;
    }

    .offers-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 1;
    }
    .offers-popup {
      background: #fff;
      border: 1px solid var(--border);
      width: 460px;
      max-width: 94vw;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
      opacity: 1;
      position: relative;
      z-index: 100001;
    }
    .offers-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    .offers-popup-header h3 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0;
    }
    .offers-popup-close {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      color: var(--text-primary);
      font-size: 18px;
      line-height: 1;
    }
    .offers-popup-body {
      padding: 20px;
    }
    .offers-price-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .offers-price-col {
      flex: 1;
    }
    .offers-ask-label {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    .offers-ask-price {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }
    .offers-ask-note {
      font-size: 13px;
      color: var(--text-primary);
      margin-bottom: 16px;
      font-style: italic;
    }
    .offers-buynow-btn {
      display: block;
      width: 100%;
      padding: 10px 0;
      background: var(--text-primary);
      color: var(--bg-primary);
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 12px;
      text-align: center;
      letter-spacing: 0.01em;
      transition: opacity 0.15s;
    }
    .offers-buynow-btn:hover {
      opacity: 0.85;
    }
    .offers-bids-section {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
    }
    .offers-bids-title {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-primary);
      margin-bottom: 10px;
    }
    .offers-bid-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .offers-bid-row:last-child {
      border-bottom: none;
    }
    .offers-bid-amount {
      font-weight: 600;
      color: var(--text-primary);
      min-width: 72px;
    }
    .offers-bid-info {
      flex: 1;
      color: var(--text-primary);
      margin-left: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .offers-bid-time {
      color: var(--text-primary);
      font-size: 11px;
      margin-left: 12px;
      white-space: nowrap;
    }
    .offers-bid-cancel {
      margin-left: 12px;
      background: none;
      border: 1px solid var(--text-primary);
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      color: var(--text-primary);
    }
    .offers-bid-form {
      margin-bottom: 0;
    }
    .offers-bid-amount-row {
      display: flex;
      align-items: center;
      border: 1px solid var(--border);
      margin-bottom: 8px;
      background: var(--bg-primary);
    }
    .offers-bid-amount-row:focus-within {
      border-color: var(--text-primary);
    }
    .offers-bid-currency {
      padding: 0 0 0 12px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      pointer-events: none;
      user-select: none;
    }
    .offers-bid-input {
      flex: 1;
      padding: 10px 12px;
      border: none;
      background: transparent;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      color: var(--text-primary);
    }
    .offers-bid-input-msg {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid var(--border);
      background: var(--bg-primary);
      font-size: 13px;
      font-family: inherit;
      outline: none;
      margin-bottom: 10px;
      color: var(--text-primary);
    }
    .offers-bid-input-msg:focus {
      border-color: var(--text-primary);
    }
    .offers-bid-input::placeholder,
    .offers-bid-input-msg::placeholder {
      color: var(--text-muted);
    }
    .offers-bid-balance {
      font-size: 11px;
      color: var(--text-primary);
      margin-bottom: 12px;
    }
    .offers-bid-submit {
      display: block;
      width: 100%;
      padding: 10px 0;
      background: var(--text-primary);
      color: var(--bg-primary);
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
      text-align: center;
      letter-spacing: 0.01em;
    }
    .offers-bid-submit:hover {
      opacity: 0.85;
    }
    .offers-bid-submit:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .offers-no-bids {
      font-size: 13px;
      color: var(--text-primary);
      padding: 8px 0;
    }
    .offers-your-bid {
      background: var(--bg-secondary);
      padding: 10px 12px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .offers-btn-outline {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 36px;
      padding: 0 var(--space-4);
      background: none;
      border: 1px solid var(--text-primary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      color: var(--text-primary);
      white-space: nowrap;
    }
    .offers-login-msg {
      font-size: 13px;
      color: var(--text-primary);
      text-align: center;
      padding: 12px 0;
    }

    .marketplace-card-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .marketplace-badge {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 1px 6px;
      border: 1px solid var(--border);
      color: var(--text-tertiary);
    }

    .marketplace-card-desc {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .marketplace-stats {
      display: flex;
      gap: var(--space-3);
      margin-top: var(--space-2);
      font-size: 11px;
      color: var(--text-tertiary);
    }

    .marketplace-commerce-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      margin-top: var(--space-2);
      padding-top: var(--space-2);
      border-top: 1px solid var(--border);
      font-size: 12px;
    }

    .marketplace-price {
      min-width: 0;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .marketplace-commerce-chip {
      flex: 0 0 auto;
      max-width: 120px;
      padding: 1px 6px;
      border: 1px solid var(--border);
      color: var(--text-tertiary);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .marketplace-commerce-chip.buy {
      border-color: var(--success);
      color: var(--success);
    }

    .marketplace-trust-row {
      margin-top: var(--space-2);
      gap: 6px;
    }

    .marketplace-trust-row .trust-status {
      padding: 1px 6px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .marketplace-trust-text {
      font-size: 11px;
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .marketplace-section {
      margin-bottom: var(--space-6);
    }

    .marketplace-section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: var(--space-3);
    }

    .marketplace-section-grid {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .marketplace-card.expanded {
      border-color: var(--text-primary);
    }

    .marketplace-card-detail {
      margin-top: var(--space-3);
      padding-top: var(--space-3);
      border-top: 1px solid var(--border);
    }

    .marketplace-card-full-desc {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: var(--space-3);
    }

    .marketplace-card-functions {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.7;
      margin-bottom: var(--space-3);
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .marketplace-fn-item {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
    }
    .marketplace-fn-name {
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
    }
    .marketplace-fn-desc {
      color: var(--text-muted);
    }

    /* ============================================
       APP DETAIL VIEW STYLES
       ============================================ */
    .endpoint-display {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .endpoint-display:hover {
      border-color: var(--border-strong);
      color: var(--text-primary);
    }

    .function-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .function-card {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      transition: border-color var(--transition-fast);
    }

    .function-card:hover {
      border-color: var(--border-strong);
    }

    .function-card .fn-name {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 600;
      color: var(--accent-text);
      margin-bottom: var(--space-2);
    }

    .function-card .fn-desc {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: var(--space-3);
      line-height: 1.5;
    }

    .function-card .fn-params {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .param-tag {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      padding: 2px var(--space-2);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
    }

    .param-tag .param-required {
      color: var(--warning);
    }

    /* App overview function items */
    .function-item {
      background: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-3) var(--space-4);
      transition: border-color var(--transition-fast);
    }
    .function-item:hover { border-color: var(--border-strong); }

    .function-name {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 600;
      color: var(--accent-text);
      margin-bottom: var(--space-1);
    }
    .function-name code { background: none; padding: 0; font-size: inherit; }

    .function-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .fn-param {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .fn-param-type { color: var(--text-muted); }
    .fn-param-optional { opacity: 0.7; }

    /* Code editor area */
    .code-editor-wrapper {
      position: relative;
      background: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .code-editor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      background: var(--bg-raised);
    }

    .code-editor-header .file-name {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .code-editor textarea {
      width: 100%;
      min-height: 400px;
      padding: var(--space-4);
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-primary);
      background: transparent;
      border: none;
      outline: none;
      resize: vertical;
      tab-size: 2;
    }

    /* ============================================
       PROFILE DROPDOWN STYLES
       ============================================ */
    .profile-trigger {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .profile-trigger:hover {
      background: var(--bg-hover);
    }

    .profile-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent-soft);
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
    }

    .profile-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }

    .profile-dropdown {
      position: absolute;
      top: calc(100% + var(--space-2));
      right: 0;
      z-index: var(--z-dropdown);
      min-width: 220px;
      background: var(--bg-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: var(--space-2);
      animation: slide-down 0.15s ease forwards;
    }

    .profile-dropdown { display: none; }
    .profile-dropdown.open { display: block; }

    .profile-dropdown-item {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-3);
      font-size: 13px;
      color: var(--text-secondary);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .profile-dropdown-item:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .profile-dropdown-item.danger {
      color: var(--error);
    }

    .profile-dropdown-item.danger:hover {
      background: var(--error-soft);
    }

    .profile-dropdown-divider {
      height: 1px;
      background: var(--border);
      margin: var(--space-2) 0;
    }

    .profile-dropdown-header {
      padding: var(--space-2) var(--space-3);
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* ============================================
       CAPABILITIES SECTION
       ============================================ */
    .cap-section {
      max-width: 820px;
      margin: 0 auto;
      padding: var(--space-12) var(--space-6) 0;
    }

    .cap-section-heading {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: var(--space-5);
    }

    .cap-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-5);
    }

    .cap-card {
      border: 1px solid var(--border);
      padding: var(--space-10);
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }

    .cap-card-icon {
      width: 40px;
      height: 40px;
      background: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: var(--space-6);
    }

    .cap-card-title {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      line-height: 1.3;
      margin-bottom: var(--space-3);
    }

    .cap-card-desc {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
      flex: 1;
    }

    .cap-card-visual {
      margin-top: var(--space-6);
    }

    /* Deploy flow */
    .cap-flow {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .cap-flow-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
    }

    .cap-flow-row code {
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-active);
      padding: 2px 8px;
      border: 1px solid var(--border);
    }

    .cap-flow-row .arrow {
      color: var(--text-muted);
    }

    .cap-flow-row .result {
      color: var(--text-muted);
    }

    /* Agent carousel */
    .cap-carousel {
      overflow: hidden;
      mask-image: linear-gradient(to right, transparent, black 5%, black 95%, transparent);
      -webkit-mask-image: linear-gradient(to right, transparent, black 5%, black 95%, transparent);
    }

    .cap-carousel-inner {
      display: flex;
      gap: var(--space-3);
      animation: cap-scroll 18s linear infinite;
      width: max-content;
    }

    .cap-carousel-inner span {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      white-space: nowrap;
      padding: 6px 14px;
      border: 1px solid var(--border);
      background: var(--bg-raised);
    }

    @keyframes cap-scroll {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }

    /* Portable pills */
    .cap-pills {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .cap-pills span {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      padding: 6px 14px;
      background: var(--bg-active);
      border: 1px solid var(--border);
    }

    /* ============================================
       SCROLLBAR STYLES
       ============================================ */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(0,0,0,0.15);
      border-radius: 3px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: rgba(0,0,0,0.25);
    }

    /* Firefox */
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(0,0,0,0.15) transparent;
    }

    /* ============================================
       RESPONSIVE BREAKPOINTS
       ============================================ */
    @media (max-width: 1024px) {
      .hero h1 {
        font-size: 44px;
      }

      .hero-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 768px) {
      :root {
        --nav-height: 52px;
      }

      .top-nav {
        padding: 0 var(--space-4);
      }

      .nav-links {
        display: none;
      }

      .main-content {
        padding: var(--space-5) var(--space-4);
        padding-top: calc(var(--nav-height) + var(--space-8));
      }

      .hero {
        padding: var(--space-12) var(--space-4) var(--space-8);
      }

      .hero h1 {
        font-size: 34px;
      }

      .hero p {
        font-size: 16px;
      }

      .hero-grid {
        grid-template-columns: 1fr;
        gap: var(--space-3);
      }

      .hero-actions {
        flex-direction: column;
        width: 100%;
      }

      .hero-actions .btn {
        width: 100%;
      }

      .hero-secondary-link {
        width: 100%;
        justify-content: center;
      }

      .hero-market-row {
        grid-template-columns: 1fr;
        gap: 2px;
        align-items: start;
        padding: 9px 0;
      }

      .cap-grid {
        grid-template-columns: 1fr;
      }

      .cap-card {
        margin-left: 0;
      }

      .modal {
        max-width: 100%;
        border-radius: var(--radius-lg);
      }

      .toast-container {
        left: var(--space-4);
        right: var(--space-4);
        bottom: var(--space-4);
      }

      .toast {
        min-width: unset;
        max-width: 100%;
      }

      .settings-layout {
        flex-direction: column;
      }

      .settings-sidebar {
        width: 100%;
        position: static;
        display: flex;
        gap: var(--space-1);
        overflow-x: auto;
        border-bottom: 1px solid var(--border);
        padding-bottom: var(--space-2);
        margin-bottom: var(--space-4);
      }

      .settings-sidebar-item {
        border-left: none;
        border-bottom: 2px solid transparent;
        white-space: nowrap;
        padding: var(--space-2) var(--space-3);
      }

      .settings-sidebar-item.active {
        border-left-color: transparent;
        border-bottom-color: var(--accent);
      }

      .settings-content {
        margin-left: 0;
      }

      .nav-copy-btn {
        display: none;
      }

      .settings-sidebar-back {
        display: none;
      }

      .app-overview-header {
        padding-bottom: var(--space-4);
      }
    }

    @media (max-width: 480px) {
      .hero h1 {
        font-size: 28px;
      }

      .text-display {
        font-size: 32px;
      }

      .auth-card {
        padding: var(--space-8) var(--space-5);
      }
    }

    /* ============================================
       UTILITY CLASSES
       ============================================ */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0,0,0,0);
      border: 0;
    }

    .truncate {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .flex { display: flex; }
    .flex-col { flex-direction: column; }
    .items-center { align-items: center; }
    .justify-between { justify-content: space-between; }
    .gap-1 { gap: var(--space-1); }
    .gap-2 { gap: var(--space-2); }
    .gap-3 { gap: var(--space-3); }
    .gap-4 { gap: var(--space-4); }
    .gap-6 { gap: var(--space-6); }
    .gap-8 { gap: var(--space-8); }
    .w-full { width: 100%; }
    .relative { position: relative; }
    .hidden { display: none !important; }
  </style>
  </head>
  <body>

  <!-- ============================================
       TOAST CONTAINER
       ============================================ -->
  <div id="toast-container" class="toast-container"></div>

  <!-- ============================================
       AUTH POPUP OVERLAY
       ============================================ -->
  <div id="authOverlay" class="auth-overlay hidden">
    <div class="auth-card">
      <button id="authCloseBtn" onclick="document.getElementById('authOverlay').classList.add('hidden')" style="position:absolute;top:16px;right:16px;background:none;border:none;color:var(--text-muted);cursor:pointer;padding:8px;font-size:20px;line-height:1;border-radius:var(--radius-sm);transition:background var(--transition-fast);" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='none'" aria-label="Close">&times;</button>
      <div style="display:flex;justify-content:center;margin-bottom:var(--space-6);">
        <svg width="48" height="48" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="authLogoGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#0a0a0a"/>
              <stop offset="100%" stop-color="#333333"/>
            </linearGradient>
          </defs>
          <path d="M6 4 L6 22 Q6 28 12 28 L12 28 L12 4 L17 4 L17 28 Q17 28 20 28 Q26 28 26 22 L26 4 L21 4 L21 22 Q21 24 20 24 L12 24 Q10.5 24 10.5 22 L10.5 4 Z" fill="url(#authLogoGrad)"/>
        </svg>
      </div>
      <h2 style="text-align:center;color:var(--text-primary);font-size:20px;">Log in to give your agent superpowers</h2>
      <div style="margin-bottom:var(--space-6);"></div>
      <button id="googleAuthBtn" class="auth-provider-btn" onclick="window.location.href='/auth/login';">
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </button>
      <p style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:var(--space-4);line-height:1.5;">
        By continuing, you agree to our
        <a href="/terms" style="color:var(--text-secondary);text-decoration:underline;">Terms</a> and
        <a href="/privacy" style="color:var(--text-secondary);text-decoration:underline;">Privacy Policy</a>.
      </p>
    </div>
  </div>

  <!-- ============================================
       TOP NAVIGATION BAR
       ============================================ -->
  <nav class="top-nav"${embed ? ' style="display:none"' : ""}>
    <div class="nav-left">
      <a href="/" id="navLogoLink" class="nav-logo" style="text-decoration:none;font-size:20px;">
        Ultralight
      </a>
    </div>
    <div class="nav-right">
      <!-- Pre-auth nav items (hidden until JS checks auth state) -->
      <div id="navPreAuth" style="display:none;align-items:center;gap:var(--space-2);">
        <button id="navAuthBtn" class="btn btn-primary" style="border-radius:0;height:36px;padding:0 var(--space-5);font-size:14px;" onclick="document.getElementById('authOverlay').classList.remove('hidden')">Dashboard</button>
      </div>
      <!-- Post-auth nav items (hidden until JS checks auth state) -->
      <div id="navPostAuth" class="hidden" style="display:none;align-items:center;gap:var(--space-3);">
        <button id="navCopyInstructionsBtn" class="nav-copy-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copy agent instructions
        </button>
        <div class="relative">
          <div id="profileTrigger" class="profile-trigger">
            <div id="profileAvatar" class="profile-avatar">U</div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div id="profileDropdown" class="profile-dropdown">
            <div id="profileDropdownHeader" class="profile-dropdown-header"><span id="profileEmail" style="font-size:12px;color:var(--text-muted);display:block;margin-top:2px;"></span></div>
            <div class="profile-dropdown-divider"></div>
            <div class="profile-dropdown-item" data-action="dashboard">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              Dashboard
            </div>
            <div class="profile-dropdown-divider"></div>
            <div class="profile-dropdown-item danger" data-action="signout">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Sign Out
            </div>
          </div>
        </div>
      </div>
    </div>
  </nav>

  <!-- ============================================
       MAIN CONTENT AREA
       ============================================ -->
  <main class="main-content">

    <!-- ==========================================
         HOME / LANDING VIEW
         ========================================== -->
    <div id="homeView"${initialView !== "home" ? ' style="display:none;"' : ""}>
      <section class="hero">
        <div class="hero-eyebrow">Ultralight</div>
        <h1>Tools for the agents you already use</h1>
        <p class="hero-subcopy">Connect Claude Code, Codex, Cursor, or any MCP-capable agent once. Deploy tools that inherit auth, Light billing, composability, widgets, and marketplace distribution.</p>
        <div class="hero-actions" style="margin-top:var(--space-4);">
          <button id="heroCTA" class="btn btn-primary btn-lg" style="gap:var(--space-2);border-radius:0;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <span id="heroCTAText">Copy agent instructions</span>
          </button>
          <a class="hero-secondary-link" href="/marketplace">Browse market</a>
        </div>
        <div class="hero-market-strip" aria-label="Marketplace examples">
          <div class="hero-market-row">
            <span class="hero-market-title">Paste install instructions into your agent</span>
            <span class="hero-market-meta">no desktop first</span>
          </div>
          <div class="hero-market-row">
            <span class="hero-market-title">Fund Light before private deploys</span>
            <span class="hero-market-meta">usage-backed</span>
          </div>
          <div class="hero-market-row">
            <span class="hero-market-title">${gpuSupportEnabled ? "Deploy a GPU image pipeline" : "Deploy an image workflow"}</span>
            <span class="hero-market-meta">${gpuSupportEnabled ? "tool runtime" : "agent-ready"}</span>
          </div>
          <div class="hero-market-row">
            <span class="hero-market-title">Open widgets and command cards</span>
            <span class="hero-market-meta">UI surfaces</span>
          </div>
          <div class="hero-market-row">
            <span class="hero-market-title">Acquire an app's revenue stream</span>
            <span class="hero-market-meta">resale market</span>
          </div>
        </div>
      </section>

      <!-- Setup Instructions Block (hidden until authenticated) -->
      <div id="setupBlock" class="setup-block" style="display:none;max-width:640px;margin:var(--space-8) auto 0;background:var(--bg-raised);border:1px solid var(--border-strong);border-radius:var(--radius-lg);padding:var(--space-5);overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
          <span style="font-size:13px;font-weight:500;color:var(--text-secondary);">Paste this into your existing agent:</span>
          <button id="setupCopyBtn" class="btn btn-ghost btn-sm" style="font-size:12px;">Copy</button>
        </div>
        <pre id="setupCode" style="background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--space-4);font-family:var(--font-mono);font-size:13px;line-height:1.6;color:var(--text-secondary);overflow-x:auto;white-space:pre-wrap;word-break:break-all;"></pre>
        <div id="connectionStatus" style="margin-top:var(--space-3);font-size:12px;color:var(--text-muted);"></div>
      </div>

      <!-- Section 1: Agent app economy -->
      <section class="cap-section">
        <div class="cap-section-heading">Launch MVP: latch onto existing agents first</div>
        <div class="cap-grid">
          <!-- Free instant deployments -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div class="cap-card-title">Connect existing agents</div>
            <div class="cap-card-desc">Copy MCP install instructions into the coding agent you already trust. No desktop download is required to start.</div>
            <div class="cap-card-visual">
              <div class="cap-flow">
                <div class="cap-flow-row">
                  <code>.md</code>
                  <span class="arrow">→</span>
                  <span class="result">live url</span>
                </div>
                <div class="cap-flow-row">
                  <code>.ts</code>
                  <span class="arrow">→</span>
                  <span class="result">live mcp server</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Light balance first -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            </div>
            <div class="cap-card-title">Fund Light</div>
            <div class="cap-card-desc">Usage-backed Light balances cover cloud calls and give private deploys a cost floor before expensive infrastructure spins up.</div>
            <div class="cap-card-visual">
              <div class="cap-pills">
                <span>Custom apps</span>
                <span>Skills</span>
                <span>Memories</span>
              </div>
            </div>
          </div>

          <!-- Works with any agent -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
            </div>
            <div class="cap-card-title">Deploy tool surfaces</div>
            <div class="cap-card-desc">Ship MCP, HTTP, markdown${gpuSupportEnabled ? ", GPU-backed" : ""}, widget, and command-card surfaces to agents and web pages.</div>
            <div class="cap-card-visual">
              <div class="cap-carousel">
                <div class="cap-carousel-inner">
                  <span>OpenClaw</span>
                  <span>Claude Code</span>
                  <span>Codex</span>
                  <span>Cursor</span>
                  <span>Perplexity Computer</span>
                  <span>Kimi Code</span>
                  <span>OpenClaw</span>
                  <span>Claude Code</span>
                  <span>Codex</span>
                  <span>Cursor</span>
                  <span>Perplexity Computer</span>
                  <span>Kimi Code</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Granular permissions -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            </div>
            <div class="cap-card-title">Manage tools</div>
            <div class="cap-card-desc">Set per-function pricing, secrets, permissions, trust cards, installs, earnings, bids, and ownership transfer after launch.</div>
          </div>
        </div>
      </section>

      <!-- Section 2: Agent app store -->
      <section class="cap-section" style="padding-top:var(--space-16);">
        <div class="cap-section-heading">Marketplace primitives</div>
        <div class="cap-grid">
          <!-- One connection -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
            </div>
            <div class="cap-card-title">One connection</div>
            <div class="cap-card-desc">No separate auth or payment setup for every app. The platform handles identity, wallet, and execution access.</div>
          </div>

          <!-- Publish and monetize -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            </div>
            <div class="cap-card-title">Usage revenue</div>
            <div class="cap-card-desc">Per-function pricing, Light balances, creator earnings, and payout paths are wired into the same flow.</div>
          </div>

          <!-- One auth for everything -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            </div>
            <div class="cap-card-title">Trust cards</div>
            <div class="cap-card-desc">Listings expose signed manifest state, permissions, required secrets, runtime, and execution receipt readiness.</div>
          </div>

          <!-- One payment for everything -->
          <div class="cap-card">
            <div class="cap-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            </div>
            <div class="cap-card-title">Acquisition market</div>
            <div class="cap-card-desc">Apps can be listed with asks, instant acquisition, open offers, escrowed bids, and public market signals.</div>
          </div>
        </div>
      </section>

      <!-- Closing CTA -->
      <section style="max-width:820px;margin:0 auto;padding:var(--space-20) var(--space-6);text-align:left;">
        <h2 style="font-size:32px;font-weight:600;letter-spacing:-0.035em;line-height:1.15;color:var(--text-primary);margin-bottom:var(--space-8);">Start now.</h2>
        <div style="display:flex;justify-content:flex-start;">
          <button id="bottomCTA" class="btn btn-primary btn-lg" style="gap:var(--space-2);border-radius:0;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <span id="bottomCTAText">Copy agent instructions</span>
          </button>
        </div>
      </section>

      <!-- Footer -->
      <footer style="max-width:820px;margin:0 auto;padding:var(--space-8) var(--space-6);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-muted);">
        <span>&copy; 2026 Ultralight</span>
        <div style="display:flex;gap:var(--space-4);">
          <a href="https://www.npmjs.com/package/ultralightpro" target="_blank" style="color:var(--text-muted);transition:color 0.15s;" onmouseover="this.style.color='var(--text-secondary)'" onmouseout="this.style.color='var(--text-muted)'">SDK Reference</a>
          <a href="https://www.npmjs.com/package/ultralightpro" target="_blank" style="color:var(--text-muted);transition:color 0.15s;" onmouseover="this.style.color='var(--text-secondary)'" onmouseout="this.style.color='var(--text-muted)'">CLI Tool</a>
          <a href="/api" style="color:var(--text-muted);transition:color 0.15s;" onmouseover="this.style.color='var(--text-secondary)'" onmouseout="this.style.color='var(--text-muted)'">API / MCP</a>
        </div>
      </footer>
    </div>

    <!-- ==========================================
         DASHBOARD VIEW
         ========================================== -->
    <div id="dashboardView" style="display:${
    initialView === "dashboard" || initialView === "leaderboard"
      ? "block"
      : "none"
  };">
      <div class="settings-layout">
        <!-- Sidebar -->
        <nav class="settings-sidebar">
          <div class="settings-sidebar-item${
    dashSection === "capabilities" ? " active" : ""
  }" data-dash-section="capabilities">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            Tools
          </div>
          <div class="settings-sidebar-item${
    dashSection === "billing" ? " active" : ""
  }" data-dash-section="billing">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            Wallet
          </div>
          <div class="settings-sidebar-item${
    dashSection === "keys" ? " active" : ""
  }" data-dash-section="keys">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            API Key
          </div>
        </nav>

        <!-- Content Panels -->
        <div class="settings-content">
          <!-- Capabilities Panel (unified Market + Library + Shared) -->
          <section id="dashCapabilitiesPanel" class="settings-panel"${
    dashSection !== "capabilities" ? ' style="display:none;"' : ""
  }>
            <!-- Sub-tab bar -->
            <div class="marketplace-filters" style="margin-bottom:var(--space-4);">
              <button class="marketplace-filter active" data-cap-tab="library">Library</button>
              <button class="marketplace-filter" data-cap-tab="shared">Shared</button>
              <button class="marketplace-filter" data-cap-tab="market">Market</button>
            </div>

            <!-- Search + filters (shared across all sub-tabs) -->
            <div style="display:flex;gap:var(--space-3);align-items:center;margin-bottom:var(--space-4);flex-wrap:wrap;">
              <input id="capSearch" class="marketplace-search" type="text" placeholder="Search tools..." style="flex:1;min-width:200px;margin-bottom:0;">
              <div id="capFiltersBtn" style="position:relative;display:none;">
                <button class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);display:flex;align-items:center;gap:6px;" onclick="document.getElementById('capFiltersDropdown').style.display = document.getElementById('capFiltersDropdown').style.display === 'none' ? 'block' : 'none';">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
                  <span id="capFilterLabel">Filters</span>
                </button>
                <div id="capFiltersDropdown" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;background:var(--bg-base);border:1px solid var(--border);padding:var(--space-3);z-index:50;min-width:200px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                  <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:var(--space-2);">Type</div>
                  <div class="marketplace-filters" style="margin-bottom:var(--space-3);">
                    <button class="marketplace-filter active" data-cap-type="all">All</button>
                    ${gpuSupportEnabled ? '<button class="marketplace-filter" data-cap-type="gpu">GPU</button>' : ''}
                    <button class="marketplace-filter" data-cap-type="apps">MCP</button>
                    <button class="marketplace-filter" data-cap-type="skills">.MD</button>
                  </div>
                  <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:var(--space-2);">Owner</div>
                  <div class="marketplace-filters" style="margin-bottom:0;">
                    <button class="marketplace-filter active" data-cap-owner="all">All</button>
                    <button class="marketplace-filter" data-cap-owner="mine">Mine</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Market sub-tab content (hidden by default) -->
            <div id="capMarketContent" style="display:none;">
              <!-- Ticker tape stats -->
              <div class="cap-carousel" style="margin-bottom:var(--space-6);">
                <div class="cap-carousel-inner" id="marketTicker">
                  <span>Loading market activity...</span>
                </div>
              </div>

              <!-- Two-column: Newly Published + Newly Acquired -->
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-6);margin-bottom:var(--space-8);">
                <div>
                  <h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-3);color:var(--text-primary);">Newly Published</h3>
                  <div style="font-size:11px;color:var(--text-muted);margin-bottom:var(--space-3);">Latest tools shipping</div>
                  <div id="newlyPublishedList" style="display:flex;flex-direction:column;gap:var(--space-2);">
                    <div style="font-size:13px;color:var(--text-muted);padding:var(--space-3) 0;">Loading new publications...</div>
                  </div>
                </div>
                <div>
                  <h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-3);color:var(--text-primary);">Newly Acquired</h3>
                  <div style="font-size:11px;color:var(--text-muted);margin-bottom:var(--space-3);">Latest MCP/markdown acquisitions</div>
                  <div id="newlyAcquiredList" style="display:flex;flex-direction:column;gap:var(--space-2);">
                    <div style="font-size:13px;color:var(--text-muted);padding:var(--space-3) 0;">Loading acquisitions...</div>
                  </div>
                </div>
              </div>

              <!-- Highest Grossing Profiles -->
              <div>
                <h3 style="font-size:14px;font-weight:600;margin-bottom:4px;color:var(--text-primary);">Highest grossing profiles</h3>
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:var(--space-3);">Revenue + acquisitions combined</div>
                <div class="marketplace-filters" style="margin-bottom:var(--space-3);">
                  <button class="marketplace-filter" data-lb-period="1d">1d</button>
                  <button class="marketplace-filter" data-lb-period="7d">7d</button>
                  <button class="marketplace-filter active" data-lb-period="30d">30d</button>
                  <button class="marketplace-filter" data-lb-period="90d">90d</button>
                  <button class="marketplace-filter" data-lb-period="365d">365d</button>
                  <button class="marketplace-filter" data-lb-period="at">AT</button>
                </div>
                <table style="width:100%;font-size:13px;border-collapse:collapse;">
                  <thead>
                    <tr style="border-bottom:1px solid var(--border);text-align:left;">
                      <th style="padding:var(--space-2) var(--space-1);color:var(--text-muted);font-weight:500;font-size:12px;width:36px;">#</th>
                      <th style="padding:var(--space-2) var(--space-1);color:var(--text-muted);font-weight:500;font-size:12px;">Profile</th>
                      <th style="padding:var(--space-2) var(--space-1);color:var(--text-muted);font-weight:500;font-size:12px;">Earnings</th>
                      <th style="padding:var(--space-2) var(--space-1);color:var(--text-muted);font-weight:500;font-size:12px;">Origin</th>
                      <th style="padding:var(--space-2) var(--space-1);color:var(--text-muted);font-weight:500;font-size:12px;">Featured</th>
                    </tr>
                  </thead>
                  <tbody id="leaderboardBody"></tbody>
                </table>
              </div>
            </div>

            <!-- Library sub-tab content (default) -->
            <div id="capLibraryContent">
              <div id="appList" class="app-list"></div>
            </div>

            <!-- Shared sub-tab content (hidden by default) -->
            <div id="capSharedContent" style="display:none;">
              <div id="sharedAppList" class="app-list"></div>
            </div>

            <!-- Search results (shown when searching, hides other content) -->
            <div id="capSearchResults" style="display:none;">
              <div id="capSearchResultsList" class="marketplace-results"></div>
            </div>
          </section>

          <!-- Wallet Panel -->
          <section id="dashBillingPanel" class="settings-panel" style="display:${
    dashSection === "billing" ? "block" : "none"
  };">
            <h2 style="font-size:16px;font-weight:600;margin-bottom:var(--space-4);color:var(--text-primary);">Wallet</h2>
            <div class="marketplace-filters">
              <button class="marketplace-filter active" data-wallet-tab="balance">Balance</button>
              <button class="marketplace-filter" data-wallet-tab="transactions">Transactions</button>
              <button class="marketplace-filter" data-wallet-tab="earnings">Earnings</button>
              <button class="marketplace-filter" data-wallet-tab="offers">Offers</button>
            </div>

            <!-- Balance Tab -->
            <div id="walletBalanceTab" style="margin-top:var(--space-4);">
              <div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
                  <div>
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-1);">Total Light Balance</div>
                    <div id="accountBalance" style="font-size:28px;font-weight:700;color:var(--text-primary);">\\u27260</div>
                  </div>
                  <button class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="loadHostingData()">Refresh</button>
                </div>
                <div id="walletBalanceBreakdown" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-3);"></div>
              </div>

              <div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4);margin-bottom:var(--space-4);">
                  <div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">Add Light</div>
                    <div style="font-size:12px;color:var(--text-muted);line-height:1.5;">External funding enters through wallet payments or bank transfer. Purchased Light is spend-only platform credit.</div>
                  </div>
                  <div id="walletCanonicalRateLabel" style="font-size:12px;color:var(--text-muted);white-space:nowrap;">100 Light = $1 receipt/payout reference</div>
                </div>
                <div id="walletFundingMethods" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--space-3);"></div>
                <div id="walletFundingPolicy" style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:var(--space-3);">Apple Pay and Google Pay fund at 95 Light / $1. Wire transfer funds at 99 Light / $1. 100 Light = $1 is used for receipts, internal cost reference, and payouts.</div>
                <label style="display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--text-muted);line-height:1.45;margin-top:var(--space-3);">
                  <input id="walletTermsAccepted" type="checkbox" style="margin-top:2px;">
                  <span id="walletTermsCopy">I agree that purchased Light is spend-only platform credit and is governed by the <a href="/terms" style="color:var(--text-secondary);text-decoration:underline;">Terms</a>.</span>
                </label>
              </div>

              <div style="background:var(--bg-subtle);border:1px solid var(--border);padding:var(--space-4);font-size:12px;color:var(--text-muted);line-height:1.5;">
                Light cannot be transferred directly between arbitrary accounts. Creator earnings come from platform-mediated app activity and marketplace sales, and only earned Light is eligible for payout.
              </div>
              <div id="walletCloudPolicy" style="background:var(--bg-subtle);border:1px solid var(--border);padding:var(--space-4);font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:var(--space-3);">
                Cloud usage is metered in cloud units and charged as exact fractional Light. Free calls use app-owner sponsorship for infrastructure when available; otherwise the caller needs Light balance to continue.
              </div>

            </div>

            <!-- Transactions Tab -->
            <div id="walletTransactionsTab" style="display:none;margin-top:var(--space-4);">
              <div id="storageChargesSummary"></div>
              <div id="transactionsList" style="font-size:13px;color:var(--text-muted);">Loading transactions...</div>
            </div>

            <!-- Earnings Tab -->
            <div id="walletEarningsTab" style="display:none;margin-top:var(--space-4);">
              <div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:var(--space-3);">Earnings Summary</div>
                <div id="earningsSummary" style="font-size:13px;color:var(--text-muted);">Loading earnings summary...</div>
              </div>

              <div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
                  <div style="font-size:13px;font-weight:600;color:var(--text-primary);">Bank Payouts</div>
                  <span id="connectStatusBadge" style="font-size:11px;padding:2px 8px;border-radius:2px;background:rgba(239,68,68,0.15);color:var(--error);">Not Connected</span>
                </div>
	                <div id="connectSection">
	                  <p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-3);">Set up Stripe Connect to request payouts from creator earnings.</p>
                    <div style="display:flex;gap:var(--space-2);align-items:end;flex-wrap:wrap;">
                      <div style="min-width:120px;">
                        <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Country</label>
                        <input id="connectCountryInput" value="US" maxlength="2" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;text-transform:uppercase;">
                      </div>
	                    <button id="connectBankBtn" class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="startConnectOnboarding()">Set Up Payouts</button>
                    </div>
	                </div>
	                <div id="payoutPolicyCopy" style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:var(--space-3);">Payouts are processed on the first business day of each month. Requests must be submitted at least 21 days before that payout date to be included. Purchased Light cannot be cashed out; only creator earnings are eligible for payout.</div>
	              </div>

              <div id="payoutRequestCard" style="display:none;background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:var(--space-3);">Request Payout</div>
                <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-3);align-items:end;">
                  <div>
                    <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Amount in Light</label>
                    <input type="number" id="withdrawAmountLight" min="5000" step="1" placeholder="5000" oninput="updateWithdrawPreview()" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;">
                  </div>
                  <button id="withdrawBtn" class="btn btn-primary btn-sm" style="border-radius:0;" onclick="showWithdrawModal()">Request</button>
                </div>
                <label style="display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--text-muted);line-height:1.45;margin-top:var(--space-3);">
                  <input id="payoutTermsAccepted" type="checkbox" style="margin-top:2px;">
                  <span id="payoutTermsCopy">I agree that only creator earnings are eligible for payout and that payout timing is governed by the <a href="/terms" style="color:var(--text-secondary);text-decoration:underline;">Terms</a>.</span>
                </label>
                <div id="withdrawPreview" style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:var(--space-3);">Enter an amount to preview USD conversion and Stripe payout fees.</div>
              </div>

              <div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-5);">
                <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:var(--space-3);">Payout History</div>
                <div id="payoutsHistory" style="font-size:13px;color:var(--text-muted);">Loading payout history...</div>
              </div>
            </div>

            <!-- Offers Tab -->
            <div id="walletOffersTab" style="display:none;margin-top:var(--space-4);">
              <div id="offersIncoming" style="margin-bottom:var(--space-6);"></div>
              <div id="offersOutgoing"></div>
            </div>
          </section>

          <!-- API Key Panel -->
          <section id="dashKeysPanel" class="settings-panel" style="display:${
    dashSection === "keys" ? "block" : "none"
  };">
            <h2 style="font-size:16px;font-weight:600;margin-bottom:var(--space-4);color:var(--text-primary);">API Key</h2>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-4);">Use this key to connect agents and CLI tools to your account.</p>
            <div id="apiKeyDisplay" style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-4);margin-bottom:var(--space-3);">
              <div style="display:flex;align-items:center;gap:var(--space-3);">
                <code id="apiKeyValue" style="flex:1;font-size:13px;color:var(--text-primary);letter-spacing:0.5px;word-break:break-all;">Loading API key...</code>
                <button id="apiKeyCopyBtn" class="btn btn-primary btn-sm" style="border-radius:0;" onclick="copyApiKey()">Copy</button>
              </div>
              <div style="margin-top:var(--space-3);font-size:11px;color:var(--text-muted);">
                Created <span id="apiKeyCreated">&mdash;</span> &middot; Last used <span id="apiKeyLastUsed">never</span>
              </div>
            </div>
            <button id="apiKeyRegenBtn" class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);color:var(--text-secondary);" onclick="regenerateApiKey()">Regenerate Key</button>
            <p style="font-size:11px;color:var(--text-muted);margin-top:var(--space-2);">Regenerating creates a new key and revokes the current one. Connected agents will need to re-authenticate.</p>

            <!-- Profile Settings -->
            <div style="margin-top:var(--space-8);padding-top:var(--space-6);border-top:1px solid var(--border);">
              <h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-4);color:var(--text-primary);">Profile</h3>

              <div style="margin-bottom:var(--space-4);">
                <label style="font-size:13px;font-weight:500;display:block;margin-bottom:var(--space-2);color:var(--text-secondary);">Country</label>
                <select id="profileCountrySelect" style="padding:6px 10px;border:1px solid var(--border);font-size:13px;background:var(--bg-base);color:var(--text-primary);min-width:200px;">
                  <option value="">Not set</option>
                </select>
              </div>

              <div style="margin-bottom:var(--space-4);">
                <label style="font-size:13px;font-weight:500;display:block;margin-bottom:var(--space-2);color:var(--text-secondary);">Featured Capability</label>
                <select id="profileFeaturedSelect" style="padding:6px 10px;border:1px solid var(--border);font-size:13px;background:var(--bg-base);color:var(--text-primary);min-width:300px;">
                  <option value="">None</option>
                </select>
              </div>

              <button id="profileSettingsSaveBtn" class="btn btn-primary btn-sm" style="border-radius:0;" onclick="saveProfileSettings()">Save Profile</button>
              <span id="profileSettingsSaved" style="font-size:12px;color:var(--success);margin-left:var(--space-2);display:none;">Saved!</span>
            </div>

            <!-- BYOK: Bring Your Own Key -->
            <div style="margin-top:var(--space-8);padding-top:var(--space-6);border-top:1px solid var(--border);">
              <h3 style="font-size:16px;font-weight:600;margin-bottom:var(--space-1);">AI Keys (Bring Your Own)</h3>
              <p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-4);">Use your own provider keys for inference. BYOK calls skip Light debits; Light balance remains available through OpenRouter when no BYOK route is selected.</p>

              <div id="byokProviderList" style="display:flex;flex-direction:column;gap:var(--space-2);">
                <div style="font-size:12px;color:var(--text-muted);">Loading saved AI keys...</div>
              </div>

              <div style="margin-top:var(--space-4);">
                <button class="btn btn-sm" style="border:1px solid var(--border);" onclick="addByokKey()">+ Add API Key</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- ==========================================
         APP DETAIL VIEW
         ========================================== -->
    <div id="appView" style="display:${
    initialView === "app" ? "block" : "none"
  };">
      <div class="settings-layout">
        <!-- App Sidebar -->
        <nav class="settings-sidebar">
          <div class="settings-sidebar-back" id="appBackBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </div>
          <div class="settings-sidebar-item active" data-app-section="overview">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            Overview
          </div>
          <div class="settings-sidebar-item" data-app-section="permissions">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
            Permissions
          </div>
          <div class="settings-sidebar-item" data-app-section="environment">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Environment
          </div>
          <div class="settings-sidebar-item" data-app-section="payments">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            Payments
          </div>
          <div class="settings-sidebar-item" data-app-section="logs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            Data
          </div>
          <div class="settings-sidebar-item" data-app-section="offers">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>
            Offers
          </div>
          <div class="settings-sidebar-item" data-app-section="store-listing">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            App Store
          </div>
        </nav>

        <!-- Content Panels -->
        <div class="settings-content">
          <!-- Overview Panel -->
          <section id="appOverviewPanel" class="settings-panel">
            <div id="appOverviewHeader" class="app-overview-header"></div>
            <h2 class="app-section-title">Overview</h2>
            <div id="appGeneralSettings"></div>
            <div id="appTrustSection"></div>
            <div id="appFunctionsSection"></div>
            <div id="skillsContent"></div>
          </section>

          <!-- Permissions Panel -->
          <section id="appPermissionsPanel" class="settings-panel" style="display:none;">
            <div class="app-panel-name"></div>
            <h2 class="app-section-title">Permissions</h2>
            <div id="appVisibilitySection"></div>
            <div id="permissionsContent"></div>
          </section>

          <!-- Environment Panel -->
          <section id="appEnvironmentPanel" class="settings-panel" style="display:none;">
            <div class="app-panel-name"></div>
            <h2 class="app-section-title">Environment</h2>
            <div id="databaseContent" style="display:none;"></div>
            <div id="envVarsContent"></div>
          </section>

          <!-- Payments Panel -->
          <section id="appPaymentsPanel" class="settings-panel" style="display:none;">
            <div class="app-panel-name"></div>
            <h2 class="app-section-title">Payments</h2>
            <div id="appPricingSection"></div>
            <div id="revenueSection" style="margin-top:var(--space-6);"></div>
          </section>

          <!-- Data Panel -->
          <section id="appLogsPanel" class="settings-panel" style="display:none;">
            <div class="app-panel-name"></div>
            <h2 class="app-section-title">Data</h2>
            <div id="appLogsContent"></div>
            <div id="appHealthSection" style="margin-top:var(--space-6);"></div>
          </section>

          <!-- Offers Panel — incoming/outgoing bids on this app -->
          <section id="appOffersPanel" class="settings-panel" style="display:none;">
            <div class="app-panel-name"></div>
            <h2 class="app-section-title">Offers</h2>
            <div id="appOffersContent"></div>
            <div id="appOffersBids" style="margin-top:var(--space-6);"></div>
            <div id="appOffersHistory" style="margin-top:var(--space-6);"></div>
          </section>

          <!-- App Store Listing Panel — public-facing store page editor (Phase 2) -->
          <section id="appStoreListingPanel" class="settings-panel" style="display:none;">
            <div class="app-panel-name"></div>
            <h2 class="app-section-title">App Store Listing</h2>
            <div id="appStoreListingContent"></div>
          </section>
        </div>
      </div>
    </div>

  <!-- ============================================
       MODALS
       ============================================ -->

  <!-- Delete Confirmation Modal -->
  <div id="deleteConfirmModal" class="modal-backdrop hidden">
    <div class="modal" style="max-width:420px;">
      <div class="modal-header">
        <h2>Delete App</h2>
        <button class="modal-close" onclick="document.getElementById('deleteConfirmModal').classList.add('hidden')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:14px;color:var(--text-secondary);line-height:1.6;">Are you sure you want to delete this app? This action cannot be undone. All data, call history, and permissions will be permanently removed.</p>
      </div>
      <div class="modal-footer">
        <button id="deleteCancel" class="btn btn-ghost btn-sm" onclick="document.getElementById('deleteConfirmModal').classList.add('hidden')">Cancel</button>
        <button id="deleteConfirm" class="btn btn-danger btn-sm">Delete Permanently</button>
      </div>
    </div>
  </div>

  <!-- Skills Editor Modal -->
  <div id="skillsModal" class="modal-backdrop hidden">
    <div class="modal" style="max-width:640px;">
      <div class="modal-header">
        <h2>Edit Skills.md</h2>
        <button class="modal-close" onclick="document.getElementById('skillsModal').classList.add('hidden')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-3);">Describe your app's capabilities for agent discovery. Markdown supported.</p>
        <textarea id="skillsEditor" style="width:100%;min-height:300px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--space-4);font-family:var(--font-mono);font-size:13px;line-height:1.6;color:var(--text-primary);resize:vertical;" placeholder="# My App\n\nDescribe what this app does..."></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('skillsModal').classList.add('hidden')">Cancel</button>
        <button id="skillsSave" class="btn btn-primary btn-sm">Save Skills</button>
      </div>
    </div>
  </div>

  <!-- Permissions Modal -->
  <div id="permissionsModal" class="modal-backdrop hidden">
    <div class="modal" style="max-width:600px;">
      <div class="modal-header">
        <h2>Manage Permissions</h2>
        <button class="modal-close" onclick="document.getElementById('permissionsModal').classList.add('hidden')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-4);">Grant access to specific users and control which functions they can call.</p>
        <div id="permissionsList" style="display:flex;flex-direction:column;gap:var(--space-3);margin-bottom:var(--space-4);"></div>
        <div style="display:flex;gap:var(--space-2);">
          <input id="permissionEmail" type="email" class="input" placeholder="user@example.com" style="flex:1;">
          <button id="grantPermissionBtn" class="btn btn-primary btn-sm">Grant Access</button>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('permissionsModal').classList.add('hidden')">Done</button>
      </div>
    </div>
  </div>

  <!-- BYOK API Key Modal -->
  <div id="byokKeyModal" class="modal-backdrop hidden">
    <div class="modal" style="max-width:480px;">
      <div class="modal-header">
        <h2 id="byokKeyModalTitle">Add Provider Key</h2>
        <button class="modal-close" onclick="closeByokKeyModal()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;">&times;</button>
      </div>
      <div class="modal-body">
        <div id="byokKeyModalProviderMeta" style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);"></div>
        <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:var(--space-2);">API key</label>
        <input id="byokKeyInput" type="password" autocomplete="off" class="input" placeholder="Paste provider API key" style="width:100%;font-family:var(--font-mono);">
        <div id="byokKeyModalModelMeta" style="font-size:11px;color:var(--text-muted);margin-top:var(--space-2);"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="closeByokKeyModal()">Cancel</button>
        <button id="byokKeySaveBtn" class="btn btn-primary btn-sm" onclick="submitByokKeyModal()">Save Key</button>
      </div>
    </div>
  </div>

    <!-- ==========================================
         PROFILE VIEW
         ========================================== -->
    <div id="profileView" style="display:${
    initialView === "profile" ? "block" : "none"
  };">
      <div style="max-width:var(--content-max);margin:0 auto;padding:var(--space-3) var(--space-6);">
        <div id="profileContent">
          <div style="font-size:13px;color:var(--text-muted);padding:var(--space-8) 0;text-align:center;">Loading profile details...</div>
        </div>
      </div>
    </div>

  </main>


  <script>
  (async function() {
    'use strict';
    var gpuSupportEnabled = ${gpuSupportEnabled ? "true" : "false"};

    // ===== Embed Mode (desktop app iframe) =====
    var _embedParams = new URLSearchParams(window.location.search);
    var _isEmbed = _embedParams.get('embed') === '1';

    // Hide chrome in embed mode (desktop app provides its own nav)
    if (_isEmbed) {
      var _embedStyle = document.createElement('style');
      _embedStyle.textContent = '.top-nav { display: none !important; } .main-content { padding-top: var(--space-4) !important; } #dashboardView .settings-sidebar { display: none !important; } #dashboardView .settings-layout { gap: 0; justify-content: center; } #dashboardView .settings-content { flex: none; width: 100%; max-width: 800px; margin-left: auto; margin-right: auto; min-width: 0; } #dashboardView { padding-top: 0; } #profileView { padding-top: 0; }';
      document.head.appendChild(_embedStyle);
    }

    function readHashParam(name) {
      try {
        if (!window.location.hash) return '';
        var match = window.location.hash.match(new RegExp('[#&]' + name + '=([^&]*)'));
        return match ? decodeURIComponent(match[1]) : '';
      } catch (e) {
        return '';
      }
    }

    function stripEmbedAuthArtifactsFromUrl() {
      try {
        var cleanUrl = new URL(window.location.href);
        var changed = false;
        if (cleanUrl.searchParams.has('token')) {
          cleanUrl.searchParams.delete('token');
          changed = true;
        }
        if (window.location.hash && (
          window.location.hash.indexOf('bridge_token=') !== -1 ||
          window.location.hash.indexOf('token=') !== -1
        )) {
          cleanUrl.hash = '';
          changed = true;
        }
        if (changed) {
          history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
        }
      } catch (e) {}
    }

    // ===== Global State =====
    const COOKIE_AUTH_SENTINEL = '__cookie_session__';
    const embedBridgeToken = _isEmbed ? readHashParam('bridge_token') : '';
    let authToken = null;
    let currentUser = null;
    let userProfile = null;
    let apps = [];
    let currentAppId = null;
    let currentView = '${initialView}';
    let setupCommandStr = localStorage.getItem('ultralight_setup_v4') || '';

    const hasLegacyEmbedAuthArtifact = _isEmbed && (
      window.location.search.indexOf('token=') !== -1 ||
      window.location.hash.indexOf('bridge_token=') !== -1 ||
      window.location.hash.indexOf('token=') !== -1
    );
    if (hasLegacyEmbedAuthArtifact) {
      stripEmbedAuthArtifactsFromUrl();
    }

    // Instant auth nav switch — prevents flash of wrong nav state
    if (_isEmbed) {
      // Embed mode: hide both nav states
      var _navPre = document.getElementById('navPreAuth');
      var _navPost = document.getElementById('navPostAuth');
      if (_navPre) _navPre.style.display = 'none';
      if (_navPost) _navPost.style.display = 'none';
    } else if (authToken) {
      document.getElementById('navPostAuth').style.display = 'flex';
      document.getElementById('navPostAuth').classList.remove('hidden');
    } else {
      document.getElementById('navPreAuth').style.display = 'flex';
    }
    let newlyCreatedTokenId = null;
    let connectionPollInterval = null;
    let currentEnvVars = {};
    let pendingEnvVarChanges = {};
    let appSupabaseChanged = false;
    let savedSupabaseServers = null;
    let permsGrantedUsers = [];
    let permsSelectedUserId = null;
    let currentTokens = [];
    let byokData = null;
    let draftFiles = [];
    let skillsValidationTimeout = null;

    const nativeFetch = window.fetch.bind(window);
    const webLogSink = console;
    function webDebugLogsEnabled() {
      try {
        return localStorage.getItem('ul_debug_logs') === '1';
      } catch (e) {
        return false;
      }
    }
    function emitWebLog(level, scope, message, context) {
      if (level === 'debug' && !webDebugLogsEnabled()) return;
      var line = '[' + scope + '] ' + message;
      var sinkMethod = level === 'error'
        ? (webLogSink.error || webLogSink.log)
        : level === 'warn'
          ? (webLogSink.warn || webLogSink.log)
          : (webLogSink.log || function() {});
      if (context !== undefined) sinkMethod.call(webLogSink, line, context);
      else sinkMethod.call(webLogSink, line);
    }
    function debugLog(scope, message, context) { emitWebLog('debug', scope, message, context); }
    function warnLog(scope, message, context) { emitWebLog('warn', scope, message, context); }
    function errorLog(scope, message, context) { emitWebLog('error', scope, message, context); }
    function hasRealBearerToken() {
      return !!authToken && authToken !== COOKIE_AUTH_SENTINEL;
    }
    function shouldStripAuthHeader(value) {
      return /^Bearer\\s*(__cookie_session__|null|undefined)?\\s*$/i.test(value || '');
    }
    function toAbsoluteUrl(input) {
      try {
        if (typeof input === 'string' || input instanceof URL) return new URL(String(input), window.location.href);
        if (input && input.url) return new URL(input.url, window.location.href);
      } catch (e) {}
      return null;
    }
    function shouldRetryAfterRefresh(url) {
      return !/^\\/auth\\/(refresh|session|login|callback|signout)/.test(url.pathname);
    }
    window.fetch = async function(input, init) {
      const absoluteUrl = toAbsoluteUrl(input);
      const sameOrigin = !!absoluteUrl && absoluteUrl.origin === window.location.origin;
      const nextInit = Object.assign({}, init || {});
      const headers = new Headers(nextInit.headers || ((input && input.headers) ? input.headers : undefined));

      if (sameOrigin) {
        if (hasRealBearerToken() && !headers.has('Authorization')) {
          headers.set('Authorization', 'Bearer ' + authToken);
        } else if (!hasRealBearerToken() && shouldStripAuthHeader(headers.get('Authorization') || '')) {
          headers.delete('Authorization');
        }
        if (!nextInit.credentials) nextInit.credentials = 'same-origin';
      }

      nextInit.headers = headers;

      let response = await nativeFetch(input, nextInit);
      if (
        response.status === 401 &&
        sameOrigin &&
        !hasRealBearerToken() &&
        absoluteUrl &&
        shouldRetryAfterRefresh(absoluteUrl)
      ) {
        const refreshRes = await nativeFetch('/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (refreshRes.ok) {
          authToken = COOKIE_AUTH_SENTINEL;
          response = await nativeFetch(input, nextInit);
        }
      }
      return response;
    };

    async function bootstrapEmbedBridgeSession() {
      if (!_isEmbed || !embedBridgeToken) return;

      try {
        const response = await nativeFetch('/auth/embed/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ bridge_token: embedBridgeToken }),
        });
        if (response.ok) {
          authToken = COOKIE_AUTH_SENTINEL;
          return;
        }
        authToken = null;
        warnLog('embed', 'Failed to exchange desktop embed bridge token');
      } catch (e) {
        authToken = null;
        warnLog('embed', 'Desktop embed bridge exchange failed', e);
      }
    }

    // ===== Utilities =====
    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    const escHtml = escapeHtml;

    function getShellStateIcon(kind) {
      if (kind === 'loading') {
        return '<span class="btn-spinner" style="width:16px;height:16px;border-width:2px;"></span>';
      }
      if (kind === 'error') {
        return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path></svg>';
      }
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M8 10h8M8 14h5"></path></svg>';
    }

    function renderShellState(kind, title, description, options) {
      options = options || {};
      var actionHtml = '';
      if (options.actionLabel && options.actionOnclick) {
        actionHtml =
          '<div style="margin-top:var(--space-2)">' +
            '<button class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="' + options.actionOnclick + '">' + escapeHtml(options.actionLabel) + '</button>' +
          '</div>';
      }

      return '<div class="shell-state shell-state-' + escapeHtml(kind) + (options.compact ? ' shell-state-compact' : '') + '">' +
        '<div class="shell-state-icon">' + getShellStateIcon(kind) + '</div>' +
        '<div class="shell-state-title">' + escapeHtml(title) + '</div>' +
        (description ? '<div class="shell-state-desc">' + escapeHtml(description) + '</div>' : '') +
        actionHtml +
      '</div>';
    }

    function renderSectionState(sectionTitle, kind, title, description, options) {
      options = options || {};
      return '<div class="section-card' + (options.cardClass ? ' ' + escapeHtml(options.cardClass) : '') + '">' +
        (sectionTitle ? '<h3 class="section-title">' + escapeHtml(sectionTitle) + '</h3>' : '') +
        renderShellState(kind, title, description, options) +
      '</div>';
    }

    function renderTableState(colspan, kind, title, description) {
      return '<tr><td colspan="' + String(colspan) + '" style="padding:0;">' +
        renderShellState(kind, title, description, { compact: true }) +
      '</td></tr>';
    }

    function shortHash(value) {
      if (!value) return '';
      var str = String(value);
      return str.length > 12 ? str.slice(0, 12) : str;
    }

    function parseJsonMaybe(value) {
      if (!value) return null;
      if (typeof value === 'object') return value;
      if (typeof value !== 'string') return null;
      try { return JSON.parse(value); } catch (e) { return null; }
    }

    function getLatestVersionTrustFromApp(app) {
      if (!app || !Array.isArray(app.version_metadata)) return null;
      for (var i = app.version_metadata.length - 1; i >= 0; i--) {
        var entry = app.version_metadata[i];
        if (entry && entry.trust && (!app.current_version || entry.version === app.current_version)) {
          return entry.trust;
        }
      }
      return null;
    }

    function inferTrustCapabilities(runtime, permissions) {
      permissions = Array.isArray(permissions) ? permissions : [];
      return {
        ai: permissions.indexOf('ai:call') !== -1,
        network: permissions.some(function(p) { return p === 'net:fetch' || p === 'net:connect' || String(p).indexOf('net:') === 0; }),
        storage: permissions.some(function(p) { return String(p).indexOf('storage:') === 0; }),
        memory: permissions.some(function(p) { return String(p).indexOf('memory:') === 0; }),
        gpu: gpuSupportEnabled && (permissions.indexOf('gpu:execute') !== -1 || runtime === 'gpu')
      };
    }

    function getTrustCard(entity) {
      if (!entity) return null;
      if (entity.trust_card && typeof entity.trust_card === 'object') return entity.trust_card;

      var trust = getLatestVersionTrustFromApp(entity);
      var manifest = parseJsonMaybe(entity.manifest);
      var permissions = trust && Array.isArray(trust.permissions)
        ? trust.permissions
        : (manifest && Array.isArray(manifest.permissions) ? manifest.permissions.filter(function(p) { return typeof p === 'string'; }) : []);

      return {
        signed_manifest: !!(trust && trust.signature && trust.manifest_hash),
        signer: trust && trust.signature ? trust.signature.signer : null,
        signed_at: trust && trust.signature ? trust.signature.signed_at : null,
        version: (trust && trust.version) || entity.current_version || null,
        runtime: (trust && trust.runtime) || entity.runtime || 'deno',
        manifest_hash: trust ? trust.manifest_hash : null,
        artifact_hash: trust ? trust.artifact_hash : null,
        artifact_count: trust && trust.artifact_hashes ? Object.keys(trust.artifact_hashes).length : 0,
        permissions: permissions,
        capability_summary: inferTrustCapabilities((trust && trust.runtime) || entity.runtime, permissions),
        required_secrets: trust && Array.isArray(trust.required_secrets) ? trust.required_secrets : [],
        per_user_secrets: trust && Array.isArray(trust.per_user_secrets) ? trust.per_user_secrets : [],
        execution_receipts: { enabled: true, field: 'receipt_id' }
      };
    }

    function trustCapabilityLabels(trust) {
      var summary = trust && trust.capability_summary ? trust.capability_summary : {};
      var labels = [];
      if (summary.ai) labels.push('AI');
      if (summary.network) labels.push('Network');
      if (summary.storage) labels.push('Storage');
      if (summary.memory) labels.push('Memory');
      if (gpuSupportEnabled && summary.gpu) labels.push('GPU');
      return labels;
    }

    function renderTrustChips(labels, emptyLabel) {
      if (!labels || labels.length === 0) {
        return '<span class="trust-chip">' + escapeHtml(emptyLabel || 'No broad access') + '</span>';
      }
      return labels.map(function(label) {
        return '<span class="trust-chip">' + escapeHtml(label) + '</span>';
      }).join('');
    }

    function renderMarketplaceTrust(trust) {
      if (!trust) return '';
      var signed = !!trust.signed_manifest;
      var labels = trustCapabilityLabels(trust);
      var scopeText = labels.length > 0 ? labels.slice(0, 3).join(', ') : 'No broad access';
      var extraCount = labels.length > 3 ? ' +' + (labels.length - 3) : '';
      return '<div class="marketplace-trust-row">' +
        '<span class="trust-status ' + (signed ? 'ok' : 'warn') + '">' + (signed ? 'Signed' : 'Legacy') + '</span>' +
        '<span class="marketplace-trust-text">' + escapeHtml(scopeText + extraCount) + '</span>' +
      '</div>';
    }

    function renderTrustField(label, value, copyField) {
      var display = value ? escapeHtml(value) : 'Not available';
      var copy = value && copyField
        ? '<button class="trust-copy-btn" onclick="copyTrustValue(\\\'' + copyField + '\\\')">Copy</button>'
        : '';
      return '<div class="trust-field">' +
        '<div class="trust-field-label">' + escapeHtml(label) + '</div>' +
        '<div class="trust-field-value">' +
          (value ? '<code title="' + escapeHtml(value) + '">' + display + '</code>' : '<span style="color:var(--text-muted);">' + display + '</span>') +
          copy +
        '</div>' +
      '</div>';
    }

    function renderTrustOverview(app) {
      var trust = getTrustCard(app);
      if (!trust) return '';
      var signed = !!trust.signed_manifest;
      var labels = trustCapabilityLabels(trust);
      var permissions = Array.isArray(trust.permissions) ? trust.permissions : [];
      var requiredSecrets = Array.isArray(trust.required_secrets) ? trust.required_secrets : [];
      var perUserSecrets = Array.isArray(trust.per_user_secrets) ? trust.per_user_secrets : [];
      var visiblePermissions = permissions.filter(function(p) { return gpuSupportEnabled || p !== 'gpu:execute'; });
      var permissionLabels = visiblePermissions.length > 0 ? visiblePermissions.slice(0, 8) : [];
      var secretLabels = requiredSecrets.concat(perUserSecrets.map(function(key) { return key + ' (per user)'; }));
      var note = signed
        ? 'Execution receipts are returned on calls and tied to the owner call log.'
        : 'Publish a manifest-backed version to create signed trust metadata for this app.';
      var runtimeLabel = String(trust.runtime || app.runtime || 'deno');
      if (!gpuSupportEnabled && runtimeLabel === 'gpu') runtimeLabel = 'deno';

      return '<div class="section-card">' +
        '<div class="trust-card-header">' +
          '<h3 class="section-title">Trust & Runtime</h3>' +
          '<span class="trust-status ' + (signed ? 'ok' : 'warn') + '">' + (signed ? 'Signed Manifest' : 'Unsigned Legacy') + '</span>' +
        '</div>' +
        '<div class="trust-grid">' +
          renderTrustField('Runtime', runtimeLabel, '') +
          renderTrustField('Version', String(trust.version || app.current_version || 'current'), '') +
          renderTrustField('Manifest Hash', shortHash(trust.manifest_hash), 'manifest_hash') +
          renderTrustField('Artifact Hash', shortHash(trust.artifact_hash), 'artifact_hash') +
          renderTrustField('Artifacts', String(trust.artifact_count || 0), '') +
          renderTrustField('Receipt Field', trust.execution_receipts && trust.execution_receipts.enabled ? 'receipt_id' : 'Disabled', '') +
        '</div>' +
        '<div class="trust-chip-row" style="margin-bottom:var(--space-2);">' +
          renderTrustChips(labels, 'No broad access') +
        '</div>' +
        '<div class="trust-chip-row" style="margin-bottom:var(--space-2);">' +
          renderTrustChips(permissionLabels, 'No permission scopes') +
          (visiblePermissions.length > permissionLabels.length ? '<span class="trust-chip">+' + (visiblePermissions.length - permissionLabels.length) + ' more scopes</span>' : '') +
        '</div>' +
        '<div class="trust-chip-row">' +
          renderTrustChips(secretLabels, 'No required secrets') +
        '</div>' +
        '<div class="trust-note">' + escapeHtml(note) + '</div>' +
      '</div>';
    }

    // Resolve function list from best available source: manifest first, then legacy metadata
    // Returns: { functions: [{name, description?, parameters?}], source, migrationRequired, message }
    // Parameters are normalized to object-keyed format: { paramName: { type, description, required } }
    function getAppFunctions(app) {
      function buildMigrationMessage(source) {
        if (source === 'skills_parsed') {
          return 'This app still relies on legacy code-analysis contracts. Publish a manifest-backed version before relying on stable runtime schemas.';
        }
        if (gpuSupportEnabled && source === 'gpu_exports') {
          return 'This GPU app still relies on export-name discovery. Publish a manifest-backed version before relying on stable runtime schemas.';
        }
        if (source === 'exports') {
          return 'This app still relies on legacy export discovery. Publish a manifest-backed version before relying on stable runtime schemas.';
        }
        return 'This app does not have a manifest-backed function contract yet.';
      }

      // 1. Manifest functions (richest: name, description, parameters)
      var manifest = app.manifest;
      if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest); } catch(e) { manifest = null; } }
      if (manifest && manifest.functions && typeof manifest.functions === 'object') {
        var fnEntries = Object.entries(manifest.functions);
        if (fnEntries.length > 0) {
          var fns = fnEntries.map(function(entry) {
            var fnName = entry[0], fnDef = entry[1];
            // Normalize parameters: array [{name,type}] → object {name: {type}}
            var params = fnDef.parameters;
            if (Array.isArray(params)) {
              var obj = {};
              params.forEach(function(p) { if (p && p.name) { var rest = Object.assign({}, p); delete rest.name; obj[p.name] = rest; } });
              params = obj;
            }
            return { name: fnName, description: fnDef.description || '', parameters: params || {} };
          });
          return { functions: fns, source: 'manifest', migrationRequired: false, message: '' };
        }
      }
      // 2. skills_parsed functions (name + description + parameter schemas)
      var sp = app.skills_parsed;
      if (typeof sp === 'string') { try { sp = JSON.parse(sp); } catch(e) { sp = null; } }
      if (sp && sp.functions && sp.functions.length > 0) {
        return {
          functions: sp.functions,
          source: 'skills_parsed',
          migrationRequired: true,
          message: buildMigrationMessage('skills_parsed')
        };
      }
      // 3. GPU export fallback (legacy, read-only guidance only)
      if (gpuSupportEnabled && app.runtime === 'gpu' && app.exports && app.exports.length > 0) {
        return {
          functions: app.exports.map(function(name) { return { name: name }; }),
          source: 'gpu_exports',
          migrationRequired: true,
          message: buildMigrationMessage('gpu_exports')
        };
      }
      // 4. Plain export fallback (legacy, owner-facing migration guidance only)
      if (app.exports && app.exports.length > 0) {
        return {
          functions: app.exports.map(function(name) { return { name: name }; }),
          source: 'exports',
          migrationRequired: true,
          message: buildMigrationMessage('exports')
        };
      }
      return { functions: [], source: 'none', migrationRequired: false, message: buildMigrationMessage('none') };
    }

    function relTime(d) {
      const ms = Date.now() - new Date(d).getTime();
      const m = Math.floor(ms / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      const dy = Math.floor(h / 24);
      if (dy < 30) return dy + 'd ago';
      return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function getAppEmoji(name) {
      const emojis = ['⚡','🔧','📡','🎯','🚀','💎','🔮','🎨','🌊','🔥','✨','🛠️','📦','🎪','🌟'];
      let hash = 0;
      for (let i = 0; i < (name || '').length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
      return emojis[Math.abs(hash) % emojis.length];
    }

    // ===== Toast Notifications =====
    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContent = message;
      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('toast-visible'));
      setTimeout(() => {
        toast.classList.remove('toast-visible');
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    // ===== Authentication =====
    function showAuthOverlay() {
      document.getElementById('authOverlay').classList.remove('hidden');
    }
    function hideAuthOverlay() {
      document.getElementById('authOverlay').classList.add('hidden');
    }
    window.showAuthOverlay = showAuthOverlay;
    window.hideAuthOverlay = hideAuthOverlay;

    // Hero CTA — handles both authenticated (copy with token) and pre-auth (provisional token) flows
    // Shared copy + animation helper for CTA buttons
    // Shows green checkmark SVG + "Copied! Paste to agent" for 5 seconds, then reverts
    async function copyAndAnimateCTA(btn, textEl, origBtnHTML) {
      if (!setupCommandStr) return;
      try {
        await navigator.clipboard.writeText(setupCommandStr);
        var checkSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btn.innerHTML = checkSvg + ' <span>' + 'Copied! Paste to agent' + '</span>';
        btn.style.background = 'var(--text-primary)';
        btn.style.color = 'var(--bg-base)';
        setTimeout(function() {
          btn.innerHTML = origBtnHTML;
          btn.style.background = '';
          btn.style.color = '';
        }, 5000);
      } catch(e2) {
        showToast('Failed to copy', 'error');
      }
    }

    function setupHeroCTA() {
      var btn = document.getElementById('heroCTA');
      if (!btn) return;
      var origHTML = btn.innerHTML;
      if (authToken) {
        // Authenticated: generate instructions with real API token
        btn.onclick = async function(e) {
          e.preventDefault();
          if (!setupCommandStr) {
            var textEl = document.getElementById('heroCTAText');
            if (textEl) textEl.textContent = 'Generating...';
            btn.disabled = true;
            await generateSetupInstructions();
            btn.disabled = false;
          }
          await copyAndAnimateCTA(btn, null, origHTML);
        };
      } else {
        // Not authenticated: create provisional token (zero-friction onboarding)
        btn.onclick = async function(e) {
          e.preventDefault();
          if (!setupCommandStr) {
            var textEl = document.getElementById('heroCTAText');
            if (textEl) textEl.textContent = 'Setting up...';
            btn.disabled = true;
            try {
              await generateProvisionalInstructions();
            } catch(err) {
              if (textEl) textEl.textContent = 'Copy agent instructions';
              btn.disabled = false;
              // Fallback: show auth overlay if provisional creation fails
              document.getElementById('authOverlay').classList.remove('hidden');
              return;
            }
            btn.disabled = false;
          }
          await copyAndAnimateCTA(btn, null, origHTML);
        };
      }
    }

    function setupBottomCTA() {
      var btn = document.getElementById('bottomCTA');
      if (!btn) return;
      var origHTML = btn.innerHTML;
      if (authToken) {
        btn.onclick = async function(e) {
          e.preventDefault();
          if (!setupCommandStr) {
            var textEl = document.getElementById('bottomCTAText');
            if (textEl) textEl.textContent = 'Generating...';
            btn.disabled = true;
            await generateSetupInstructions();
            btn.disabled = false;
          }
          await copyAndAnimateCTA(btn, null, origHTML);
        };
      } else {
        btn.onclick = async function(e) {
          e.preventDefault();
          if (!setupCommandStr) {
            var textEl = document.getElementById('bottomCTAText');
            if (textEl) textEl.textContent = 'Setting up...';
            btn.disabled = true;
            try {
              await generateProvisionalInstructions();
            } catch(err) {
              if (textEl) textEl.textContent = 'Copy agent instructions';
              btn.disabled = false;
              document.getElementById('authOverlay').classList.remove('hidden');
              return;
            }
            btn.disabled = false;
          }
          await copyAndAnimateCTA(btn, null, origHTML);
        };
      }
    }

    // Close auth overlay on backdrop click
    document.getElementById('authOverlay')?.addEventListener('click', function(e) {
      if (e.target === this) hideAuthOverlay();
    });
    // Close button
    document.getElementById('authCloseBtn')?.addEventListener('click', hideAuthOverlay);

    async function detectAuthenticatedSession() {
      if (hasRealBearerToken()) return;
      try {
        const res = await fetch('/auth/user');
        if (!res.ok) {
          if (authToken === COOKIE_AUTH_SENTINEL) authToken = null;
          return;
        }
        const data = await res.json();
        authToken = data && data.id ? COOKIE_AUTH_SENTINEL : null;
      } catch (e) {
        if (authToken === COOKIE_AUTH_SENTINEL) authToken = null;
      }
    }

    async function updateAuthUI() {
      await detectAuthenticatedSession();

      // Always set up hero CTA (handles both pre-auth and post-auth paths)
      setupHeroCTA();
      setupBottomCTA();

      if (!authToken) {
        // Not authenticated — clear any stale cached instructions from a previous session
        setupCommandStr = '';
        localStorage.removeItem('ultralight_setup_v4');
        document.getElementById('navPreAuth').classList.remove('hidden');
        var navPostEl = document.getElementById('navPostAuth');
        navPostEl.classList.add('hidden');
        navPostEl.style.display = 'none';
        showView('home');
        return;
      }

      // Clean up provisional state now that user is authenticated
      localStorage.removeItem('ultralight_provisional_token_id');
      localStorage.removeItem('ultralight_provisional_user_id');

      if (authToken !== COOKIE_AUTH_SENTINEL) {
        signOut();
        return;
      }

      try {
        const authRes = await fetch('/auth/user');
        const authData = await authRes.json();
        if (!authRes.ok || !authData?.id) { signOut(); return; }
        currentUser = authData;
        if (authData.id) { window._currentUserId = authData.id; currentUserId = authData.id; }
      } catch {
        signOut();
        return;
      }

      // Fetch full profile (skip if already loaded via ul_ token path)
      if (!userProfile) try {
        const res = await fetch('/api/user', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          userProfile = await res.json();
          // Store user ID for marketplace ownership checks
          if (userProfile && userProfile.id) {
            window._currentUserId = userProfile.id;
            currentUserId = userProfile.id;
          }
        }
      } catch {}

      // Update nav
      debugLog('auth-ui', 'Switching to post-auth nav');
      document.getElementById('navPreAuth').classList.add('hidden');
      var navPost = document.getElementById('navPostAuth');
      navPost.classList.remove('hidden');
      navPost.style.display = 'flex';

      // Set avatar
      const avatarEls = document.querySelectorAll('.profile-avatar');
      const initial = (userProfile?.first_name || userProfile?.email || currentUser.email || '?')[0].toUpperCase();
      avatarEls.forEach(el => { el.textContent = initial; });

      // Set profile info in dropdown
      const emailEl = document.getElementById('profileEmail');
      if (emailEl) emailEl.textContent = userProfile?.email || currentUser.email || '';

      // Load apps
      await loadApps();

      // Show appropriate view
      if (currentView === 'home') {
        // Check if user has apps — if yes, show dashboard
        if (apps.length > 0) {
          showView('dashboard');
          loadDashboardData();
        } else {
          // First-time user: auto-generate + auto-copy instructions
          await generateSetupInstructions();
          if (setupCommandStr) {
            var ctaBtn = document.getElementById('heroCTA');
            if (ctaBtn) {
              await copyAndAnimateCTA(ctaBtn, null, ctaBtn.innerHTML);
            }
          }
          showSetupBlock();
        }
      } else if (currentView === 'dashboard') {
        // Check if URL is actually a settings sub-route
        var pathname = window.location.pathname;
        if (pathname === '/wallet') {
          showView('dashboard');
          switchDashSection('billing');
          loadAccountData();
        } else if (pathname === '/settings' || pathname.startsWith('/settings/')) {
          var settingsSection = pathname.split('/settings/')[1] || 'keys';
          if (settingsSection === 'tokens') settingsSection = 'keys';
          var autoWalletTab = null;
          if (settingsSection === 'offers') { settingsSection = 'billing'; autoWalletTab = 'offers'; }
          showView('dashboard');
          switchDashSection(settingsSection);
          if (autoWalletTab) {
            activeWalletTab = 'offers';
            document.querySelectorAll('[data-wallet-tab]').forEach(function(btn) {
              btn.classList.toggle('active', btn.dataset.walletTab === 'offers');
            });
            var _bt = document.getElementById('walletBalanceTab');
            var _tt = document.getElementById('walletTransactionsTab');
            var _et = document.getElementById('walletEarningsTab');
            var _ot = document.getElementById('walletOffersTab');
            if (_bt) _bt.style.display = 'none';
            if (_tt) _tt.style.display = 'none';
            if (_et) _et.style.display = 'none';
            if (_ot) _ot.style.display = 'block';
            loadMyOffers();
            history.replaceState({}, '', '/wallet');
          }
          loadAccountData();
        } else if (pathname === '/marketplace' || pathname === '/capabilities') {
          showView('dashboard');
          switchDashSection('capabilities');
        } else if (pathname === '/keys') {
          showView('dashboard');
          switchDashSection('keys');
          loadAccountData();
        } else {
          showView('dashboard');
          switchDashSection('capabilities');
          loadDashboardData();
        }
      } else if (currentView === 'profile') {
        showView('profile');
        // Load own profile or specific profile by slug
        if (_profileSlug) {
          loadProfilePage(_profileSlug);
        } else if (userProfile) {
          var _mySlug = userProfile.profile_slug || userProfile.id;
          if (_mySlug) loadProfilePage(_mySlug);
        }
      } else if (currentView === 'app') {
        showView('app');
      }
    }

    async function signOut() {
      try {
        var signOutResponse = await nativeFetch('/auth/signout', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!signOutResponse.ok) {
          warnLog('auth', 'Sign-out did not fully revoke the upstream session');
        }
      } catch (e) {
        warnLog('auth', 'Sign-out request failed', e);
      }
      authToken = null;
      currentUser = null;
      userProfile = null;
      apps = [];
      localStorage.removeItem('ultralight_setup_v4');
      if (connectionPollInterval) clearInterval(connectionPollInterval);
      if (_isEmbed) return; // Don't redirect in embed mode
      window.location.href = '/';
    }
    window.signOut = signOut;

    // ===== Navigation =====
    function showView(view) {
      currentView = view;
      ['homeView', 'dashboardView', 'appView', 'profileView'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      const viewMap = {
        home: 'homeView',
        dashboard: 'dashboardView',
        app: 'appView',
        leaderboard: 'dashboardView',
        profile: 'profileView',
      };

      const targetId = viewMap[view];
      if (targetId) {
        const el = document.getElementById(targetId);
        if (el) el.style.display = 'block';
      }
    }

    function navigateToHome() {
      history.pushState({}, '', '/');
      currentAppId = null;
      if (authToken && apps.length > 0) {
        showView('dashboard');
        loadDashboardData();
      } else if (authToken) {
        showView('home');
        showSetupBlock();
      } else {
        showView('home');
      }
    }

    function navigateToDashboard() {
      history.pushState({}, '', '/dash');
      currentAppId = null;
      showView('dashboard');
      switchDashSection('library');
      renderAppList();
      loadDashboardData();
    }

    function navigateToApp(appId, section) {
      var sec = section || 'overview';
      if (sec === 'overview') {
        history.pushState({}, '', '/a/' + appId);
      } else {
        history.pushState({}, '', '/a/' + appId + '/' + sec);
      }
      currentAppId = appId;
      showView('app');
      loadAppPage(appId, sec);
    }
    window.navigateToApp = navigateToApp;

    function navigateToAccount(section) {
      var sec = section || 'keys';
      // Map old names to new
      if (sec === 'tokens') sec = 'keys';
      if (sec === 'keys') {
        history.pushState({}, '', '/keys');
      } else {
        history.pushState({}, '', '/settings/' + sec);
      }
      showView('dashboard');
      switchDashSection(sec);
      loadAccountData();
    }
    window.navigateToAccount = navigateToAccount;

    window.addEventListener('popstate', async function() {
      const path = window.location.pathname;
      if (path === '/' || path === '/home') {
        navigateToHome();
      } else if (path === '/dash' || path === '/dashboard') {
        showView('dashboard');
        switchDashSection('library');
        renderAppList();
        loadDashboardData();
      } else if (path === '/wallet') {
        showView('dashboard');
        switchDashSection('billing');
        loadAccountData();
      } else if (path === '/marketplace') {
        showView('dashboard');
        switchDashSection('marketplace');
      } else if (path === '/keys') {
        showView('dashboard');
        switchDashSection('keys');
        loadAccountData();
      } else if (path === '/settings' || path.startsWith('/settings/')) {
        var popSection = path.split('/settings/')[1] || 'keys';
        var popWalletTab = null;
        if (popSection === 'offers') { popSection = 'billing'; popWalletTab = 'offers'; }
        showView('dashboard');
        switchDashSection(popSection);
        if (popWalletTab) {
          activeWalletTab = 'offers';
          document.querySelectorAll('[data-wallet-tab]').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.walletTab === 'offers');
          });
          var _pbt = document.getElementById('walletBalanceTab');
          var _ptt = document.getElementById('walletTransactionsTab');
          var _pet = document.getElementById('walletEarningsTab');
          var _pot = document.getElementById('walletOffersTab');
          if (_pbt) _pbt.style.display = 'none';
          if (_ptt) _ptt.style.display = 'none';
          if (_pet) _pet.style.display = 'none';
          if (_pot) _pot.style.display = 'block';
          loadMyOffers();
          history.replaceState({}, '', '/wallet');
        }
        loadAccountData();
      } else if (path.startsWith('/a/')) {
        const parts = path.slice(3).split('/');
        const appId = parts[0];
        const section = parts[1] || 'overview';
        currentAppId = appId;
        showView('app');
        loadAppPage(appId, section);
      }
    });

    // Nav button handlers
    document.getElementById('navAuthBtn')?.addEventListener('click', showAuthOverlay);
    document.getElementById('navLogoLink')?.addEventListener('click', function(e) {
      e.preventDefault();
      navigateToHome();
    });

    // ===== Profile Dropdown =====
    const profileTrigger = document.getElementById('profileTrigger');
    const profileDropdown = document.getElementById('profileDropdown');

    if (profileTrigger) {
      profileTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        profileDropdown.classList.toggle('open');
      });
    }

    document.addEventListener('click', function(e) {
      if (profileDropdown && !profileDropdown.contains(e.target) && !profileTrigger.contains(e.target)) {
        profileDropdown.classList.remove('open');
      }
    });

    // Profile dropdown menu actions
    document.querySelectorAll('[data-action]').forEach(function(el) {
      el.addEventListener('click', function() {
        const action = this.dataset.action;
        profileDropdown.classList.remove('open');
        if (action === 'dashboard') navigateToDashboard();
        else if (action === 'signout') signOut();
      });
    });

    // ===== Dashboard Sidebar =====
    let activeDashSection = '${dashSection}';

    function switchDashSection(section) {
      // Map legacy sections
      if (section === 'library' || section === 'marketplace') section = 'capabilities';
      activeDashSection = section;

      // Update sidebar active state
      document.querySelectorAll('[data-dash-section]').forEach(function(el) {
        el.classList.toggle('active', el.dataset.dashSection === section);
      });

      // Show/hide panels
      var panelMap = {
        capabilities: 'dashCapabilitiesPanel',
        keys: 'dashKeysPanel',
        billing: 'dashBillingPanel'
      };

      Object.values(panelMap).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      var panel = document.getElementById(panelMap[section]);
      if (panel) panel.style.display = 'block';

      // Update URL and load section data
      if (section === 'capabilities') {
        history.replaceState({}, '', '/capabilities');
        switchCapTab(activeCapTab);
      } else if (section === 'keys') {
        history.replaceState({}, '', '/keys');
        loadApiKey();
      } else if (section === 'billing') {
        history.replaceState({}, '', '/wallet');
        activeWalletTab = 'balance';
        document.querySelectorAll('[data-wallet-tab]').forEach(function(btn) {
          btn.classList.toggle('active', btn.dataset.walletTab === 'balance');
        });
        var balTab = document.getElementById('walletBalanceTab');
        var txTab = document.getElementById('walletTransactionsTab');
        var earnTab = document.getElementById('walletEarningsTab');
        var offTab = document.getElementById('walletOffersTab');
        if (balTab) balTab.style.display = 'block';
        if (txTab) txTab.style.display = 'none';
        if (earnTab) earnTab.style.display = 'none';
        if (offTab) offTab.style.display = 'none';
        loadHostingData();
        loadConnectStatus();
      } else {
        history.replaceState({}, '', '/settings/' + section);
      }
    }

    // Dashboard sidebar click handlers
    document.querySelectorAll('[data-dash-section]').forEach(function(el) {
      el.addEventListener('click', function() {
        switchDashSection(this.dataset.dashSection);
      });
    });

    // ===== Capabilities Tab Management =====
    var activeCapTab = 'library';
    var activeCapType = 'all';
    var activeCapOwner = 'all';
    var leaderboardPeriod = '30d';
    var capSearchDebounce = null;

    function updateFiltersVisibility() {
      var btn = document.getElementById('capFiltersBtn');
      if (!btn) return;
      var q = (document.getElementById('capSearch') || {}).value || '';
      var showFilters = activeCapTab !== 'market' || q.length >= 2;
      btn.style.display = showFilters ? 'block' : 'none';
      // Close dropdown when hiding
      if (!showFilters) {
        var dd = document.getElementById('capFiltersDropdown');
        if (dd) dd.style.display = 'none';
      }
    }

    // Close filters dropdown on outside click
    document.addEventListener('click', function(e) {
      var btn = document.getElementById('capFiltersBtn');
      if (btn && !btn.contains(e.target)) {
        var dd = document.getElementById('capFiltersDropdown');
        if (dd) dd.style.display = 'none';
      }
    });

    function switchCapTab(tab) {
      activeCapTab = tab;
      document.querySelectorAll('[data-cap-tab]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.capTab === tab);
      });
      var marketEl = document.getElementById('capMarketContent');
      var libEl = document.getElementById('capLibraryContent');
      var sharedEl = document.getElementById('capSharedContent');
      var searchEl = document.getElementById('capSearchResults');
      if (marketEl) marketEl.style.display = tab === 'market' ? 'block' : 'none';
      if (libEl) libEl.style.display = tab === 'library' ? 'block' : 'none';
      if (sharedEl) sharedEl.style.display = tab === 'shared' ? 'block' : 'none';
      if (searchEl) searchEl.style.display = 'none';

      // Clear search when switching tabs
      var searchInput = document.getElementById('capSearch');
      if (searchInput) searchInput.value = '';

      updateFiltersVisibility();

      if (tab === 'market') loadMarketPage();
      else if (tab === 'library') { loadSavedAppIds(); renderAppList(); }
      else if (tab === 'shared') loadSharedApps();
    }

    // Sub-tab click handlers
    document.querySelectorAll('[data-cap-tab]').forEach(function(el) {
      el.addEventListener('click', function() { switchCapTab(this.dataset.capTab); });
    });

    function updateFilterLabel() {
      var label = document.getElementById('capFilterLabel');
      if (!label) return;
      var parts = [];
      if (activeCapType !== 'all') {
        var typeLabels = gpuSupportEnabled
          ? { gpu: 'GPU', apps: 'MCP', skills: '.MD' }
          : { apps: 'MCP', skills: '.MD' };
        parts.push(typeLabels[activeCapType] || activeCapType);
      }
      if (activeCapOwner !== 'all') parts.push('Mine');
      label.textContent = parts.length > 0 ? 'Filters (' + parts.join(', ') + ')' : 'Filters';
    }

    // Type filter handlers
    document.querySelectorAll('[data-cap-type]').forEach(function(el) {
      el.addEventListener('click', function() {
        activeCapType = this.dataset.capType;
        document.querySelectorAll('[data-cap-type]').forEach(function(b) {
          b.classList.toggle('active', b.dataset.capType === activeCapType);
        });
        updateFilterLabel();
        // Re-run search if there's a query
        var q = (document.getElementById('capSearch') || {}).value || '';
        if (q.length >= 2) handleCapSearch(q);
      });
    });

    // Ownership filter handlers
    document.querySelectorAll('[data-cap-owner]').forEach(function(el) {
      el.addEventListener('click', function() {
        activeCapOwner = this.dataset.capOwner;
        document.querySelectorAll('[data-cap-owner]').forEach(function(b) {
          b.classList.toggle('active', b.dataset.capOwner === activeCapOwner);
        });
        updateFilterLabel();
        var q = (document.getElementById('capSearch') || {}).value || '';
        if (q.length >= 2) handleCapSearch(q);
      });
    });

    // Search input handler
    var capSearchEl = document.getElementById('capSearch');
    if (capSearchEl) {
      capSearchEl.addEventListener('input', function() {
        var q = this.value.trim();
        clearTimeout(capSearchDebounce);
        if (q.length < 2) {
          // Restore current tab content
          var searchResults = document.getElementById('capSearchResults');
          if (searchResults) searchResults.style.display = 'none';
          var marketEl = document.getElementById('capMarketContent');
          var libEl = document.getElementById('capLibraryContent');
          var sharedEl = document.getElementById('capSharedContent');
          if (activeCapTab === 'market' && marketEl) marketEl.style.display = 'block';
          if (activeCapTab === 'library' && libEl) libEl.style.display = 'block';
          if (activeCapTab === 'shared' && sharedEl) sharedEl.style.display = 'block';
          updateFiltersVisibility();
          return;
        }
        updateFiltersVisibility();
        capSearchDebounce = setTimeout(function() { handleCapSearch(q); }, 300);
      });
    }

    function handleCapSearch(query) {
      // Hide tab content, show search results
      var marketEl = document.getElementById('capMarketContent');
      var libEl = document.getElementById('capLibraryContent');
      var sharedEl = document.getElementById('capSharedContent');
      var searchEl = document.getElementById('capSearchResults');
      if (marketEl) marketEl.style.display = 'none';
      if (libEl) libEl.style.display = 'none';
      if (sharedEl) sharedEl.style.display = 'none';
      if (searchEl) searchEl.style.display = 'block';

      var resultsList = document.getElementById('capSearchResultsList');
      if (resultsList) resultsList.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:var(--space-4) 0;">Searching...</div>';

      var params = new URLSearchParams();
      params.set('q', query);
      if (gpuSupportEnabled && activeCapType === 'gpu') {
        params.set('type', 'apps');
        params.set('runtime', 'gpu');
      } else if (activeCapType === 'apps') {
        params.set('type', 'apps');
        params.set('runtime', 'deno');
      } else if (activeCapType === 'skills') {
        params.set('type', 'skills');
      }
      params.set('limit', '30');

      fetch('/api/discover/marketplace?' + params.toString())
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var results = data.results || [];
          // Filter by ownership if "Mine" is selected
          if (activeCapOwner === 'mine' && currentUserId) {
            results = results.filter(function(r) { return r.owner_id === currentUserId; });
          }
          if (!resultsList) return;
          if (results.length === 0) {
            resultsList.innerHTML = renderShellState('empty', 'No matching results', 'Try a different search term or clear a filter.', { compact: true });
            return;
          }
          resultsList.innerHTML = results.map(renderMarketplaceCard).join('');
        })
        .catch(function() {
          if (resultsList) resultsList.innerHTML = renderShellState('error', 'Search unavailable', 'We could not load those search results right now.', { compact: true });
        });
    }

    // Current user ID (set from auth flow via window._currentUserId)
    var currentUserId = window._currentUserId || null;

    // Flag emoji helper
    function getFlagEmoji(code) {
      if (!code) return '';
      return code.toUpperCase().replace(/./g, function(c) {
        return String.fromCodePoint(127397 + c.charCodeAt(0));
      });
    }

    // Format Light currency helper
    function formatLight(amount) {
      var abs = Math.abs(amount);
      var sign = amount < 0 ? '-' : '';
      var formatted;
      if (abs >= 1e12) formatted = (abs / 1e12).toFixed(2) + 'T';
      else if (abs >= 1e9) formatted = (abs / 1e9).toFixed(2) + 'B';
      else if (abs >= 1e6) formatted = (abs / 1e6).toFixed(2) + 'M';
      else if (abs >= 5000) formatted = (abs / 1000).toFixed(1) + 'K';
      else if (abs % 1 === 0) formatted = String(abs);
      else formatted = abs.toFixed(2);
      return sign + '\\u2726' + formatted;
    }

    function formatLightRate(amount) {
      var n = Number(amount || 0);
      return '\\u2726' + n.toLocaleString(undefined, { maximumFractionDigits: 6 });
    }

    // Load platform ticker stats
    function loadPlatformStats() {
      var tickerEl = document.getElementById('marketTicker');
      if (tickerEl) tickerEl.innerHTML = '<span>Loading market activity...</span>';
      fetch('/api/discover/stats')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          tickerEl = document.getElementById('marketTicker');
          if (!tickerEl) return;
          var gmv = formatLight(data.gmv_30d_light || 0);
          var changePct = (data.gmv_change_pct || 0).toFixed(1);
          var changeSign = data.gmv_change_pct >= 0 ? '+' : '';
          var items = [
            '30d GMV ' + gmv + ' ' + changeSign + changePct + '%',
            'Acquisitions (30d) ' + (data.acquisitions_30d || 0) + ' ' + (data.acquisitions_change >= 0 ? '+' : '') + (data.acquisitions_change || 0),
            'Tools listed ' + (data.capabilities_listed || 0)
          ];
          // Double items for seamless scroll
          var doubled = items.concat(items);
          tickerEl.innerHTML = doubled.map(function(t) { return '<span>' + escapeHtml(t) + '</span>'; }).join('');
        })
        .catch(function() {
          if (tickerEl) tickerEl.innerHTML = '<span>Market activity is unavailable right now.</span>';
        });
    }

    // Load newly published apps
    function loadNewlyPublished() {
      var el = document.getElementById('newlyPublishedList');
      if (el) {
        el.innerHTML = renderShellState('loading', 'Loading new publications', 'Checking the latest apps that just shipped.', { compact: true });
      }
      fetch('/api/discover/newly-published?limit=5')
        .then(function(r) { return r.json(); })
        .then(function(apps) {
          el = document.getElementById('newlyPublishedList');
          if (!el) return;
          if (!apps || apps.length === 0) {
            el.innerHTML = renderShellState('empty', 'Nothing new has shipped yet', 'Freshly published apps will appear here.', { compact: true });
            return;
          }
          el.innerHTML = '<div style="border:1px solid var(--border);background:var(--bg-base);">' + apps.map(function(app, i) {
            var timeAgo = formatTimeAgo(app.first_published_at);
            var isNew = (Date.now() - new Date(app.first_published_at).getTime()) < 24 * 60 * 60 * 1000;
            var border = i > 0 ? 'border-top:1px solid var(--border);' : '';
            return '<div class="market-list-link" style="cursor:pointer;' + border + '" onclick="navigateToApp(\\\'' + app.id + '\\\')">'
              + '<div style="display:flex;align-items:center;gap:var(--space-2);">'
              + '<span style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);"></span>'
              + '<span style="font-size:13px;font-weight:500;">' + escapeHtml(app.name) + '</span>'
              + (isNew ? ' <span style="font-size:10px;font-weight:600;padding:1px 6px;background:#dcfce7;color:#16a34a;border-radius:3px;">New</span>' : '')
              + '</div>'
              + '<span style="font-size:12px;color:var(--text-muted);">' + timeAgo + '</span>'
              + '</div>';
          }).join('') + '</div>';
        })
        .catch(function() {
          if (el) {
            el.innerHTML = renderShellState('error', 'Could not load new publications', 'Try again in a moment.', { compact: true });
          }
        });
    }

    function renderMarketProfileLink(profile, fallbackLabel) {
      var label = profile && (profile.display_name || profile.profile_slug) || fallbackLabel || 'Private profile';
      var href = profile && profile.profile_url ? profile.profile_url : '';
      if (!href) return escapeHtml(label);
      return '<a href="' + escapeHtml(href) + '" onclick="event.stopPropagation()" style="color:var(--text-primary);text-decoration:none;font-weight:500;">' + escapeHtml(label) + '</a>';
    }

    // Load newly acquired apps
    function loadNewlyAcquired() {
      var el = document.getElementById('newlyAcquiredList');
      if (el) {
        el.innerHTML = renderShellState('loading', 'Loading acquisitions', 'Checking the latest receipt-backed app acquisitions.', { compact: true });
      }
      fetch('/api/discover/newly-acquired?limit=5')
        .then(function(r) { return r.json(); })
        .then(function(sales) {
          el = document.getElementById('newlyAcquiredList');
          if (!el) return;
          if (!sales || sales.length === 0) {
            el.innerHTML = renderShellState('empty', 'No acquisitions yet', 'Completed app transfers will appear here once they happen.', { compact: true });
            return;
          }
          el.innerHTML = '<div style="border:1px solid var(--border);background:var(--bg-base);">' + sales.map(function(sale, i) {
            var border = i > 0 ? 'border-top:1px solid var(--border);' : '';
            var price = formatLight(sale.sale_price_light || 0);
            var timeAgo = formatTimeAgo(sale.created_at);
            var receiptId = sale.receipt_id || sale.sale_id || '';
            var buyer = renderMarketProfileLink(sale.buyer, 'Private acquirer');
            var seller = renderMarketProfileLink(sale.seller, 'Private seller');
            var color = sale.sale_price_light >= 375000 ? '#ef4444' : sale.sale_price_light >= 125000 ? '#3b82f6' : '#22c55e';
            return '<div class="market-list-link" style="cursor:pointer;' + border + '" onclick="navigateToApp(\\\'' + (sale.app_id || '') + '\\\')">'
              + '<div style="display:flex;align-items:center;gap:var(--space-2);">'
              + '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';"></span>'
              + '<span style="font-size:13px;font-weight:500;">' + escapeHtml(sale.app_name) + '</span>'
              + ' <span style="font-size:12px;font-weight:600;padding:1px 6px;background:' + color + '22;color:' + color + ';border-radius:3px;">' + price + '</span>'
              + '</div>'
              + '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + seller + ' &rarr; ' + buyer + ' &middot; Receipt <code title="' + escapeHtml(receiptId) + '">' + escapeHtml(shortReceiptId(receiptId)) + '</code> &middot; ' + timeAgo + '</div>'
              + '</div>';
          }).join('') + '</div>';
        })
        .catch(function() {
          if (el) {
            el.innerHTML = renderShellState('error', 'Could not load acquisitions', 'Try again in a moment.', { compact: true });
          }
        });
    }

    // Load leaderboard
    function loadLeaderboard(period) {
      if (period) leaderboardPeriod = period;
      document.querySelectorAll('[data-lb-period]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.lbPeriod === leaderboardPeriod);
      });

      var tbody = document.getElementById('leaderboardBody');
      if (!tbody) return;
      tbody.innerHTML = renderTableState(5, 'loading', 'Loading leaderboard', 'Checking the latest top-earning profiles.');

      fetch('/api/discover/leaderboard?period=' + leaderboardPeriod + '&limit=20')
        .then(function(r) { return r.json(); })
        .then(function(entries) {
          if (!tbody) return;
          if (!entries || entries.length === 0) {
            tbody.innerHTML = renderTableState(5, 'empty', 'No leaderboard data yet', 'Try a different time window or check back after more activity.');
            return;
          }
          tbody.innerHTML = entries.map(function(e, i) {
            var flag = getFlagEmoji(e.country);
            var profileLink = e.profile_slug ? '/u/' + e.profile_slug : '#';
            var featured = e.featured_app ? escapeHtml(e.featured_app.name) : '';
            var featuredStyle = 'font-size:12px;padding:2px 8px;background:var(--bg-raised);border:1px solid var(--border);border-radius:3px;color:var(--text-secondary);';
            return '<tr style="border-bottom:1px solid var(--border);">'
              + '<td style="padding:var(--space-2) var(--space-1);color:var(--text-muted);font-weight:500;">' + (i + 1) + '</td>'
              + '<td style="padding:var(--space-2) var(--space-1);"><a href="' + profileLink + '" style="color:var(--text-primary);font-weight:500;text-decoration:none;">' + escapeHtml(e.display_name || 'Anon profile') + '</a></td>'
              + '<td style="padding:var(--space-2) var(--space-1);font-weight:600;">' + formatLight(e.earnings_light || 0) + '</td>'
              + '<td style="padding:var(--space-2) var(--space-1);">' + flag + '</td>'
              + '<td style="padding:var(--space-2) var(--space-1);">' + (featured ? '<span style="' + featuredStyle + '">' + featured + '</span>' : '') + '</td>'
              + '</tr>';
          }).join('');
        })
        .catch(function() {
          if (tbody) tbody.innerHTML = renderTableState(5, 'error', 'Could not load the leaderboard', 'Try again in a moment.');
        });
    }

    // Leaderboard period click handlers
    document.querySelectorAll('[data-lb-period]').forEach(function(el) {
      el.addEventListener('click', function() { loadLeaderboard(this.dataset.lbPeriod); });
    });

    // Format relative time for newly published/acquired
    function formatTimeAgo(dateStr) {
      if (!dateStr) return '';
      var ms = Date.now() - new Date(dateStr).getTime();
      var h = Math.floor(ms / 3600000);
      var d = Math.floor(ms / 86400000);
      if (h < 1) return 'now';
      if (h < 24) return h + 'h';
      if (d < 30) return d + 'd';
      return Math.floor(d / 30) + 'mo';
    }

    // Load all market page data
    function loadMarketPage() {
      loadPlatformStats();
      loadNewlyPublished();
      loadNewlyAcquired();
      loadLeaderboard();
    }

    // Load shared apps
    function loadSharedApps() {
      var el = document.getElementById('sharedAppList');
      if (!el || !authToken) return;
      el.innerHTML = renderShellState('loading', 'Loading shared apps', 'Checking what other people have shared with you.', { compact: true });
      fetch('/api/apps/me/library?tab=shared', {
        headers: { 'Authorization': 'Bearer ' + authToken },
      })
        .then(function(r) { return r.json(); })
        .then(function(items) {
          if (!items || items.length === 0) {
            el.innerHTML = renderShellState('empty', 'Nothing shared with you yet', 'Shared apps and pages will appear here when someone grants you access.', { compact: true });
            return;
          }
          el.innerHTML = items.map(function(item) {
            return renderMarketplaceCard({
              id: item.id,
              name: item.name,
              slug: item.slug,
              description: item.description || '',
              type: item.type || 'app',
              likes: 0,
              runs_30d: 0,
              fully_native: true
            });
          }).join('');
        })
        .catch(function() {
          el.innerHTML = renderShellState('error', 'Could not load shared apps', 'Try again in a moment.', { compact: true });
        });
    }

    // ===== Profile View =====
    var _profileSlug = '${profileSlug || ""}';

    function loadProfilePage(slug) {
      var el = document.getElementById('profileContent');
      if (!el) return;
      el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:var(--space-8) 0;text-align:center;">Loading profile...</div>';

      fetch('/api/user/profile/' + encodeURIComponent(slug))
        .then(function(r) {
          if (!r.ok) throw new Error('Not found');
          return r.json();
        })
        .then(function(profile) { renderProfileView(profile); })
        .catch(function() {
          el.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:var(--space-8) 0;text-align:center;">Profile not found.</div>';
        });
    }

    function renderProfileView(profile) {
      var el = document.getElementById('profileContent');
      if (!el) return;
      var flag = getFlagEmoji(profile.country);
      var tierBadge = profile.tier && profile.tier !== 'free'
        ? '<span style="font-size:11px;padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:3px;font-weight:600;margin-left:var(--space-2);">' + escapeHtml(profile.tier.charAt(0).toUpperCase() + profile.tier.slice(1)) + '</span>'
        : '';
      var since = new Date(profile.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      var stats = profile.stats || {};
      var initial = (profile.display_name || 'U').charAt(0).toUpperCase();
      var avatarHtml = profile.avatar_url
        ? '<img src="' + escapeHtml(profile.avatar_url) + '" style="width:72px;height:72px;border-radius:50%;object-fit:cover;">'
        : '<span style="font-size:24px;font-weight:700;color:var(--text-primary);">' + initial + '</span>';

      var html = ''
        // Header
        + '<div style="border:1px solid var(--border);padding:var(--space-6);margin-bottom:var(--space-6);">'
        + '<div style="display:flex;gap:var(--space-5);align-items:center;margin-bottom:var(--space-5);">'
        + '<div style="width:72px;height:72px;border-radius:50%;background:var(--bg-raised);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + avatarHtml + '</div>'
        + '<div>'
        + '<div style="font-size:20px;font-weight:700;">' + escapeHtml(profile.display_name || 'Anonymous') + tierBadge + '</div>'
        + '<div style="font-size:13px;color:var(--text-muted);">' + (flag ? flag + ' &middot; ' : '') + 'Active since ' + since + '</div>'
        + '</div>'
        + '</div>'
        // Stats row
        + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);">'
        + '<div style="background:var(--bg-raised);padding:var(--space-3) var(--space-4);"><div style="font-size:11px;color:var(--text-muted);">Lifetime gross</div><div style="font-size:18px;font-weight:700;font-family:monospace;">' + formatLight(stats.lifetime_gross_light || 0) + '</div></div>'
        + '<div style="background:var(--bg-raised);padding:var(--space-3) var(--space-4);"><div style="font-size:11px;color:var(--text-muted);">Published</div><div style="font-size:18px;font-weight:700;">' + (stats.published_count || 0) + '</div></div>'
        + '<div style="background:var(--bg-raised);padding:var(--space-3) var(--space-4);"><div style="font-size:11px;color:var(--text-muted);">Acquired</div><div style="font-size:18px;font-weight:700;">' + (stats.acquired_count || 0) + '</div></div>'
        + '<div style="background:var(--bg-raised);padding:var(--space-3) var(--space-4);"><div style="font-size:11px;color:var(--text-muted);">Featured</div><div style="font-size:14px;font-weight:600;">' + (profile.featured_app ? escapeHtml(profile.featured_app.name) : '-') + '</div></div>'
        + '</div>'
        + '</div>';

      // Profile tabs
      html += '<div class="marketplace-filters" style="margin-bottom:var(--space-4);">'
        + '<button class="marketplace-filter active" data-profile-tab="published">Published tools</button>'
        + '<button class="marketplace-filter" data-profile-tab="acquisitions">Acquisitions</button>'
        + '</div>';

      // Published tab
      html += '<div id="profilePublishedTab">';
      if (profile.published && profile.published.length > 0) {
        html += profile.published.map(function(app) {
          var pubDate = app.first_published_at ? new Date(app.first_published_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '';
          return '<div style="border:1px solid var(--border);padding:var(--space-3) var(--space-4);margin-bottom:var(--space-2);cursor:pointer;" onclick="window.location.href=\\'/apps/' + app.slug + '\\';">'
            + '<div style="display:flex;justify-content:space-between;align-items:flex-start;">'
            + '<div>'
            + '<div style="font-size:14px;font-weight:600;">' + escapeHtml(app.name) + '</div>'
            + '<div style="font-size:12px;color:var(--text-muted);">MCP server</div>'
            + '</div>'
            + '</div>'
            + (app.description ? '<div style="font-size:13px;color:var(--text-secondary);margin-top:var(--space-2);line-height:1.4;">' + escapeHtml((app.description || '').slice(0, 200)) + '</div>' : '')
            + '<div style="font-size:12px;color:var(--text-muted);margin-top:var(--space-2);display:flex;gap:var(--space-4);">'
            + (app.runs_30d ? '<span>30d runs <strong>' + app.runs_30d.toLocaleString() + '</strong></span>' : '')
            + (pubDate ? '<span>Published <strong>' + pubDate + '</strong></span>' : '')
            + (app.current_version ? '<span>Version <strong>' + escapeHtml(app.current_version) + '</strong></span>' : '')
            + '</div>'
            + '</div>';
        }).join('');
      } else {
        html += '<div style="font-size:13px;color:var(--text-muted);padding:var(--space-4) 0;">No published tools yet.</div>';
      }
      html += '</div>';

      // Acquisitions tab (hidden)
      html += '<div id="profileAcquisitionsTab" style="display:none;">';
      if (profile.acquisitions && profile.acquisitions.length > 0) {
        html += '<div style="border:1px solid var(--border);">'
          + profile.acquisitions.map(function(a, i) {
            var border = i > 0 ? 'border-top:1px solid var(--border);' : '';
            var date = new Date(a.acquired_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-3) var(--space-4);' + border + '">'
              + '<div>'
              + '<div style="font-size:14px;font-weight:500;">' + escapeHtml(a.app_name) + '</div>'
              + (a.app_slug ? '<div style="font-size:12px;color:var(--text-muted);">' + escapeHtml(a.app_slug) + '</div>' : '')
              + '</div>'
              + '<div style="text-align:right;">'
              + '<div style="font-size:14px;font-weight:600;">' + formatLight(a.price_light || 0) + '</div>'
              + '<div style="font-size:12px;color:var(--text-muted);">' + date + '</div>'
              + '</div>'
              + '</div>';
          }).join('')
          + '</div>';
        // Summary stats
        var totalSpend = profile.acquisitions.reduce(function(s, a) { return s + (a.price_light || 0); }, 0);
        var avgDeal = Math.round(totalSpend / profile.acquisitions.length);
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);margin-top:var(--space-4);">'
          + '<div style="background:var(--bg-raised);padding:var(--space-3) var(--space-4);"><div style="font-size:11px;color:var(--text-muted);">Total acquisition spend</div><div style="font-size:18px;font-weight:700;font-family:monospace;">' + formatLight(totalSpend) + '</div></div>'
          + '<div style="background:var(--bg-raised);padding:var(--space-3) var(--space-4);"><div style="font-size:11px;color:var(--text-muted);">Avg deal size</div><div style="font-size:18px;font-weight:700;font-family:monospace;">' + formatLight(avgDeal) + '</div></div>'
          + '</div>';
      } else {
        html += '<div style="font-size:13px;color:var(--text-muted);padding:var(--space-4) 0;">No acquisitions yet.</div>';
      }
      html += '</div>';

      el.innerHTML = html;

      // Profile tab click handlers
      el.querySelectorAll('[data-profile-tab]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var tab = this.dataset.profileTab;
          el.querySelectorAll('[data-profile-tab]').forEach(function(b) {
            b.classList.toggle('active', b.dataset.profileTab === tab);
          });
          var pub = document.getElementById('profilePublishedTab');
          var acq = document.getElementById('profileAcquisitionsTab');
          if (pub) pub.style.display = tab === 'published' ? 'block' : 'none';
          if (acq) acq.style.display = tab === 'acquisitions' ? 'block' : 'none';
        });
      });
    }

    // Profile auto-load is handled in updateAuthUI after auth is resolved

    // ===== Profile Settings =====
    var COUNTRIES = [
      ['US','United States'],['GB','United Kingdom'],['CA','Canada'],['AU','Australia'],['DE','Germany'],
      ['FR','France'],['JP','Japan'],['KR','South Korea'],['BR','Brazil'],['IN','India'],['CN','China'],
      ['NL','Netherlands'],['SE','Sweden'],['NO','Norway'],['DK','Denmark'],['FI','Finland'],['CH','Switzerland'],
      ['AT','Austria'],['BE','Belgium'],['ES','Spain'],['IT','Italy'],['PT','Portugal'],['IE','Ireland'],
      ['PL','Poland'],['CZ','Czech Republic'],['RO','Romania'],['HU','Hungary'],['SK','Slovakia'],
      ['SG','Singapore'],['HK','Hong Kong'],['TW','Taiwan'],['NZ','New Zealand'],['IL','Israel'],
      ['AE','UAE'],['SA','Saudi Arabia'],['ZA','South Africa'],['NG','Nigeria'],['KE','Kenya'],
      ['EG','Egypt'],['MX','Mexico'],['AR','Argentina'],['CL','Chile'],['CO','Colombia'],['PE','Peru'],
      ['TH','Thailand'],['VN','Vietnam'],['PH','Philippines'],['ID','Indonesia'],['MY','Malaysia'],
      ['RU','Russia'],['UA','Ukraine'],['TR','Turkey'],['GR','Greece'],['HR','Croatia'],['RS','Serbia'],
    ].sort(function(a, b) { return a[1].localeCompare(b[1]); });

    function populateProfileSettings() {
      var countrySelect = document.getElementById('profileCountrySelect');
      if (countrySelect && countrySelect.options.length <= 1) {
        COUNTRIES.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = c[0];
          opt.textContent = getFlagEmoji(c[0]) + ' ' + c[1];
          countrySelect.appendChild(opt);
        });
      }

      // Set current values from userProfile
      if (userProfile) {
        if (countrySelect && userProfile.country) countrySelect.value = userProfile.country;
        // Populate featured app select with user's apps
        var featuredSelect = document.getElementById('profileFeaturedSelect');
        if (featuredSelect && apps.length > 0) {
          // Clear existing options except "None"
          while (featuredSelect.options.length > 1) featuredSelect.options.remove(1);
          apps.forEach(function(app) {
            var opt = document.createElement('option');
            opt.value = app.id;
            opt.textContent = app.name;
            featuredSelect.appendChild(opt);
          });
          if (userProfile.featured_app_id) featuredSelect.value = userProfile.featured_app_id;
        }
      }
    }

    window.saveProfileSettings = function() {
      var country = (document.getElementById('profileCountrySelect') || {}).value || null;
      var featuredAppId = (document.getElementById('profileFeaturedSelect') || {}).value || null;

      fetch('/api/user', {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + authToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ country: country || null, featured_app_id: featuredAppId || null }),
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          userProfile = data;
          var saved = document.getElementById('profileSettingsSaved');
          if (saved) {
            saved.style.display = 'inline';
            setTimeout(function() { saved.style.display = 'none'; }, 2000);
          }
        })
        .catch(function() { alert('Failed to save profile settings.'); });
    };

    // ===== Marketplace =====
    var marketplaceType = 'all';
    var marketplaceDebounce = null;
    var marketplaceLoaded = false;
    var savedAppIds = new Set();

    // Load user's saved app IDs for heart state
    async function loadSavedAppIds() {
      if (!authToken) return;
      try {
        var res = await fetch('/api/apps/me/library?tab=saved', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          var items = await res.json();
          savedAppIds = new Set(items.filter(function(i) { return i.type === 'app'; }).map(function(i) { return i.id; }));
          // Update any visible hearts
          document.querySelectorAll('.marketplace-heart').forEach(function(el) {
            var isSaved = savedAppIds.has(el.dataset.appId);
            el.classList.toggle('saved', isSaved);
            var svg = el.querySelector('path');
            if (svg) svg.setAttribute('fill', isSaved ? 'currentColor' : 'none');
          });
        }
      } catch(e) {}
    }

    function toggleSaveApp(appId, el) {
      if (!authToken) { showToast('Sign in to save apps', 'error'); return; }
      var isSaved = savedAppIds.has(appId);
      var method = isSaved ? 'DELETE' : 'POST';
      fetch('/api/apps/' + appId + '/save', {
        method: method,
        headers: { 'Authorization': 'Bearer ' + authToken },
      }).then(function(res) {
        if (res.ok) {
          if (isSaved) {
            savedAppIds.delete(appId);
            el.classList.remove('saved');
          } else {
            savedAppIds.add(appId);
            el.classList.add('saved');
          }
          // Update SVG fill
          var svg = el.querySelector('path');
          if (svg) svg.setAttribute('fill', savedAppIds.has(appId) ? 'currentColor' : 'none');
          // Invalidate library cache so Saved tab refreshes
          savedItems = [];
        }
      }).catch(function() {
        showToast('Failed to save app', 'error');
      });
    }

    function renderMarketplaceCommerce(item) {
      if (!item || item.type !== 'app' || !item.marketplace) return '';
      var market = item.marketplace;
      var hasAsk = typeof market.ask_price_light === 'number' && Number.isFinite(market.ask_price_light);
      var hasBid = typeof market.highest_bid_light === 'number' && Number.isFinite(market.highest_bid_light);
      var label = '';
      var chip = '';
      var chipClass = '';

      if (market.status === 'sold') {
        label = 'Acquired';
        chip = 'Closed';
      } else if (market.status === 'ineligible') {
        label = 'Not tradable';
        chip = 'Data-bound';
      } else if (hasAsk) {
        label = formatLight(market.ask_price_light);
        chip = market.instant_buy ? 'Acquire now' : 'Listed';
        chipClass = market.instant_buy ? ' buy' : '';
      } else if (hasBid) {
        label = 'Top bid ' + formatLight(market.highest_bid_light);
        chip = market.active_bid_count === 1 ? '1 bid' : market.active_bid_count + ' bids';
      } else if (market.status === 'open_to_offers') {
        label = 'Open to offers';
        chip = 'Offers';
      }

      if (!label) return '';

      return '<div class="marketplace-commerce-row">' +
        '<span class="marketplace-price">' + escapeHtml(label) + '</span>' +
        '<span class="marketplace-commerce-chip' + chipClass + '">' + escapeHtml(chip) + '</span>' +
      '</div>';
    }

    function renderMarketplaceCard(item) {
      var badge = item.type === 'app' ? (gpuSupportEnabled && item.runtime === 'gpu' ? 'GPU' : 'MCP') : '.MD';
      var desc = item.description || '';
      var shortDesc = desc.length > 120 ? desc.slice(0, 120) + '...' : desc;
      var stats = '';
      var trustHtml = '';
      var commerceHtml = renderMarketplaceCommerce(item);
      if (item.type === 'app') {
        var parts = [];
        if (item.likes > 0) parts.push(item.likes + ' likes');
        if (item.runs_30d > 0) parts.push(item.runs_30d + ' runs');
        if (gpuSupportEnabled && item.runtime === 'gpu' && item.gpu_type) parts.push(item.gpu_type);
        else if (item.fully_native) parts.push('native');
        if (parts.length > 0) stats = '<div class="marketplace-stats">' + parts.join(' &middot; ') + '</div>';
        trustHtml = renderMarketplaceTrust(getTrustCard(item));
      } else {
        var tagStr = (item.tags || []).slice(0, 3).join(', ');
        if (tagStr) stats = '<div class="marketplace-stats">' + tagStr + '</div>';
      }

      // Skills: open in new tab as before
      if (item.type !== 'app') {
        return '<div class="marketplace-card" onclick="window.open(\\\'' + (item.url || '/p/' + item.slug) + '\\\', \\\'_blank\\\')">'
          + '<div class="marketplace-card-header">'
          + '<span class="marketplace-card-name">' + escapeHtml(item.name || item.slug) + '</span>'
          + '<span class="marketplace-badge">' + badge + '</span>'
          + '</div>'
          + (shortDesc ? '<div class="marketplace-card-desc">' + escapeHtml(shortDesc) + '</div>' : '')
          + stats
          + '</div>';
      }

      // Apps: click-through to unified /app/:id store page.
      // Heart button remains for quick Save without leaving the list.
      var heartSaved = savedAppIds.has(item.id) ? ' saved' : '';
      var heartSvg = '<span class="marketplace-heart' + heartSaved + '" data-app-id="' + item.id + '" onclick="event.stopPropagation(); toggleSaveApp(\\\'' + item.id + '\\\', this)" title="Save to Library">'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="' + (heartSaved ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        + '</span>';

      // data-app-name held as an attribute (auto-escaped by escapeHtml) so
      // we don't have to escape into an inline onclick handler.
      return '<div class="marketplace-card" data-app-id="' + item.id + '" data-app-name="' + escapeHtml(item.name || item.slug || '') + '" onclick="navigateToAppStore(this)">'
        + '<div class="marketplace-card-header">'
        + '<span class="marketplace-card-name">' + escapeHtml(item.name || item.slug) + '</span>'
        + '<span class="marketplace-badge">' + badge + '</span>'
        + heartSvg
        + '</div>'
        + (shortDesc ? '<div class="marketplace-card-desc">' + escapeHtml(shortDesc) + '</div>' : '')
        + commerceHtml
        + trustHtml
        + stats
        + '</div>';
    }

    function loadMarketplace(query, type) {
      var resultsEl = document.getElementById('marketplaceResults');
      if (!resultsEl) return;
      resultsEl.innerHTML = renderShellState('loading', query ? 'Searching marketplace' : 'Loading marketplace', query ? 'Looking for matching apps and capabilities.' : 'Pulling the latest marketplace listings.', { compact: true });

      var params = new URLSearchParams();
      if (query) params.set('q', query);
      if (type && type !== 'all') params.set('type', type);
      params.set('limit', '30');
      // Use sectioned layout for browse mode (no query)
      if (!query) params.set('format', 'sections');

      fetch('/api/discover/marketplace?' + params.toString())
        .then(function(r) { return r.json(); })
        .then(function(data) {
          // Sectioned browse mode
          if (data.sections && Array.isArray(data.sections)) {
            if (data.sections.length === 0) {
              resultsEl.innerHTML = renderShellState('empty', 'No marketplace listings yet', 'Published apps will appear here once they are available.', { compact: true });
              return;
            }
            resultsEl.innerHTML = data.sections.map(function(section) {
              return '<div class="marketplace-section">'
                + '<div class="marketplace-section-title">' + escapeHtml(section.title) + '</div>'
                + '<div class="marketplace-section-grid">'
                + section.results.map(renderMarketplaceCard).join('')
                + '</div>'
                + '</div>';
            }).join('');
            marketplaceLoaded = true;
            return;
          }

          // Flat search results
          if (!data.results || data.results.length === 0) {
            resultsEl.innerHTML = renderShellState('empty', 'No matching apps', 'Try a different search term or browse all listings.', { compact: true });
            return;
          }
          resultsEl.innerHTML = data.results.map(renderMarketplaceCard).join('');
          marketplaceLoaded = true;
        })
        .catch(function() {
          resultsEl.innerHTML = renderShellState('error', 'Marketplace unavailable', 'We could not load marketplace listings right now.', { compact: true });
        });
    }

    // Market card click → navigate to unified /app/:id store page.
    // Inside desktop (embed iframe), we postMessage to the parent which
    // flips the in-app view to 'app-store'. Outside desktop, we hard-nav.
    function navigateToAppStore(cardEl) {
      if (!cardEl || !cardEl.dataset) return;
      var appId = cardEl.dataset.appId;
      var appName = cardEl.dataset.appName || '';
      if (!appId) return;
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'navigate',
            to: 'app-store',
            appId: appId,
            appName: appName,
          }, '*');
          return;
        }
      } catch (e) { /* cross-origin parent — fall through to hard nav */ }
      window.location.href = '/app/' + encodeURIComponent(appId);
    }
    window.navigateToAppStore = navigateToAppStore;

    // Fetch the user's API key from the canonical token schema.
    async function ensureApiKey() {
      if (!authToken) return '';
      var authHeaders = { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' };
      try {
        var res = await fetch('/api/user/tokens', { headers: authHeaders });
        if (!res.ok) return '';
        var data = await res.json();
        var tokens = data.tokens || data;
        var defaultToken = tokens.find(function(t) { return t.name === 'default'; }) || tokens[0];
        if (defaultToken && defaultToken.plaintext_token) return defaultToken.plaintext_token;

        // Token row without stored plaintext — regenerate against the canonical schema
        if (defaultToken && !defaultToken.plaintext_token) {
          await fetch('/api/user/tokens/' + defaultToken.id, { method: 'DELETE', headers: authHeaders });
          var createRes = await fetch('/api/user/tokens', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ name: 'default' }),
          });
          if (createRes.ok) {
            var createData = await createRes.json();
            if (createData.plaintext_token) return createData.plaintext_token;
          }
        }

        // No tokens at all — create one
        if (!defaultToken) {
          var newRes = await fetch('/api/user/tokens', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ name: 'default' }),
          });
          if (newRes.ok) {
            var newData = await newRes.json();
            if (newData.plaintext_token) return newData.plaintext_token;
          }
        }
      } catch { /* fall through */ }
      return '';
    }

    async function copyMarketplaceInstructions(appId, btn) {
      var origHTML = btn.innerHTML;
      btn.style.pointerEvents = 'none';
      btn.innerHTML = '<span class="btn-spinner"></span> <span>Generating...</span>';
      try {
        // Fetch instructions and ensure API key exist in parallel
        var results = await Promise.all([
          fetch('/api/apps/' + appId + '/instructions').then(function(r) { return r.json(); }),
          ensureApiKey()
        ]);
        var text = results[0].instructions || '';
        var apiKey = results[1];
        if (apiKey) {
          text = text.replace(/\\{TOKEN\\}/g, apiKey);
        }
        await navigator.clipboard.writeText(text);
        var checkSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btn.innerHTML = checkSvg + ' <span>Copied! Paste to agent</span>';
        setTimeout(function() { btn.innerHTML = origHTML; btn.style.pointerEvents = ''; }, 5000);
      } catch {
        btn.innerHTML = '<span>Error</span>';
        setTimeout(function() { btn.innerHTML = origHTML; btn.style.pointerEvents = ''; }, 2000);
      }
    }
    window.copyMarketplaceInstructions = copyMarketplaceInstructions;
    window.toggleSaveApp = toggleSaveApp;

    // Marketplace search input
    var mpSearchInput = document.getElementById('marketplaceSearch');
    if (mpSearchInput) {
      mpSearchInput.addEventListener('input', function() {
        var q = this.value.trim();
        if (marketplaceDebounce) clearTimeout(marketplaceDebounce);
        marketplaceDebounce = setTimeout(function() {
          loadMarketplace(q, marketplaceType);
        }, 300);
      });
    }

    // ===== My Offers =====
    function loadMyOffers() {
      var inEl = document.getElementById('offersIncoming');
      var outEl = document.getElementById('offersOutgoing');
      if (!inEl || !outEl) return;

      inEl.innerHTML = '<div class="loading-text">Loading incoming offers...</div>';
      outEl.innerHTML = '<div class="loading-text">Loading outgoing bids...</div>';

      fetch('/api/marketplace/offers', {
        headers: { 'Authorization': 'Bearer ' + authToken },
      }).then(function(res) {
        if (!res.ok) throw new Error('Failed to load');
        return res.json();
      }).then(function(data) {
        var incoming = data.incoming || [];
        var outgoing = data.outgoing || [];

        // Incoming bids (as seller)
        if (incoming.length === 0) {
          inEl.innerHTML =
            '<h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-3);color:var(--text-primary)">Incoming Bids</h3>' +
            '<p style="font-size:13px;color:var(--text-muted)">No active bids on your apps.</p>';
        } else {
          inEl.innerHTML =
            '<h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-3);color:var(--text-primary)">Incoming Bids (' + incoming.length + ')</h3>' +
            '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
              '<thead><tr style="border-bottom:1px solid var(--border);text-align:left">' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">App</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Bidder</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Amount</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Message</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Time</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Actions</th>' +
              '</tr></thead><tbody>' +
              incoming.map(function(bid) {
                return '<tr style="border-bottom:1px solid var(--border)">' +
                  '<td style="padding:8px 12px"><a href="/a/' + bid.app_id + '/offers" style="color:var(--accent)">' + escapeHtml(bid.app_name || 'Unknown') + '</a></td>' +
                  '<td style="padding:8px 12px">' + escapeHtml(bid.bidder_email || 'Unknown') + '</td>' +
                  '<td style="padding:8px 12px;font-weight:600;color:var(--success)">' + formatLight(bid.amount_light) + '</td>' +
                  '<td style="padding:8px 12px;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(bid.message || '-') + '</td>' +
                  '<td style="padding:8px 12px;color:var(--text-muted)">' + relTime(bid.created_at) + '</td>' +
                  '<td style="padding:8px 12px">' +
                    '<button class="btn btn-primary btn-sm" style="margin-right:4px" onclick="acceptBid(\\\'' + bid.bid_id + '\\\',\\\'' + bid.app_id + '\\\')">Accept</button>' +
                    '<button class="btn btn-secondary btn-sm" onclick="rejectBid(\\\'' + bid.bid_id + '\\\',\\\'' + bid.app_id + '\\\')">Reject</button>' +
                  '</td>' +
                '</tr>';
              }).join('') +
            '</tbody></table>';
        }

        // Outgoing bids (as buyer)
        if (outgoing.length === 0) {
          outEl.innerHTML =
            '<h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-3);color:var(--text-primary)">Your Bids</h3>' +
            '<p style="font-size:13px;color:var(--text-muted)">You haven\\'t placed any bids.</p>';
        } else {
          outEl.innerHTML =
            '<h3 style="font-size:14px;font-weight:600;margin-bottom:var(--space-3);color:var(--text-primary)">Your Bids (' + outgoing.length + ')</h3>' +
            '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
              '<thead><tr style="border-bottom:1px solid var(--border);text-align:left">' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">App</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Amount</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Status</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Escrow</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Time</th>' +
                '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Actions</th>' +
              '</tr></thead><tbody>' +
              outgoing.map(function(bid) {
                var statusColor = bid.status === 'active' ? 'var(--accent)' : bid.status === 'accepted' ? 'var(--success)' : 'var(--text-muted)';
                var cancelBtn = bid.status === 'active'
                  ? '<button class="btn btn-secondary btn-sm" onclick="cancelBidFromUI(\\\'' + bid.bid_id + '\\\',\\\'' + bid.app_id + '\\\')">Cancel</button>'
                  : '';
                return '<tr style="border-bottom:1px solid var(--border)">' +
                  '<td style="padding:8px 12px"><a href="/a/' + bid.app_id + '/offers" style="color:var(--accent)">' + escapeHtml(bid.app_name || 'Unknown') + '</a></td>' +
                  '<td style="padding:8px 12px;font-weight:600">' + formatLight(bid.amount_light) + '</td>' +
                  '<td style="padding:8px 12px"><span style="color:' + statusColor + '">' + bid.status + '</span></td>' +
                  '<td style="padding:8px 12px;color:var(--text-muted)">' + bid.escrow_status + '</td>' +
                  '<td style="padding:8px 12px;color:var(--text-muted)">' + relTime(bid.created_at) + '</td>' +
                  '<td style="padding:8px 12px">' + cancelBtn + '</td>' +
                '</tr>';
              }).join('') +
            '</tbody></table>';
        }
      }).catch(function() {
        inEl.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Could not load offers.</p>';
        outEl.innerHTML = '';
      });
    }

    // Marketplace filter pills
    document.querySelectorAll('[data-mp-type]').forEach(function(el) {
      el.addEventListener('click', function() {
        marketplaceType = this.dataset.mpType;
        document.querySelectorAll('[data-mp-type]').forEach(function(btn) {
          btn.classList.toggle('active', btn.dataset.mpType === marketplaceType);
        });
        var q = (document.getElementById('marketplaceSearch') || {}).value || '';
        loadMarketplace(q.trim(), marketplaceType);
      });
    });

    // ===== App Sidebar =====
    let activeAppSection = 'overview';

    function switchAppSection(section) {
      activeAppSection = section;

      // Update sidebar active state
      document.querySelectorAll('[data-app-section]').forEach(function(el) {
        el.classList.toggle('active', el.dataset.appSection === section);
      });

      // Show/hide panels
      var panelMap = {
        overview: 'appOverviewPanel',
        permissions: 'appPermissionsPanel',
        environment: 'appEnvironmentPanel',
        payments: 'appPaymentsPanel',
        logs: 'appLogsPanel',
        offers: 'appOffersPanel',
        'store-listing': 'appStoreListingPanel'
      };

      Object.values(panelMap).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      var panel = document.getElementById(panelMap[section]);
      if (panel) panel.style.display = 'block';

      // Update URL
      if (section === 'overview') {
        history.replaceState({}, '', '/a/' + currentAppId);
      } else {
        history.replaceState({}, '', '/a/' + currentAppId + '/' + section);
      }
    }

    // Toggle Payments, Offers, and App Store tabs based on app visibility.
    // "Published" here means the app is publicly discoverable — matches
    // both legacy 'published' value and canonical 'public' value.
    function updatePublicTabVisibility() {
      var vis = window._currentApp && window._currentApp.visibility;
      var isPublished = vis === 'published' || vis === 'public';
      var paymentsTab = document.querySelector('[data-app-section="payments"]');
      var offersTab = document.querySelector('[data-app-section="offers"]');
      var storeListingTab = document.querySelector('[data-app-section="store-listing"]');
      if (paymentsTab) paymentsTab.style.display = isPublished ? '' : 'none';
      if (offersTab) offersTab.style.display = isPublished ? '' : 'none';
      if (storeListingTab) storeListingTab.style.display = isPublished ? '' : 'none';
      // If on a hidden tab, redirect to overview
      if (!isPublished && (activeAppSection === 'payments' || activeAppSection === 'offers' || activeAppSection === 'store-listing')) {
        switchAppSection('overview');
      }
    }

    // App sidebar click handlers
    document.querySelectorAll('[data-app-section]').forEach(function(el) {
      el.addEventListener('click', function() {
        switchAppSection(this.dataset.appSection);
      });
    });

    // Back button handler
    document.getElementById('appBackBtn')?.addEventListener('click', function(e) {
      e.preventDefault();
      navigateToDashboard();
    });

    // Nav copy instructions button
    document.getElementById('navCopyInstructionsBtn')?.addEventListener('click', async function() {
      var btn = document.getElementById('navCopyInstructionsBtn');
      var origText = btn.innerHTML;
      if (!setupCommandStr) {
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Generating...';
        btn.disabled = true;
        await generateSetupInstructions();
        btn.disabled = false;
      }
      if (setupCommandStr) {
        try {
          await navigator.clipboard.writeText(setupCommandStr);
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied. Paste to agent';
          btn.style.background = 'var(--text-primary)';
          btn.style.color = 'var(--bg-base)';
          setTimeout(function() {
            btn.innerHTML = origText;
            btn.style.background = '';
            btn.style.color = '';
          }, 5000);
        } catch(e) {
          btn.innerHTML = origText;
          showToast('Failed to copy', 'error');
        }
      } else {
        btn.innerHTML = origText;
        showToast('Could not generate setup instructions', 'error');
      }
    });

    // ===== Connection State Machine =====
    function updateConnectionStatus(state, detail) {
      const el = document.getElementById('connectionStatus');
      if (!el) return;
      el.className = 'connection-status';
      
      if (state === 'waiting') {
        el.classList.add('connecting');
        el.innerHTML = '<div class="status-dot"></div><span>Waiting for agent to connect...</span>';
        el.classList.remove('hidden');
      } else if (state === 'connected') {
        el.classList.add('connected');
        el.innerHTML = '<div class="status-dot"></div><span>Agent connected!' + (detail ? ' ' + escapeHtml(detail) : '') + '</span>';
        el.classList.remove('hidden');
        // After 3 seconds, transition to dashboard if they have apps
        setTimeout(function() {
          if (apps.length > 0) {
            navigateToDashboard();
          } else {
            loadApps().then(function() {
              if (apps.length > 0) navigateToDashboard();
            });
          }
        }, 3000);
      } else if (state === 'error') {
        el.classList.add('error');
        el.innerHTML = '<div class="status-dot"></div><span>Connection issue. ' + (detail || 'Try copying again.') + '</span>';
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }

    function startConnectionPolling(tokenId) {
      if (connectionPollInterval) clearInterval(connectionPollInterval);
      newlyCreatedTokenId = tokenId;
      let attempts = 0;
      const maxAttempts = 40; // 2 minutes at 3s intervals

      updateConnectionStatus('waiting');

      connectionPollInterval = setInterval(async function() {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(connectionPollInterval);
          connectionPollInterval = null;
          updateConnectionStatus('error', 'Timed out after 2 minutes.');
          return;
        }

        try {
          const res = await fetch('/api/user/tokens', {
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
          if (!res.ok) return;
          const tokens = await res.json();
          const token = tokens.find(function(t) { return t.id === tokenId; });
          if (token && token.last_used_at) {
            clearInterval(connectionPollInterval);
            connectionPollInterval = null;
            updateConnectionStatus('connected');
            // Reload apps to pick up any newly created ones
            await loadApps();
          }
        } catch {}
      }, 3000);
    }

    // ===== Setup Instructions =====
    function showSetupBlock() {
      const block = document.getElementById('setupBlock');
      if (block) block.style.display = 'block';
    }

    async function generateSetupInstructions() {
      try {
        // Fetch onboarding template and create token in parallel
        var [templateRes, tokenRes] = await Promise.all([
          fetch('/api/onboarding/instructions'),
          fetch('/api/user/tokens', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + authToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'Agent Setup — ' + new Date().toLocaleString() }),
          })
        ]);

        // Use dynamic template, fall back to minimal hardcoded string
        var template = "I'd like you to set up Ultralight, the instant MCP app platform.\\nRun: npx ultralightpro setup --token {TOKEN}";
        if (templateRes.ok) {
          try {
            var templateData = await templateRes.json();
            if (templateData.template) template = templateData.template;
          } catch (e) { /* use fallback template */ }
        }

        if (!tokenRes.ok) {
          setupCommandStr = window.location.origin + '/mcp/platform';
          return;
        }

        var data = await tokenRes.json();
        var token = data.plaintext_token;
        var tokenId = data.id;

        setupCommandStr = template.replace(/\\{TOKEN\\}/g, token).replace(/\\{SESSION_NOTE\\}/g, '');
        localStorage.setItem('ultralight_setup_v4', setupCommandStr);

        var commandEl = document.getElementById('setupCode');
        if (commandEl) commandEl.textContent = setupCommandStr;

        showSetupBlock();

        // Start polling for connection
        if (tokenId) startConnectionPolling(tokenId);

      } catch (err) {
        setupCommandStr = window.location.origin + '/mcp/platform';
      }
    }

    // Generate setup instructions for unauthenticated visitors (provisional token)
    async function generateProvisionalInstructions() {
      // Fetch template and create provisional token in parallel
      var [templateRes, provRes] = await Promise.all([
        fetch('/api/onboarding/instructions'),
        fetch('/auth/provisional', { method: 'POST' })
      ]);

      // Use dynamic template, fall back to minimal hardcoded string
      var template = "I'd like you to set up Ultralight, the instant MCP app platform.\\nRun: npx ultralightpro setup --token {TOKEN}";
      if (templateRes.ok) {
        try {
          var templateData = await templateRes.json();
          if (templateData.template) template = templateData.template;
        } catch (e) { /* use fallback template */ }
      }

      if (!provRes.ok) {
        if (provRes.status === 429) {
          showToast('Rate limit reached. Please sign in instead.', 'error');
        }
        throw new Error('Failed to create provisional token');
      }

      var data = await provRes.json();
      var token = data.token;
      var tokenId = data.token_id;

      // Store provisional IDs for merge on OAuth sign-in
      localStorage.setItem('ultralight_provisional_token_id', tokenId);
      localStorage.setItem('ultralight_provisional_user_id', data.user_id);

      // Replace placeholders — provisional users get a session note about limits
      var sessionNote = '\\n> Note: This is a provisional session (50 calls/day, 5MB storage, no memory). Sign in at ultralight-api-iikqz.ondigitalocean.app to unlock full access and keep your data permanently.\\n';
      setupCommandStr = template.replace(/\\{TOKEN\\}/g, token).replace(/\\{SESSION_NOTE\\}/g, sessionNote);
      localStorage.setItem('ultralight_setup_v4', setupCommandStr);

      var commandEl = document.getElementById('setupCode');
      if (commandEl) commandEl.textContent = setupCommandStr;

      // Note: don't call startConnectionPolling() for provisional users —
      // it requires JWT auth which provisional users don't have.
      // Connection polling happens after they sign in and merge.
    }

    // Copy setup command
    document.getElementById('setupCopyBtn')?.addEventListener('click', async function() {
      if (!setupCommandStr) return;
      try {
        await navigator.clipboard.writeText(setupCommandStr);
        const btn = this;
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
        btn.classList.add('btn-success-flash');
        setTimeout(function() { btn.innerHTML = orig; btn.classList.remove('btn-success-flash'); }, 2000);
      } catch {
        showToast('Failed to copy. Select and copy manually.', 'error');
      }
    });

    // ===== Apps =====
    var activeLibTab = 'my-apps';
    var savedItems = [];
    var sharedItems = [];

    async function loadApps() {
      if (!authToken) return;
      const list = document.getElementById('appList');
      if (list) {
        list.innerHTML = renderShellState('loading', 'Loading your apps', 'Checking the apps you own and manage.', { compact: true });
      }
      try {
        const res = await fetch('/api/apps/me', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          apps = await res.json();
          renderAppList();
        } else if (list) {
          list.innerHTML = renderShellState('error', 'Could not load your apps', 'Try again in a moment.', { compact: true });
        }
      } catch {
        if (list) {
          list.innerHTML = renderShellState('error', 'Could not load your apps', 'Try again in a moment.', { compact: true });
        }
      }
    }

    function renderAppList(filterText) {
      const list = document.getElementById('appList');
      if (!list) return;

      const filtered = filterText
        ? apps.filter(function(a) {
            const searchStr = ((a.name || '') + ' ' + (a.description || '') + ' ' + (a.slug || '')).toLowerCase();
            return searchStr.indexOf(filterText.toLowerCase()) !== -1;
          })
        : apps;

      if (!filtered || filtered.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📡</div><div class="empty-state-title">' +
          (filterText ? 'No matching apps' : 'No apps yet') +
          '</div><div class="empty-state-desc">' +
          (filterText ? 'Try a different search term.' : 'Copy the agent instructions and paste them into your agent to deploy your first app.') +
          '</div></div>';
        return;
      }

      list.innerHTML = filtered.map(function(app) {
        const emoji = getAppEmoji(app.name || app.slug);
        const name = escapeHtml(app.name || app.slug || 'Untitled');
        const desc = escapeHtml((app.description || '').slice(0, 120));
        const version = escapeHtml(app.current_version || 'v1.0.0');
        const fnCount = getAppFunctions(app).functions.length;
        return '<div class="app-row" onclick="navigateToApp(\\\'' + app.id + '\\\')">' +
          '<div class="app-row-emoji">' + emoji + '</div>' +
          '<div class="app-row-info">' +
            '<div class="app-row-name">' + name +
              ' <span class="app-row-version">' + version + '</span>' +
              ' <span class="app-row-fn-count">' + fnCount + ' fn' + (fnCount !== 1 ? 's' : '') + '</span>' +
            '</div>' +
            (desc ? '<div class="app-row-desc">' + desc + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Search input listener
    document.getElementById('appSearchInput')?.addEventListener('input', function() {
      renderAppList(this.value);
    });

    // Library filter tabs
    document.querySelectorAll('[data-lib-tab]').forEach(function(el) {
      el.addEventListener('click', function() {
        activeLibTab = this.dataset.libTab;
        document.querySelectorAll('[data-lib-tab]').forEach(function(btn) {
          btn.classList.toggle('active', btn.dataset.libTab === activeLibTab);
        });
        if (activeLibTab === 'my-apps') {
          renderAppList();
        } else {
          loadLibraryTab(activeLibTab);
        }
      });
    });

    // Wallet sub-tab state
    var activeWalletTab = 'balance';
    var billingConfig = {
      canonical_light_per_usd: 100,
      wallet_light_per_usd: 95,
      wire_light_per_usd: 99,
      payout_light_per_usd: 100,
      platform_fee_rate: 0.15,
      card_minimum_cents: 2500,
      wire_minimum_cents: 2500,
      cloud_unit_light_per_1k: 1,
      storage_free_bytes: 104857600,
      storage_light_per_gb_month: 100,
      publish_deposit_enabled: true,
      published_hosting_meter_enabled: false,
      min_withdrawal_light: 5000,
      payout_policy_copy: 'Payouts are processed on the first business day of each month. Requests must be submitted at least 21 days before that payout date to be included. Purchased Light cannot be cashed out; only creator earnings are eligible for payout.',
      policy_copy: {
        purchasedLight: 'Purchased Light is spend-only platform credit. It cannot be cashed out, redeemed for money, or transferred directly between arbitrary accounts.',
        creatorEarnings: 'Creator earnings come from platform-mediated app activity and marketplace sales. Earned Light can be added to spendable balance or requested for payout through Stripe Connect while unconverted.',
        fundingTerms: 'By adding Light, you agree that purchased Light is spend-only platform credit and that authenticated funding transactions are governed by the Terms.',
        payoutTerms: 'By requesting a payout, you confirm that the amount is creator earnings and that payout timing, fees, and eligibility are governed by the Terms.',
        cloudUsage: 'Cloud usage is metered in cloud units and charged as exact fractional Light at the configured cloud-unit rate.',
        storagePolicy: 'The first 100MB of combined storage is included. Storage above that is charged at the configured GB-month rate.',
        freeCallSponsorship: 'Free calls use app-owner sponsorship for infrastructure when available. If the owner has no Light balance, the caller needs Light balance to continue.',
        termsUrl: '/terms'
      }
    };

    function getWalletLightPerUsd() {
      return billingConfig.wallet_light_per_usd || 95;
    }

    function getWireLightPerUsd() {
      return billingConfig.wire_light_per_usd || 99;
    }

    function getCanonicalLightPerUsd() {
      return billingConfig.canonical_light_per_usd || 100;
    }

    function getPayoutLightPerUsd() {
      return billingConfig.payout_light_per_usd || 100;
    }

    function getMinWithdrawalLight() {
      return billingConfig.min_withdrawal_light || 5000;
    }

    function getPlatformFeeRate() {
      return typeof billingConfig.platform_fee_rate === 'number' ? billingConfig.platform_fee_rate : 0.15;
    }

    function getPlatformFeePercentLabel() {
      return Math.round(getPlatformFeeRate() * 1000) / 10 + '%';
    }

    function getCardMinimumCents() {
      return billingConfig.card_minimum_cents || 2500;
    }

    function getWireMinimumCents() {
      return billingConfig.wire_minimum_cents || 2500;
    }

    function getPolicyCopy() {
      return billingConfig.policy_copy || {};
    }

    function getTermsUrl() {
      return getPolicyCopy().termsUrl || '/terms';
    }

    function renderTermsCopy(copy) {
      var termsUrl = getTermsUrl();
      var link = '<a href="' + escapeHtml(termsUrl) + '" style="color:var(--text-secondary);text-decoration:underline;">Terms</a>';
      var text = escapeHtml(copy || '');
      return text.indexOf('Terms') >= 0 ? text.replace(/Terms/g, link) : text + ' ' + link;
    }

    function walletTermsAccepted() {
      var checkbox = document.getElementById('walletTermsAccepted');
      return !!(checkbox && checkbox.checked);
    }

    function payoutTermsAccepted() {
      var checkbox = document.getElementById('payoutTermsAccepted');
      return !!(checkbox && checkbox.checked);
    }

    var walletExpressState = {
      stripe: null,
      elements: null,
      element: null,
      clientSecret: null,
      amountCents: 0,
    };
    var walletStripeJsPromise = null;
    var billingAddressState = {
      loaded: false,
      address: null,
    };
    var wireTransferState = {
      paymentIntentId: null,
      amountCents: 0,
    };

    function setWalletExpressStatus(message, tone) {
      var statusEl = document.getElementById('walletExpressStatus');
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.style.color = tone === 'error' ? 'var(--error)' : tone === 'success' ? 'var(--success)' : 'var(--text-muted)';
    }

    function setWireTransferStatus(message, tone) {
      var statusEl = document.getElementById('wireTransferStatus');
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.style.color = tone === 'error' ? 'var(--error)' : tone === 'success' ? 'var(--success)' : 'var(--text-muted)';
    }

    function setBillingAddressStatus(message, tone) {
      var statusEl = document.getElementById('billingAddressStatus');
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.style.color = tone === 'error' ? 'var(--error)' : tone === 'success' ? 'var(--success)' : 'var(--text-muted)';
    }

    function getWalletFundingAmountCents() {
      var input = document.getElementById('walletExpressAmountUsd');
      var value = input && input.value ? Number(input.value) : 25;
      if (!Number.isFinite(value)) value = 25;
      return Math.round(value * 100);
    }

    function getWireFundingAmountCents() {
      var input = document.getElementById('wireTransferAmountUsd');
      var value = input && input.value ? Number(input.value) : 500;
      if (!Number.isFinite(value)) value = 500;
      return Math.round(value * 100);
    }

    function formatUsdCents(cents) {
      return '$' + (Math.max(0, cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function setInputValue(id, value) {
      var input = document.getElementById(id);
      if (input) input.value = value || '';
    }

    function populateBillingAddressForm(address) {
      if (!address) return;
      setInputValue('billingAddressName', address.name || '');
      setInputValue('billingAddressLine1', address.line1 || '');
      setInputValue('billingAddressLine2', address.line2 || '');
      setInputValue('billingAddressCity', address.city || '');
      setInputValue('billingAddressState', address.state || '');
      setInputValue('billingAddressPostalCode', address.postal_code || '');
      setInputValue('billingAddressCountry', address.country || 'US');
    }

    function readBillingAddressPayload() {
      function value(id) {
        var input = document.getElementById(id);
        return input && input.value ? input.value.trim() : '';
      }
      var country = value('billingAddressCountry').toUpperCase();
      var payload = {
        name: value('billingAddressName') || undefined,
        line1: value('billingAddressLine1'),
        line2: value('billingAddressLine2') || undefined,
        city: value('billingAddressCity'),
        state: value('billingAddressState') || undefined,
        postal_code: value('billingAddressPostalCode'),
        country: country || 'US',
      };
      if (!payload.line1 || !payload.city || !payload.postal_code || !payload.country) {
        throw new Error('Billing address needs street, city, postal code, and country.');
      }
      if (!/^[A-Z]{2}$/.test(payload.country)) {
        throw new Error('Country must be a two-letter code.');
      }
      if ((payload.country === 'US' || payload.country === 'CA') && !payload.state) {
        throw new Error('State or province is required for US and CA addresses.');
      }
      return payload;
    }

    async function loadBillingAddress() {
      if (!authToken) return null;
      try {
        var res = await fetch('/api/user/billing-address', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) return null;
        var data = await res.json();
        billingAddressState = {
          loaded: true,
          address: data.billing_address || null,
        };
        populateBillingAddressForm(billingAddressState.address);
        setBillingAddressStatus(
          billingAddressState.address ? 'Billing address saved.' : '',
          billingAddressState.address ? 'success' : 'muted',
        );
        return billingAddressState.address;
      } catch {
        return null;
      }
    }

    window.saveBillingAddress = async function() {
      if (!authToken) {
        showAuthOverlay();
        return null;
      }
      var payload;
      try {
        payload = readBillingAddressPayload();
      } catch (err) {
        setBillingAddressStatus(err && err.message ? err.message : 'Billing address is incomplete.', 'error');
        return null;
      }
      setBillingAddressStatus('Saving billing address...', 'muted');
      try {
        var res = await fetch('/api/user/billing-address', {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ billing_address: payload }),
        });
        var data = await res.json();
        if (!res.ok) {
          setBillingAddressStatus(data.error || 'Billing address could not be saved.', 'error');
          return null;
        }
        billingAddressState = {
          loaded: true,
          address: data.billing_address || payload,
        };
        populateBillingAddressForm(billingAddressState.address);
        setBillingAddressStatus('Billing address saved.', 'success');
        return billingAddressState.address;
      } catch (err) {
        setBillingAddressStatus(err && err.message ? err.message : 'Billing address could not be saved.', 'error');
        return null;
      }
    };

    function clearWalletExpressElement() {
      if (walletExpressState.element) {
        try { walletExpressState.element.unmount(); } catch {}
      }
      walletExpressState = {
        stripe: null,
        elements: null,
        element: null,
        clientSecret: null,
        amountCents: 0,
      };
      var mount = document.getElementById('walletExpressCheckoutMount');
      if (mount) mount.innerHTML = '';
    }

    function clearWireTransferInstructions() {
      wireTransferState = { paymentIntentId: null, amountCents: 0 };
      var panel = document.getElementById('wireTransferInstructions');
      if (panel) panel.innerHTML = '';
    }

    window.updateWalletFundingPreview = function() {
      var preview = document.getElementById('walletExpressPreview');
      if (!preview) return;
      var cents = getWalletFundingAmountCents();
      var minCents = getCardMinimumCents();
      var maxCents = 500000;
      var dollars = (cents / 100).toFixed(2);
      var light = Math.round((cents / 100) * getWalletLightPerUsd());
      if (cents < minCents) {
        preview.textContent = 'Minimum wallet funding amount is ' + formatUsdCents(minCents) + '.';
      } else if (cents > maxCents) {
        preview.textContent = 'Maximum wallet funding amount is $5,000.00.';
      } else {
        preview.textContent = '$' + dollars + ' funds ' + formatLight(light) + ' at ' + getWalletLightPerUsd().toLocaleString() + ' Light / $1.';
      }
      if (walletExpressState.amountCents && walletExpressState.amountCents !== cents) {
        clearWalletExpressElement();
        setWalletExpressStatus('Amount changed. Show wallet buttons again to continue.', 'muted');
      }
    };

    window.updateWireFundingPreview = function() {
      var preview = document.getElementById('wireTransferPreview');
      if (!preview) return;
      var cents = getWireFundingAmountCents();
      var minCents = getWireMinimumCents();
      var maxCents = 500000;
      var light = Math.round((cents / 100) * getWireLightPerUsd());
      if (cents < minCents) {
        preview.textContent = 'Minimum wire funding amount is ' + formatUsdCents(minCents) + '.';
      } else if (cents > maxCents) {
        preview.textContent = 'Maximum wire funding amount is $5,000.00.';
      } else {
        preview.textContent = formatUsdCents(cents) + ' funds ' + formatLight(light) + ' at ' + getWireLightPerUsd().toLocaleString() + ' Light / $1 after settlement.';
      }
      if (wireTransferState.amountCents && wireTransferState.amountCents !== cents) {
        clearWireTransferInstructions();
        setWireTransferStatus('Amount changed. Generate new wire instructions before sending funds.', 'muted');
      }
    };

    function loadStripeJs() {
      if (window.Stripe) return Promise.resolve(window.Stripe);
      if (walletStripeJsPromise) return walletStripeJsPromise;
      walletStripeJsPromise = new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://js.stripe.com/v3/';
        script.async = true;
        script.onload = function() {
          if (window.Stripe) resolve(window.Stripe);
          else reject(new Error('Stripe.js did not load'));
        };
        script.onerror = function() { reject(new Error('Failed to load Stripe.js')); };
        document.head.appendChild(script);
      });
      return walletStripeJsPromise;
    }

    function renderWalletFundingMethods() {
      var el = document.getElementById('walletFundingMethods');
      if (!el) return;
      el.innerHTML =
        '<div style="grid-column:1/-1;border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-4);min-width:0;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-3);">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">Billing Address</div>' +
            '<button id="billingAddressSaveBtn" class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="saveBillingAddress()">Save</button>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--space-2);">' +
            '<div><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Name</label><input id="billingAddressName" autocomplete="billing name" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;"></div>' +
            '<div><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Country</label><input id="billingAddressCountry" maxlength="2" value="US" autocomplete="billing country" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;text-transform:uppercase;"></div>' +
            '<div style="grid-column:1/-1;"><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Address</label><input id="billingAddressLine1" autocomplete="billing address-line1" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;"></div>' +
            '<div><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Apt / suite</label><input id="billingAddressLine2" autocomplete="billing address-line2" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;"></div>' +
            '<div><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">City</label><input id="billingAddressCity" autocomplete="billing address-level2" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;"></div>' +
            '<div><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">State / region</label><input id="billingAddressState" autocomplete="billing address-level1" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;"></div>' +
            '<div><label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Postal code</label><input id="billingAddressPostalCode" autocomplete="billing postal-code" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;"></div>' +
          '</div>' +
          '<div id="billingAddressStatus" style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-top:var(--space-2);"></div>' +
        '</div>' +
        '<div style="border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-4);min-width:0;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-2);">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">Apple Pay / Google Pay</div>' +
            '<span style="font-size:11px;color:var(--success);border:1px solid rgba(34,197,94,0.35);padding:2px 6px;">' + getWalletLightPerUsd().toLocaleString() + ' Light / $1</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-bottom:var(--space-3);">The only card-like Light funding surface. Device wallet availability and SCA are handled by Stripe.</div>' +
          '<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2);align-items:end;margin-bottom:var(--space-2);">' +
            '<div>' +
              '<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Amount (USD)</label>' +
              '<input id="walletExpressAmountUsd" type="number" min="' + (getCardMinimumCents() / 100) + '" max="5000" step="1" value="' + Math.max(25, getCardMinimumCents() / 100) + '" oninput="updateWalletFundingPreview()" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;">' +
            '</div>' +
            '<button id="walletExpressStartBtn" class="btn btn-primary btn-sm" style="border-radius:0;" onclick="startWalletExpressCheckout()">Show Wallet Buttons</button>' +
          '</div>' +
          '<div id="walletExpressPreview" style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-bottom:var(--space-3);"></div>' +
          '<div id="walletExpressCheckoutMount" style="min-height:44px;"></div>' +
          '<div id="walletExpressStatus" style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-top:var(--space-2);"></div>' +
        '</div>' +
        '<div style="border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-4);min-width:0;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-2);">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">Wire Transfer</div>' +
            '<span style="font-size:11px;color:var(--success);border:1px solid rgba(34,197,94,0.35);padding:2px 6px;">' + getWireLightPerUsd().toLocaleString() + ' Light / $1</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-bottom:var(--space-3);">Bank-transfer Light credits stay pending until Stripe confirms settlement.</div>' +
          '<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2);align-items:end;margin-bottom:var(--space-2);">' +
            '<div>' +
              '<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Amount (USD)</label>' +
              '<input id="wireTransferAmountUsd" type="number" min="' + (getWireMinimumCents() / 100) + '" max="5000" step="1" value="500" oninput="updateWireFundingPreview()" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;">' +
            '</div>' +
            '<button id="wireTransferStartBtn" class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="startWireTransferFunding()">Get Instructions</button>' +
          '</div>' +
          '<div id="wireTransferPreview" style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-bottom:var(--space-3);"></div>' +
          '<div id="wireTransferInstructions"></div>' +
          '<div id="wireTransferStatus" style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-top:var(--space-2);"></div>' +
        '</div>';
      if (billingAddressState.address) populateBillingAddressForm(billingAddressState.address);
      if (!billingAddressState.loaded && authToken) loadBillingAddress();
      window.updateWalletFundingPreview();
      window.updateWireFundingPreview();
    }

    window.openWalletFundingMethod = function(method) {
      if (method === 'wallet') {
        window.startWalletExpressCheckout();
      } else {
        window.startWireTransferFunding();
      }
    };

    function renderWireFinancialAddress(address) {
      if (!address) return '';
      var rows = [];
      var networks = Array.isArray(address.supported_networks) ? address.supported_networks.join(', ') : '';
      if (address.type === 'aba' && address.aba) {
        rows.push('Bank: ' + (address.aba.bank_name || ''));
        rows.push('Routing number: ' + (address.aba.routing_number || ''));
        rows.push('Account number: ' + (address.aba.account_number || ''));
      } else if (address.type === 'swift' && address.swift) {
        rows.push('Bank: ' + (address.swift.bank_name || ''));
        rows.push('SWIFT: ' + (address.swift.swift_code || ''));
        rows.push('Account number: ' + (address.swift.account_number || ''));
      }
      if (networks) rows.push('Networks: ' + networks);
      return rows.filter(Boolean).join('\\n');
    }

    function renderWireTransferInstructions(data) {
      var panel = document.getElementById('wireTransferInstructions');
      if (!panel) return;
      var instructions = data.instructions || {};
      var addresses = Array.isArray(instructions.financialAddresses) ? instructions.financialAddresses : [];
      var lines = [
        'Amount: ' + formatUsdCents(instructions.amountRemainingCents || data.amount_cents || 0),
        'Currency: ' + (instructions.currency || 'USD'),
      ];
      if (instructions.reference) lines.push('Reference: ' + instructions.reference);
      addresses.forEach(function(address, index) {
        var rendered = renderWireFinancialAddress(address);
        if (rendered) lines.push('\\nBank details ' + (index + 1) + '\\n' + rendered);
      });
      if (instructions.hostedInstructionsUrl) {
        lines.push('\\nStripe hosted instructions: ' + instructions.hostedInstructionsUrl);
      }
      var text = lines.join('\\n');
      panel.innerHTML =
        '<div style="border:1px solid var(--border);background:var(--bg-secondary);padding:var(--space-3);margin-top:var(--space-2);">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);margin-bottom:var(--space-2);">' +
            '<div style="font-size:12px;font-weight:600;color:var(--text-primary);">Transfer exact amount</div>' +
            '<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;" onclick="copyWireInstructions()">Copy</button>' +
          '</div>' +
          '<pre id="wireTransferInstructionsText" style="white-space:pre-wrap;margin:0;font-size:11px;line-height:1.45;color:var(--text-secondary);font-family:var(--font-mono);overflow-wrap:anywhere;">' + escapeHtml(text) + '</pre>' +
          (instructions.hostedInstructionsUrl ? '<a href="' + escapeHtml(instructions.hostedInstructionsUrl) + '" target="_blank" rel="noreferrer" style="display:inline-block;margin-top:var(--space-2);font-size:12px;color:var(--text-primary);">Open Stripe hosted instructions</a>' : '') +
        '</div>';
    }

    window.copyWireInstructions = async function() {
      var textEl = document.getElementById('wireTransferInstructionsText');
      if (!textEl) return;
      try {
        await navigator.clipboard.writeText(textEl.innerText || textEl.textContent || '');
        showToast('Wire instructions copied.');
      } catch {
        prompt('Copy wire instructions:', textEl.innerText || textEl.textContent || '');
      }
    };

    window.startWireTransferFunding = async function() {
      if (!authToken) {
        showAuthOverlay();
        return;
      }
      var cents = getWireFundingAmountCents();
      var minCents = getWireMinimumCents();
      if (cents < minCents) {
        setWireTransferStatus('Minimum wire funding amount is ' + formatUsdCents(minCents) + '.', 'error');
        return;
      }
      if (cents > 500000) {
        setWireTransferStatus('Maximum wire funding amount is $5,000.00.', 'error');
        return;
      }
      if (!walletTermsAccepted()) {
        setWireTransferStatus('Review and accept the Light funding terms before generating wire instructions.', 'error');
        return;
      }
      if (!billingAddressState.loaded && authToken) await loadBillingAddress();
      var billingAddress;
      try {
        billingAddress = readBillingAddressPayload();
      } catch (err) {
        setWireTransferStatus(err && err.message ? err.message : 'Billing address is incomplete.', 'error');
        setBillingAddressStatus(err && err.message ? err.message : 'Billing address is incomplete.', 'error');
        return;
      }

      var btn = document.getElementById('wireTransferStartBtn');
      if (btn) btn.disabled = true;
      clearWireTransferInstructions();
      setWireTransferStatus('Generating Stripe wire instructions...', 'muted');

      try {
        var res = await fetch('/api/user/wallet/wire-transfer-intent', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_cents: cents, source: _isEmbed ? 'desktop' : 'web', terms_accepted: true, billing_address: billingAddress }),
        });
        var data = await res.json();
        if (!res.ok) {
          setWireTransferStatus(data.error || 'Wire funding is unavailable right now.', 'error');
          return;
        }
        if (data.billing_address) {
          billingAddressState = {
            loaded: true,
            address: data.billing_address,
          };
          populateBillingAddressForm(data.billing_address);
          setBillingAddressStatus('Billing address saved.', 'success');
        }

        wireTransferState = {
          paymentIntentId: data.payment_intent_id,
          amountCents: cents,
        };
        renderWireTransferInstructions(data);
        if (data.status === 'succeeded') {
          setWireTransferStatus('Stripe has already marked this payment succeeded. Balance will update after the webhook finalizes it.', 'success');
        } else {
          setWireTransferStatus('Send the exact amount using these instructions. Light credits only after Stripe confirms settlement.', 'success');
        }
      } catch (err) {
        setWireTransferStatus(err && err.message ? err.message : 'Wire funding failed.', 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.startWalletExpressCheckout = async function() {
      if (!authToken) {
        showAuthOverlay();
        return;
      }
      var cents = getWalletFundingAmountCents();
      var minCents = getCardMinimumCents();
      if (cents < minCents) {
        setWalletExpressStatus('Minimum wallet funding amount is ' + formatUsdCents(minCents) + '.', 'error');
        return;
      }
      if (cents > 500000) {
        setWalletExpressStatus('Maximum wallet funding amount is $5,000.00.', 'error');
        return;
      }
      if (!walletTermsAccepted()) {
        setWalletExpressStatus('Review and accept the Light funding terms before showing wallet buttons.', 'error');
        return;
      }
      if (!billingAddressState.loaded && authToken) await loadBillingAddress();
      var billingAddress;
      try {
        billingAddress = readBillingAddressPayload();
      } catch (err) {
        setWalletExpressStatus(err && err.message ? err.message : 'Billing address is incomplete.', 'error');
        setBillingAddressStatus(err && err.message ? err.message : 'Billing address is incomplete.', 'error');
        return;
      }

      var btn = document.getElementById('walletExpressStartBtn');
      if (btn) btn.disabled = true;
      clearWalletExpressElement();
      setWalletExpressStatus('Preparing Apple Pay / Google Pay...', 'muted');

      try {
        var res = await fetch('/api/user/wallet/express-checkout-intent', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_cents: cents, source: _isEmbed ? 'desktop' : 'web', terms_accepted: true, billing_address: billingAddress }),
        });
        var data = await res.json();
        if (!res.ok) {
          setWalletExpressStatus(data.error || 'Wallet funding is unavailable right now.', 'error');
          return;
        }
        if (data.billing_address) {
          billingAddressState = {
            loaded: true,
            address: data.billing_address,
          };
          populateBillingAddressForm(data.billing_address);
          setBillingAddressStatus('Billing address saved.', 'success');
        }

        var StripeCtor = await loadStripeJs();
        var stripe = StripeCtor(data.publishable_key);
        var elements = stripe.elements({
          clientSecret: data.client_secret,
          appearance: {
            variables: {
              borderRadius: '2px',
              colorPrimary: '#111827',
            },
          },
        });
        var expressElement = elements.create('expressCheckout', {
          paymentMethods: {
            applePay: 'auto',
            googlePay: 'auto',
            link: 'never',
            paypal: 'never',
            amazonPay: 'never',
            klarna: 'never',
          },
          layout: {
            maxColumns: 2,
            maxRows: 1,
            overflow: 'never',
          },
          buttonType: {
            applePay: 'check-out',
            googlePay: 'checkout',
          },
          buttonHeight: 44,
        });

        expressElement.on('ready', function(event) {
          var methods = event && event.availablePaymentMethods;
          if (!methods || (!methods.applePay && !methods.googlePay)) {
            setWalletExpressStatus('Apple Pay / Google Pay is unavailable in this browser. Try a supported wallet browser.', 'error');
          } else {
            setWalletExpressStatus('Choose Apple Pay or Google Pay to add ' + formatLight(data.light_amount) + '.', 'success');
          }
        });

        expressElement.on('confirm', async function() {
          setWalletExpressStatus('Confirming wallet payment...', 'muted');
          var submitResult = await elements.submit();
          if (submitResult.error) {
            setWalletExpressStatus(submitResult.error.message || 'Wallet payment could not be submitted.', 'error');
            return;
          }
          var result = await stripe.confirmPayment({
            elements: elements,
            clientSecret: data.client_secret,
            confirmParams: { return_url: window.location.origin + '/wallet?wallet_payment=return' },
            redirect: 'if_required',
          });
          if (result.error) {
            setWalletExpressStatus(result.error.message || 'Wallet payment failed.', 'error');
            return;
          }
          setWalletExpressStatus('Payment confirmed. Light will appear after Stripe confirms settlement.', 'success');
          showToast('Wallet payment confirmed. Balance will update shortly.');
          setTimeout(function() { loadHostingData(); loadTransactions(true); }, 2000);
          setTimeout(function() { loadHostingData(); loadTransactions(true); }, 6000);
        });

        walletExpressState = {
          stripe: stripe,
          elements: elements,
          element: expressElement,
          clientSecret: data.client_secret,
          amountCents: cents,
        };
        expressElement.mount('#walletExpressCheckoutMount');
      } catch (err) {
        setWalletExpressStatus(err && err.message ? err.message : 'Wallet funding failed.', 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    function updateBillingPolicyCopy() {
      renderWalletFundingMethods();
      var canonicalEl = document.getElementById('walletCanonicalRateLabel');
      if (canonicalEl) {
        canonicalEl.textContent = getCanonicalLightPerUsd().toLocaleString() + ' Light = $1 receipt/payout reference';
      }
      var fundingEl = document.getElementById('walletFundingPolicy');
      if (fundingEl) {
        fundingEl.textContent = 'Apple Pay and Google Pay fund at ' + getWalletLightPerUsd().toLocaleString() + ' Light / $1. Wire transfer funds at ' + getWireLightPerUsd().toLocaleString() + ' Light / $1. ' + getCanonicalLightPerUsd().toLocaleString() + ' Light = $1 is used for receipts, internal cost reference, and payouts.';
      }
      var cloudPolicyEl = document.getElementById('walletCloudPolicy');
      if (cloudPolicyEl) {
        var copy = getPolicyCopy();
        cloudPolicyEl.textContent = [copy.cloudUsage, copy.storagePolicy, copy.freeCallSponsorship].filter(Boolean).join(' ');
      }
      var payoutEl = document.getElementById('payoutPolicyCopy');
      if (payoutEl) payoutEl.textContent = billingConfig.payout_policy_copy;
      var walletTermsEl = document.getElementById('walletTermsCopy');
      if (walletTermsEl) walletTermsEl.innerHTML = renderTermsCopy(getPolicyCopy().fundingTerms);
      var payoutTermsEl = document.getElementById('payoutTermsCopy');
      if (payoutTermsEl) payoutTermsEl.innerHTML = renderTermsCopy(getPolicyCopy().payoutTerms);
      var withdrawInput = document.getElementById('withdrawAmountLight');
      if (withdrawInput) {
        withdrawInput.min = String(getMinWithdrawalLight());
        withdrawInput.placeholder = String(getMinWithdrawalLight());
      }
      updateWithdrawPreview();
    }

    async function loadBillingConfig() {
      try {
        var res = await fetch('/api/billing/config');
        if (!res.ok) return;
        var data = await res.json();
        billingConfig = Object.assign({}, billingConfig, data || {});
        updateBillingPolicyCopy();
      } catch {}
    }
    renderWalletFundingMethods();
    loadBillingConfig();

    function selectWalletTab(tab) {
      activeWalletTab = tab;
      document.querySelectorAll('[data-wallet-tab]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.walletTab === activeWalletTab);
      });
      ['walletBalanceTab', 'walletTransactionsTab', 'walletEarningsTab', 'walletOffersTab'].forEach(function(id) {
        var tabEl = document.getElementById(id);
        if (tabEl) tabEl.style.display = 'none';
      });
      var tabMap = { balance: 'walletBalanceTab', transactions: 'walletTransactionsTab', earnings: 'walletEarningsTab', offers: 'walletOffersTab' };
      var activeEl = document.getElementById(tabMap[activeWalletTab]);
      if (activeEl) activeEl.style.display = 'block';
      if (activeWalletTab === 'transactions') { loadTransactions(true); }
      else if (activeWalletTab === 'earnings') { loadEarnings(); loadConnectStatus(); loadPayouts(); }
      else if (activeWalletTab === 'offers') { loadMyOffers(); }
    }

    window.openWalletBalance = function() {
      switchDashSection('billing');
      selectWalletTab('balance');
    };

    window.openWalletTransactions = function() {
      switchDashSection('billing');
      selectWalletTab('transactions');
    };

    // Wallet filter tabs
    document.querySelectorAll('[data-wallet-tab]').forEach(function(el) {
      el.addEventListener('click', function() {
        selectWalletTab(this.dataset.walletTab);
      });
    });

    async function loadLibraryTab(tab) {
      var list = document.getElementById('appList');
      if (!list) return;
      if (!authToken) {
        list.innerHTML = renderShellState('empty', 'Sign in to continue', 'Sign in to view your ' + escapeHtml(tab) + ' items.', { compact: true });
        return;
      }

      // Return cached data if available
      var cached = tab === 'saved' ? savedItems : sharedItems;
      if (cached.length > 0) {
        renderLibraryItems(cached, tab);
        return;
      }

      list.innerHTML = renderShellState('loading', 'Loading library items', 'Checking your ' + escapeHtml(tab) + ' items.', { compact: true });

      try {
        var res = await fetch('/api/apps/me/library?tab=' + tab, {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) throw new Error('Failed to load');
        var items = await res.json();

        if (tab === 'saved') savedItems = items;
        else sharedItems = items;

        renderLibraryItems(items, tab);
      } catch (err) {
        list.innerHTML = renderShellState('error', 'Could not load library items', 'Try again in a moment.', { compact: true });
      }
    }

    function renderLibraryItems(items, tab) {
      var list = document.getElementById('appList');
      if (!list) return;

      if (!items || items.length === 0) {
        var emptyIcon = tab === 'saved' ? '⭐' : '🤝';
        var emptyTitle = tab === 'saved' ? 'No saved items' : 'Nothing shared with you';
        var emptyDesc = tab === 'saved'
          ? 'Like apps in the Marketplace to save them here.'
          : 'When someone shares an app or page with you, it will appear here.';
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">' + emptyIcon +
          '</div><div class="empty-state-title">' + emptyTitle +
          '</div><div class="empty-state-desc">' + emptyDesc +
          '</div></div>';
        return;
      }

      list.innerHTML = items.map(function(item) {
        var emoji = item.type === 'app' ? getAppEmoji(item.name || item.slug) : '📄';
        var name = escapeHtml(item.name || item.slug || 'Untitled');
        var desc = escapeHtml((item.description || '').slice(0, 120));
        var badge = item.type === 'app' ? 'App' : 'Page';
        var versionHtml = item.version
          ? ' <span class="app-row-version">' + escapeHtml(item.version) + '</span>'
          : '';
        var fnCountHtml = item.type === 'app' && item.fn_count > 0
          ? ' <span class="app-row-fn-count">' + item.fn_count + ' fn' + (item.fn_count !== 1 ? 's' : '') + '</span>'
          : '';
        var ownerHtml = item.owner_email
          ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">' + escapeHtml(item.owner_email) + '</div>'
          : '';
        var clickAction = item.type === 'app'
          ? 'navigateToApp(\\\'' + item.id + '\\\')'
          : 'window.open(\\\'/p/' + escapeHtml(item.slug) + '\\\', \\\'_blank\\\')';

        return '<div class="app-row" onclick="' + clickAction + '">' +
          '<div class="app-row-emoji">' + emoji + '</div>' +
          '<div class="app-row-info">' +
            '<div class="app-row-name">' + name + versionHtml + fnCountHtml +
              ' <span class="marketplace-badge">' + badge + '</span>' +
            '</div>' +
            (desc ? '<div class="app-row-desc">' + desc + '</div>' : '') +
            ownerHtml +
          '</div>' +
        '</div>';
      }).join('');
    }

    // (Copy agent instructions moved to nav bar — see navCopyInstructionsBtn handler above)

    // ===== Dashboard =====
    async function loadDashboardData() {
      renderAppList();
    }


    // ===== App Detail Page =====
    async function loadAppPage(appId, section) {
      if (!authToken || !appId) return;

      var sec = section || 'overview';

      try {
        const res = await fetch('/api/apps/' + appId, {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          showToast('Failed to load app', 'error');
          return;
        }
        const app = await res.json();

        document.title = (app.name || app.slug) + ' - Ultralight';

        // Store current app data for editing
        window._currentApp = app;

        // Toggle Payments/Market tabs based on visibility
        updatePublicTabVisibility();
        // If requested section is hidden, fall back to overview
        if (sec === 'payments' || sec === 'offers' || sec === 'store-listing') {
          if (app.visibility !== 'published' && app.visibility !== 'public') sec = 'overview';
        }
        switchAppSection(sec);

        // Set app name on all panels
        var appName = escapeHtml(app.name || app.slug || 'Untitled');
        document.querySelectorAll('.app-panel-name').forEach(function(el) {
          el.textContent = app.name || app.slug || 'Untitled';
        });

        // Load all sections (each in its own try/catch so one failure doesn't block the rest)
        try { loadAppOverview(app); } catch (e) { errorLog('app', 'loadAppOverview failed', e); }
        try { loadAppPermissions(app); } catch (e) { errorLog('app', 'loadAppPermissions failed', e); }
        try { loadAppEnvironment(app); } catch (e) { errorLog('app', 'loadAppEnvironment failed', e); }
        try { loadAppPayments(appId, app); } catch (e) { errorLog('app', 'loadAppPayments failed', e); }
        try { loadAppLogsSection(appId); } catch (e) { errorLog('app', 'loadAppLogsSection failed', e); }
        try { loadAppOffers(appId, app); } catch (e) { errorLog('app', 'loadAppOffers failed', e); }
        try { loadAppStoreListing(appId, app); } catch (e) { errorLog('app', 'loadAppStoreListing failed', e); }

      } catch (err) {
        showToast('Error loading app: ' + (err.message || ''), 'error');
      }
    }

    // ===== App Overview =====
    function loadAppOverview(app) {
      // -- App header (meta only — app name is set by loadAppPage) --
      const headerEl = document.getElementById('appOverviewHeader');
      if (headerEl) {
        const endpointUrl = window.location.origin + '/mcp/' + app.id;
        headerEl.innerHTML =
          '<div class="app-panel-name">' + escapeHtml(app.name || app.slug || 'Untitled') + '</div>' +
          '<div class="app-overview-meta" style="margin-bottom:var(--space-4);">' +
            '<div class="meta-row">' +
              '<span style="font-size:12px;padding:2px 8px;background:var(--accent-soft);color:var(--accent);font-weight:500;">' + escapeHtml(app.current_version || 'v1.0.0') + '</span>' +
              '<span style="font-size:12px;padding:2px 8px;background:rgba(52,211,153,0.1);color:var(--success);font-weight:500;">Active</span>' +
            '</div>' +
            '<div class="meta-row">' +
              '<span style="font-size:12px;color:var(--text-muted);">MCP Endpoint (Authorization header required):</span>' +
              '<code style="font-size:12px;font-family:var(--font-mono);color:var(--text-secondary);background:var(--bg-active);padding:2px 8px;">' + escapeHtml(endpointUrl) + '</code>' +
              '<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;" onclick="copyAppEndpoint()">Copy</button>' +
            '</div>' +
          '</div>';
      }

      // -- General settings --
      const generalEl = document.getElementById('appGeneralSettings');
      if (generalEl) {
        generalEl.innerHTML =
          '<div class="section-card">' +
            '<h3 class="section-title">General</h3>' +
            '<div style="display:flex;flex-direction:column;gap:var(--space-4);">' +
              '<div><label class="form-label">App Name</label><input type="text" id="settingName" class="form-input" value="' + escapeHtml(app.name || '') + '"></div>' +
              '<div><label class="form-label">Visibility</label><select id="settingVisibility" class="form-input"><option value="private"' + (app.visibility === 'private' ? ' selected' : '') + '>Private</option><option value="unlisted"' + (app.visibility === 'unlisted' ? ' selected' : '') + '>Unlisted</option><option value="published"' + (app.visibility === 'published' ? ' selected' : '') + '>Published</option></select></div>' +
              '<div><label class="form-label">Download Access</label><select id="settingDownload" class="form-input"><option value="owner"' + (app.download_access === 'owner' ? ' selected' : '') + '>Owner Only</option><option value="public"' + (app.download_access === 'public' ? ' selected' : '') + '>Public</option></select></div>' +
              '<div><label class="form-label">Version</label><select id="settingVersion" class="form-input">' +
                (app.versions || []).map(function(v) {
                  return '<option value="' + escapeHtml(v.version) + '"' + (v.version === app.current_version ? ' selected' : '') + '>' + escapeHtml(v.version) + (v.version === app.current_version ? ' (current)' : '') + '</option>';
                }).join('') +
              '</select></div>' +
              '<div style="display:flex;gap:8px;margin-top:12px">' +
                '<button class="btn btn-primary btn-sm" onclick="saveAppSettings()">Save Changes</button>' +
                '<button class="btn btn-ghost btn-sm" onclick="downloadAppCode()">Download Code</button>' +
                '<button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="showDeleteConfirm()">Delete App</button>' +
              '</div>' +
            '</div>' +
          '</div>';
      }

      // -- Trust & runtime --
      const trustEl = document.getElementById('appTrustSection');
      if (trustEl) {
        trustEl.innerHTML = renderTrustOverview(app);
      }

      // -- Functions list --
      const fnsEl = document.getElementById('appFunctionsSection');
      if (fnsEl) {
        const fnResult = getAppFunctions(app);
        const fns = fnResult.functions;
        const functionsHtml = fns.length > 0
          ? '<div class="function-list">' + fns.map(function(fn) {
              // Handle object-keyed params {name: {type, required}} or legacy array [{name, type}]
              var paramEntries = [];
              if (fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)) {
                paramEntries = Object.entries(fn.parameters).map(function(e) {
                  return { name: e[0], type: (e[1] && e[1].type) || 'any', required: e[1] ? e[1].required !== false : true, description: (e[1] && e[1].description) || '' };
                });
              } else if (Array.isArray(fn.parameters)) {
                paramEntries = fn.parameters.map(function(p) {
                  return { name: p.name || '', type: p.type || 'any', required: p.required !== false, description: p.description || '' };
                });
              }
              const params = paramEntries.map(function(p) {
                return '<span class="fn-param' + (p.required ? '' : ' fn-param-optional') + '" title="' + escapeHtml(p.description) + '">' +
                  escapeHtml(p.name) + (p.required ? '' : '?') +
                  '<span class="fn-param-type">: ' + escapeHtml(p.type) + '</span></span>';
              }).join(', ');
              return '<div class="function-item">' +
                '<div class="function-name"><code>' + escapeHtml(fn.name) + '</code>' + (params ? '(' + params + ')' : '') + '</div>' +
                (fn.description ? '<div class="function-desc">' + escapeHtml(fn.description) + '</div>' : '') +
              '</div>';
            }).join('') + '</div>' +
            (fnResult.migrationRequired ? '<div style="font-size:11px;color:#fbbf24;margin-top:8px;">' + escapeHtml(fnResult.message || 'Manifest migration required.') + '</div>' : '')
          : '<div style="font-size:13px;color:var(--text-muted);">No functions found. Deploy your app to see functions here.</div>';

        fnsEl.innerHTML =
          '<div class="section-card">' +
            '<h3 class="section-title">Functions</h3>' +
            functionsHtml +
          '</div>';
      }

      // -- Skills --
      const skillsEl = document.getElementById('skillsContent');
      if (skillsEl) {
        skillsEl.innerHTML = renderSectionState('Skills / Documentation', 'loading', 'Loading documentation', 'Pulling the latest generated docs and setup guidance.');
        loadSkills(app.id);
      }
    }

    async function loadAppHealth(appId) {
      const container = document.getElementById('appHealthSummary');
      if (!container) return;
      try {
        const res = await fetch('/api/apps/' + appId + '/health', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          container.innerHTML = renderSectionState('Health', 'error', 'Health data unavailable', 'We could not load the latest health summary.');
          return;
        }
        const data = await res.json();
        const isHealthy = !data.is_unhealthy;
        const autoHeal = data.auto_heal_enabled;

        let html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
          '<div class="status-dot" style="background:' + (isHealthy ? 'var(--success)' : 'var(--error)') + ';width:8px;height:8px;border-radius:50%"></div>' +
          '<span style="font-weight:500">' + (isHealthy ? 'All healthy' : 'Issues detected') + '</span>' +
          '<label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer">' +
            '<input type="checkbox" id="autoHealToggle" ' + (autoHeal ? 'checked' : '') + ' onchange="toggleAutoHeal(\\\'' + appId + '\\\', this.checked)"> Auto-heal' +
          '</label>' +
        '</div>';

        if (data.function_health && Object.keys(data.function_health).length > 0) {
          html += Object.entries(data.function_health).map(function(entry) {
            const fn = entry[0], stats = entry[1];
            const errorRate = stats.error_rate || 0;
            const color = errorRate > 50 ? 'var(--error)' : errorRate > 10 ? 'var(--warning)' : 'var(--success)';
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px">' +
              '<code style="flex:1;color:var(--text-primary)">' + escapeHtml(fn) + '</code>' +
              '<div style="width:60px;height:4px;background:var(--bg-hover);border-radius:2px;overflow:hidden">' +
                '<div style="height:100%;width:' + Math.min(errorRate, 100) + '%;background:' + color + ';border-radius:2px"></div>' +
              '</div>' +
              '<span style="width:40px;text-align:right;color:' + color + '">' + errorRate.toFixed(0) + '%</span>' +
            '</div>';
          }).join('');
        }

        container.innerHTML = '<h3 class="section-title">Health</h3>' + html;
      } catch {
        container.innerHTML = renderSectionState('Health', 'error', 'Health data unavailable', 'We could not load the latest health summary.');
      }
    }

    window.toggleAutoHeal = async function(appId, enabled) {
      try {
        const res = await fetch('/api/apps/' + appId + '/health', {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auto_heal_enabled: enabled }),
        });
        if (res.ok) showToast('Auto-heal ' + (enabled ? 'enabled' : 'disabled'));
        else {
          showToast('Failed to update auto-heal', 'error');
          document.getElementById('autoHealToggle').checked = !enabled;
        }
      } catch {
        showToast('Failed to update', 'error');
        document.getElementById('autoHealToggle').checked = !enabled;
      }
    };

    // ===== App Section Loaders =====
    function loadAppPermissions(app) {
      // Visibility + download access selectors
      const visEl = document.getElementById('appVisibilitySection');
      if (visEl) {
        visEl.innerHTML =
          '<div class="section-card" style="margin-bottom:var(--space-4);">' +
            '<h3 class="section-title">Access Control</h3>' +
            '<div style="display:flex;flex-direction:column;gap:var(--space-4);">' +
              '<div><label class="form-label">Visibility</label><select id="permVisibility" class="form-input"><option value="private"' + (app.visibility === 'private' ? ' selected' : '') + '>Private</option><option value="unlisted"' + (app.visibility === 'unlisted' ? ' selected' : '') + '>Unlisted</option><option value="published"' + (app.visibility === 'published' ? ' selected' : '') + '>Published</option></select></div>' +
              '<div><label class="form-label">Download Access</label><select id="permDownload" class="form-input"><option value="owner"' + (app.download_access === 'owner' ? ' selected' : '') + '>Owner Only</option><option value="public"' + (app.download_access === 'public' ? ' selected' : '') + '>Public</option></select></div>' +
            '</div>' +
          '</div>';
        // Auto-save visibility changes
        var permVisSel = document.getElementById('permVisibility');
        if (permVisSel) {
          permVisSel.addEventListener('change', async function() {
            var newVis = this.value;
            try {
              var res = await fetch('/api/apps/' + app.id, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ visibility: newVis }),
              });
              if (res.ok) {
                window._currentApp.visibility = newVis;
                updatePublicTabVisibility();
                // Sync Overview tab's visibility dropdown
                var overviewVisSel = document.getElementById('settingVisibility');
                if (overviewVisSel) overviewVisSel.value = newVis;
                showToast('Visibility updated');
              } else {
                showToast('Failed to update visibility', 'error');
              }
            } catch (e) {
              showToast('Failed to update visibility', 'error');
            }
          });
        }
        // Auto-save download access changes
        var permDlSel = document.getElementById('permDownload');
        if (permDlSel) {
          permDlSel.addEventListener('change', async function() {
            try {
              var res = await fetch('/api/apps/' + app.id, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ download_access: this.value }),
              });
              if (res.ok) {
                window._currentApp.download_access = this.value;
                showToast('Download access updated');
              } else {
                showToast('Failed to update', 'error');
              }
            } catch (e) {
              showToast('Failed to update', 'error');
            }
          });
        }
      }
      // Load granted users
      const permsEl = document.getElementById('permissionsContent');
      if (permsEl) {
        permsEl.innerHTML = renderShellState('loading', 'Loading permissions', 'Checking granted users and per-function access.', { compact: true });
        loadPermissions(app.id);
      }
    }

    function loadAppEnvironment(app) {
      const dbEl = document.getElementById('databaseContent');
      if (dbEl) {
        dbEl.innerHTML = renderSectionState('Database', 'loading', 'Loading database connection', 'Checking the app\\'s current data binding.');
        loadDatabase(app.id);
      }
      const envEl = document.getElementById('envVarsContent');
      if (envEl) {
        envEl.innerHTML = renderSectionState('Environment Variables', 'loading', 'Loading environment variables', 'Fetching saved keys for this app.');
        loadEnvVars(app.id);
      }
    }

    function loadAppPayments(appId, app) {
      const pricingEl = document.getElementById('appPricingSection');
      if (pricingEl) {
        const pricingConfig = app.pricing_config || {};
        const defaultPrice = pricingConfig.default_price_light || 0;
        const defaultFreeCalls = pricingConfig.default_free_calls || 0;
        const freeCallsScope = pricingConfig.free_calls_scope || 'function';
        const fnOverrides = pricingConfig.functions || {};
        const fnResult = getAppFunctions(app);
        const fns = fnResult.functions;

        // Build per-function rows
        var fnRowsHtml = '';
        if (fns.length > 0) {
          fnRowsHtml = '<div style="margin-top:var(--space-4)">' +
            '<h4 style="font-size:13px;font-weight:600;margin-bottom:var(--space-3)">Per-Function Pricing</h4>' +
            (fnResult.migrationRequired ? '<div style="font-size:11px;color:#fbbf24;margin-bottom:var(--space-2);">' + escapeHtml(fnResult.message || 'Manifest migration required.') + '</div>' : '') +
            '<div style="display:grid;grid-template-columns:1fr 90px 90px 60px;gap:8px 12px;align-items:center;font-size:12px;">' +
              '<div style="color:var(--text-muted);font-weight:500;">Function</div>' +
              '<div style="color:var(--text-muted);font-weight:500;">Price (\u00a2)</div>' +
              '<div style="color:var(--text-muted);font-weight:500;">Free Calls</div>' +
              '<div style="color:var(--text-muted);font-weight:500;text-align:center;">Custom</div>';

          for (var fi = 0; fi < fns.length; fi++) {
            var fn = fns[fi];
            var fnName = fn.name;
            var override = fnOverrides[fnName];
            var hasOverride = override !== undefined;
            var fnPrice = defaultPrice;
            var fnFree = defaultFreeCalls;
            if (hasOverride) {
              if (typeof override === 'number') {
                fnPrice = override;
              } else if (typeof override === 'object' && override !== null) {
                fnPrice = override.price_light !== undefined ? override.price_light : defaultPrice;
                fnFree = override.free_calls !== undefined ? override.free_calls : defaultFreeCalls;
              }
            }
            var disabledAttr = hasOverride ? '' : ' disabled';
            var dimStyle = hasOverride ? '' : 'opacity:0.4;';
            fnRowsHtml +=
              '<div class="pricing-fn-row" style="display:contents;">' +
                '<div style="font-family:var(--font-mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(fnName) + '">' + escapeHtml(fnName) + '</div>' +
                '<input type="number" class="form-input form-input-sm pricing-fn-price" data-fn="' + escapeHtml(fnName) + '" value="' + fnPrice + '" min="0" step="0.1" style="width:80px;font-size:12px;padding:4px 6px;' + dimStyle + '"' + disabledAttr + '>' +
                '<input type="number" class="form-input form-input-sm pricing-fn-free" data-fn="' + escapeHtml(fnName) + '" value="' + fnFree + '" min="0" step="1" style="width:80px;font-size:12px;padding:4px 6px;' + dimStyle + '"' + disabledAttr + '>' +
                '<div style="text-align:center;"><input type="checkbox" class="pricing-override-cb" data-fn="' + escapeHtml(fnName) + '"' + (hasOverride ? ' checked' : '') + ' onchange="togglePricingOverride(this)"></div>' +
              '</div>';
          }
          fnRowsHtml += '</div></div>';
        } else {
          fnRowsHtml = '<div style="margin-top:var(--space-4);font-size:13px;color:var(--text-muted);">No functions found. Deploy your app to configure per-function pricing.</div>';
        }

        pricingEl.innerHTML =
          '<div class="section-card">' +
            '<h3 class="section-title">Pricing</h3>' +
            '<div style="display:flex;gap:var(--space-4);flex-wrap:wrap;">' +
              '<div class="form-group" style="flex:1;min-width:120px;"><label class="form-label">Default price per call (Light)</label>' +
                '<input type="number" id="pricingDefault" class="form-input form-input-sm" value="' + defaultPrice + '" min="0" step="0.1" style="width:120px"></div>' +
              '<div class="form-group" style="flex:1;min-width:120px;"><label class="form-label">Default free calls per user</label>' +
                '<input type="number" id="pricingFreeCalls" class="form-input form-input-sm" value="' + defaultFreeCalls + '" min="0" step="1" style="width:120px"></div>' +
            '</div>' +
            '<div class="form-group" style="margin-top:var(--space-3);">' +
              '<label class="form-label">Free calls scope</label>' +
              '<div style="display:flex;gap:var(--space-4);font-size:13px;">' +
                '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="freeCallsScope" value="function"' + (freeCallsScope === 'function' ? ' checked' : '') + ' onchange="updateFreeCallsScope()"> Per function</label>' +
                '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="freeCallsScope" value="app"' + (freeCallsScope === 'app' ? ' checked' : '') + ' onchange="updateFreeCallsScope()"> Entire app (shared)</label>' +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Per function: each function has its own free call counter. Entire app: one shared counter across all functions.</div>' +
            '</div>' +
            fnRowsHtml +
            '<button class="btn btn-primary btn-sm" style="margin-top:var(--space-4)" onclick="savePricing()">Save Pricing</button>' +
          '</div>';
      }

      const revEl = document.getElementById('revenueSection');
      if (revEl) {
        revEl.innerHTML = renderSectionState('Revenue', 'loading', 'Loading revenue data', 'Pulling earnings and per-function revenue for this app.');
        loadAppRevenue(appId);
      }
    }

    function loadAppLogsSection(appId) {
      var logsEl = document.getElementById('appLogsContent');
      if (!logsEl) return;
      logsEl.innerHTML = renderShellState('loading', 'Loading usage data', 'Pulling metrics and recent call activity.', { compact: true });

      Promise.all([
        fetch('/api/marketplace/metrics/' + appId, {
          headers: { 'Authorization': 'Bearer ' + authToken }
        }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
        fetch('/api/apps/' + appId + '/call-log?limit=50', {
          headers: { 'Authorization': 'Bearer ' + authToken }
        }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; })
      ]).then(function(results) {
        var metrics = results[0];
        var callData = results[1];
        var logs = callData ? (Array.isArray(callData) ? callData : (callData.logs || [])) : [];
        var html = '';

        // ── METRICS CARDS ──
        if (metrics) {
          var successPct = metrics.success_rate_30d != null
            ? (metrics.success_rate_30d * 100).toFixed(1) + '%'
            : '-';
          var successColor = !metrics.success_rate_30d && metrics.success_rate_30d !== 0
            ? 'var(--text-muted)'
            : metrics.success_rate_30d >= 0.95
              ? 'var(--success)'
              : metrics.success_rate_30d >= 0.8
                ? '#f59e0b'
                : 'var(--error)';

          html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-3);margin-bottom:var(--space-4)">';

          // Total Calls
          html += '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);text-align:center">' +
            '<div style="font-size:22px;font-weight:700;color:var(--text-primary)">' + (metrics.total_calls || 0).toLocaleString() + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Total Calls</div>' +
          '</div>';

          // Calls 30d
          html += '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);text-align:center">' +
            '<div style="font-size:22px;font-weight:700;color:var(--text-primary)">' + (metrics.calls_30d || 0).toLocaleString() + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Calls (30d)</div>' +
          '</div>';

          // Success Rate
          html += '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);text-align:center">' +
            '<div style="font-size:22px;font-weight:700;color:' + successColor + '">' + successPct + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Success Rate (30d)</div>' +
          '</div>';

          // Unique Callers
          html += '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);text-align:center">' +
            '<div style="font-size:22px;font-weight:700;color:var(--text-primary)">' + (metrics.unique_callers_30d || 0).toLocaleString() + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Unique Callers (30d)</div>' +
          '</div>';

          // Revenue (only show if > 0)
          if (metrics.revenue_30d_light > 0) {
            html += '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);text-align:center">' +
              '<div style="font-size:22px;font-weight:700;color:var(--success)">' + formatLight(metrics.revenue_30d_light) + '</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Revenue (30d)</div>' +
            '</div>';
          }

          html += '</div>'; // close grid
        }

        // ── RECENT CALLS TABLE ──
        html += '<h3 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:var(--space-2);text-transform:uppercase;letter-spacing:0.5px">Recent Calls</h3>';

        if (!callData) {
          html += renderShellState('error', 'Recent calls unavailable', 'We could not load the owner activity feed for this app.', { compact: true });
        } else if (logs.length === 0) {
          html += renderShellState('empty', 'No calls recorded yet', 'Calls will appear here after agents use this app.', { compact: true });
        } else {
          html += '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
            '<thead><tr style="border-bottom:1px solid var(--border);text-align:left">' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Status</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">User</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Function</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Receipt</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">App</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Infra</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Cloud</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Duration</th>' +
              '<th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Time</th>' +
            '</tr></thead><tbody>' +
            logs.map(function(log) {
              var success = log.success !== false;
              var receiptId = log.receipt_id || log.id || '';
              var receipt = log.receipt || {};
              var appLight = typeof receipt.app_charge_light === 'number' ? receipt.app_charge_light : (log.call_charge_light || 0);
              var infraLight = typeof receipt.infra_light === 'number' ? receipt.infra_light : ((log.infra_charge_light || log.cloud_charge_light || 0));
              var cloudUnits = typeof receipt.cloud_units === 'number' ? receipt.cloud_units : (log.cloud_units || 0);
              var netLine = receipt.platform_fee_light || receipt.developer_net_light
                ? 'Fee ' + formatLight(receipt.platform_fee_light || 0) + ' · Net ' + formatLight(receipt.developer_net_light || 0)
                : '';
              var infraTitle = receipt.worker_units
                ? 'Worker ' + (receipt.worker_units.cloud_units || 0) + ' cloud units · R2 ' + ((receipt.r2_ops && receipt.r2_ops.operations) || 0) + ' ops · KV ' + ((receipt.kv_ops && receipt.kv_ops.operations) || 0) + ' ops · D1 reads ' + ((receipt.d1_reads && receipt.d1_reads.rows) || 0) + ' · D1 writes ' + ((receipt.d1_writes && receipt.d1_writes.rows) || 0) + ' · Widget pulls ' + ((receipt.widget_pulls && receipt.widget_pulls.pulls) || 0)
                : '';
              return '<tr style="border-bottom:1px solid var(--border)">' +
                '<td style="padding:8px 12px"><div style="width:8px;height:8px;border-radius:50%;background:' + (success ? 'var(--success)' : 'var(--error)') + '"></div></td>' +
                '<td style="padding:8px 12px;color:var(--text-muted);font-family:var(--font-mono);font-size:11px">' + escapeHtml((log.user_id || '').substring(0, 8)) + '</td>' +
                '<td style="padding:8px 12px;font-family:var(--font-mono)">' + escapeHtml(log.function_name || log.method || '') + '</td>' +
                '<td style="padding:8px 12px;color:var(--text-muted);font-family:var(--font-mono);font-size:11px;white-space:nowrap">' +
                  (receiptId ? '<code title="' + escapeHtml(receiptId) + '">' + escapeHtml(shortHash(receiptId)) + '</code> <button class="trust-copy-btn" data-receipt-id="' + escapeHtml(receiptId) + '" onclick="copyReceiptId(this)">Copy</button>' : '-') +
                '</td>' +
                '<td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap" title="' + escapeHtml(netLine) + '">' + (appLight ? formatLight(appLight) : '-') + '</td>' +
                '<td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap" title="' + escapeHtml(infraTitle) + '">' + (infraLight ? formatLight(infraLight) : '-') + '</td>' +
                '<td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap">' + (cloudUnits ? cloudUnits.toLocaleString() : '-') + '</td>' +
                '<td style="padding:8px 12px;color:var(--text-muted)">' + (log.duration_ms ? log.duration_ms + 'ms' : '-') + '</td>' +
                '<td style="padding:8px 12px;color:var(--text-muted)">' + relTime(log.created_at) + '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';
        }

        logsEl.innerHTML = html;
      }).catch(function() {
        logsEl.innerHTML = renderShellState('error', 'Usage data unavailable', 'We could not load app metrics right now.', { compact: true });
      });

      // Health section
      var healthEl = document.getElementById('appHealthSection');
      if (healthEl) {
        healthEl.innerHTML = renderSectionState('Health', 'loading', 'Loading health data', 'Checking live status, auto-heal, and function error rates.', { cardClass: 'app-health-loading' });
        var loadingSummaryEl = healthEl.querySelector('.section-card');
        if (loadingSummaryEl) loadingSummaryEl.id = 'appHealthSummary';
        loadAppHealth(appId);
      }
    }

    // ===== App Store Listing Tab (Phase 2) =====
    // The developer-facing editor for the public /app/:id store page:
    // screenshots (up to 6), long description (markdown), and a live
    // preview of the public URL with copy button.
    //
    // Gated on published visibility — updatePublicTabVisibility() hides
    // the sidebar entry when the app is private/unlisted.
    function loadAppStoreListing(appId, app) {
      var contentEl = document.getElementById('appStoreListingContent');
      if (!contentEl) return;

      var vis = app && app.visibility;
      var isPublished = vis === 'published' || vis === 'public';
      if (!isPublished) {
        contentEl.innerHTML =
          '<div class="section-card">' +
            '<h3 class="section-title">Not Published</h3>' +
            '<p style="font-size:13px;color:var(--text-muted);">Set visibility to <strong>Published</strong> to edit your App Store listing.</p>' +
          '</div>';
        return;
      }

      var origin = window.location.origin;
      var publicUrl = origin + '/app/' + encodeURIComponent(app.id);
      var screenshots = Array.isArray(app.screenshots) ? app.screenshots : [];
      var longDesc = typeof app.long_description === 'string' ? app.long_description : '';

      contentEl.innerHTML =
        // Public URL preview
        '<div class="section-card">' +
          '<h3 class="section-title">Public URL</h3>' +
          '<div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;">' +
            '<code style="flex:1;min-width:200px;font-size:12px;padding:6px 10px;background:var(--bg-active);border:1px solid var(--border);word-break:break-all;">' + escapeHtml(publicUrl) + '</code>' +
            '<button class="btn btn-ghost btn-sm" onclick="copyStoreListingUrl()" id="storeListingUrlBtn">Copy</button>' +
            '<a href="' + escapeHtml(publicUrl) + '" target="_blank" class="btn btn-ghost btn-sm">Open &rarr;</a>' +
          '</div>' +
          '<p style="font-size:11px;color:var(--text-muted);margin-top:var(--space-2);">Share this link to give anyone a rich preview and one-click install.</p>' +
        '</div>' +

        // Screenshots
        '<div class="section-card" style="margin-top:var(--space-4);">' +
          '<h3 class="section-title">Screenshots</h3>' +
          '<p style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">Up to 6 images, max 2MB each. PNG, JPG, or WebP. The first screenshot is used as the share preview.</p>' +
          '<div id="storeListingScreenshots" class="screenshots-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));gap:var(--space-3);margin-bottom:var(--space-3);"></div>' +
          '<input type="file" id="storeListingFileInput" accept="image/png,image/jpeg,image/webp" style="display:none;">' +
          '<button class="btn btn-secondary btn-sm" id="storeListingAddBtn" onclick="document.getElementById(\\'storeListingFileInput\\').click()">+ Add Screenshot</button>' +
          '<span id="storeListingUploadStatus" style="margin-left:var(--space-2);font-size:12px;color:var(--text-muted);"></span>' +
        '</div>' +

        // Long description
        '<div class="section-card" style="margin-top:var(--space-4);">' +
          '<h3 class="section-title">Long Description</h3>' +
          '<p style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);">Supports markdown. Rendered below the hero on your public store page. Max 50KB.</p>' +
          '<textarea id="storeListingLongDesc" class="form-input" rows="12" placeholder="Describe what your app does, how to use it, example workflows...&#10;&#10;**Markdown** is supported.">' + escapeHtml(longDesc) + '</textarea>' +
          '<div style="display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-3);">' +
            '<button class="btn btn-primary btn-sm" onclick="saveStoreListing()" id="storeListingSaveBtn">Save listing</button>' +
            '<span id="storeListingSaveStatus" style="font-size:12px;color:var(--text-muted);"></span>' +
          '</div>' +
        '</div>';

      renderStoreListingScreenshots(screenshots);

      // Wire file input
      var fileInput = document.getElementById('storeListingFileInput');
      if (fileInput) {
        fileInput.onchange = function() {
          var f = fileInput.files && fileInput.files[0];
          if (f) uploadStoreListingScreenshot(f);
          fileInput.value = ''; // reset so same filename can re-trigger
        };
      }
    }

    // Render the screenshot thumbnail grid from the current app.screenshots array
    function renderStoreListingScreenshots(screenshots) {
      var grid = document.getElementById('storeListingScreenshots');
      if (!grid) return;
      if (!screenshots || screenshots.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1;padding:var(--space-4);text-align:center;color:var(--text-muted);font-size:12px;border:1px dashed var(--border);">No screenshots yet. Click "Add Screenshot" to upload your first.</div>';
        return;
      }
      var appId = (window._currentApp && window._currentApp.id) || '';
      // Cache-bust per app snapshot (regenerate on mount) so replaced
      // screenshots show without a manual refresh.
      var cacheBust = '?v=' + Date.now();
      grid.innerHTML = screenshots.map(function(_, i) {
        return '<div class="screenshot-tile" data-idx="' + i + '" style="position:relative;aspect-ratio:16/10;background:var(--bg-active);border:1px solid var(--border);overflow:hidden;">' +
          '<img src="/api/apps/' + encodeURIComponent(appId) + '/screenshots/' + i + cacheBust + '" style="width:100%;height:100%;object-fit:cover;display:block;" alt="Screenshot ' + (i + 1) + '">' +
          '<div style="position:absolute;top:4px;right:4px;display:flex;gap:4px;">' +
            (i > 0 ? '<button class="btn btn-ghost btn-sm" title="Move left" onclick="moveStoreListingScreenshot(' + i + ', -1)" style="padding:2px 6px;background:rgba(0,0,0,0.6);color:#fff;font-size:11px;">&larr;</button>' : '') +
            (i < screenshots.length - 1 ? '<button class="btn btn-ghost btn-sm" title="Move right" onclick="moveStoreListingScreenshot(' + i + ', 1)" style="padding:2px 6px;background:rgba(0,0,0,0.6);color:#fff;font-size:11px;">&rarr;</button>' : '') +
            '<button class="btn btn-ghost btn-sm" title="Delete" onclick="deleteStoreListingScreenshot(' + i + ')" style="padding:2px 6px;background:rgba(220,38,38,0.85);color:#fff;font-size:11px;">&times;</button>' +
          '</div>' +
          '<div style="position:absolute;bottom:4px;left:4px;padding:2px 6px;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;">' + (i + 1) + '</div>' +
        '</div>';
      }).join('');
    }

    // Upload a new screenshot via multipart POST
    async function uploadStoreListingScreenshot(file) {
      var statusEl = document.getElementById('storeListingUploadStatus');
      var addBtn = document.getElementById('storeListingAddBtn');
      var appId = window._currentApp && window._currentApp.id;
      if (!appId || !authToken) return;

      if (statusEl) statusEl.textContent = 'Uploading...';
      if (addBtn) addBtn.disabled = true;

      try {
        var fd = new FormData();
        fd.append('screenshot', file);
        var res = await fetch('/api/apps/' + encodeURIComponent(appId) + '/screenshots', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken },
          body: fd,
        });
        if (!res.ok) {
          var err = await res.json().catch(function() { return {}; });
          throw new Error(err.error || ('Upload failed (' + res.status + ')'));
        }
        var data = await res.json();
        // Sync local state + re-render
        window._currentApp.screenshots = data.screenshots;
        renderStoreListingScreenshots(data.screenshots);
        if (statusEl) statusEl.textContent = '\\u2713 Uploaded';
        setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2000);
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + (err && err.message ? err.message : 'Upload failed');
        showToast('Upload failed', 'error');
      } finally {
        if (addBtn) addBtn.disabled = false;
      }
    }

    // Delete a screenshot by index
    async function deleteStoreListingScreenshot(index) {
      var appId = window._currentApp && window._currentApp.id;
      if (!appId || !authToken) return;
      if (!confirm('Delete this screenshot? This cannot be undone.')) return;
      try {
        var res = await fetch('/api/apps/' + encodeURIComponent(appId) + '/screenshots/' + index, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) throw new Error('Delete failed');
        var data = await res.json();
        window._currentApp.screenshots = data.screenshots;
        renderStoreListingScreenshots(data.screenshots);
      } catch (err) {
        showToast('Failed to delete screenshot', 'error');
      }
    }

    // Move a screenshot left (-1) or right (+1) in the order
    async function moveStoreListingScreenshot(index, delta) {
      var appId = window._currentApp && window._currentApp.id;
      if (!appId || !authToken) return;
      var current = (window._currentApp.screenshots || []).slice();
      var target = index + delta;
      if (target < 0 || target >= current.length) return;

      // Build the new permutation of indices
      var order = current.map(function(_, i) { return i; });
      var tmp = order[index];
      order[index] = order[target];
      order[target] = tmp;

      try {
        var res = await fetch('/api/apps/' + encodeURIComponent(appId) + '/screenshots/order', {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + authToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ order: order }),
        });
        if (!res.ok) throw new Error('Reorder failed');
        var data = await res.json();
        window._currentApp.screenshots = data.screenshots;
        renderStoreListingScreenshots(data.screenshots);
      } catch (err) {
        showToast('Failed to reorder', 'error');
      }
    }

    // Save long description via PATCH /api/apps/:id
    async function saveStoreListing() {
      var appId = window._currentApp && window._currentApp.id;
      if (!appId || !authToken) return;
      var taEl = document.getElementById('storeListingLongDesc');
      var statusEl = document.getElementById('storeListingSaveStatus');
      var saveBtn = document.getElementById('storeListingSaveBtn');
      if (!taEl) return;
      var longDesc = taEl.value;

      if (longDesc.length > 50000) {
        if (statusEl) statusEl.textContent = 'Too long (max 50KB)';
        return;
      }

      if (saveBtn) saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Saving...';

      try {
        var res = await fetch('/api/apps/' + encodeURIComponent(appId), {
          method: 'PATCH',
          headers: {
            'Authorization': 'Bearer ' + authToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ long_description: longDesc }),
        });
        if (!res.ok) {
          var err = await res.json().catch(function() { return {}; });
          throw new Error(err.error || 'Save failed');
        }
        var data = await res.json();
        window._currentApp.long_description = data.long_description;
        if (statusEl) statusEl.textContent = '\\u2713 Saved';
        setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2000);
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + (err && err.message ? err.message : 'Save failed');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    // Copy public URL to clipboard
    function copyStoreListingUrl() {
      var appId = window._currentApp && window._currentApp.id;
      if (!appId) return;
      var url = window.location.origin + '/app/' + encodeURIComponent(appId);
      navigator.clipboard.writeText(url).then(function() {
        var btn = document.getElementById('storeListingUrlBtn');
        if (btn) {
          var orig = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(function() { btn.textContent = orig; }, 1500);
        }
      });
    }

    // Expose for inline onclicks
    window.copyStoreListingUrl = copyStoreListingUrl;
    window.deleteStoreListingScreenshot = deleteStoreListingScreenshot;
    window.moveStoreListingScreenshot = moveStoreListingScreenshot;
    window.saveStoreListing = saveStoreListing;

    function marketplaceCheckTone(status) {
      if (status === 'ready') return { color: 'var(--success)', bg: 'rgba(34,197,94,0.10)', label: 'Ready' };
      if (status === 'blocked') return { color: 'var(--error)', bg: 'rgba(239,68,68,0.10)', label: 'Blocked' };
      if (status === 'action') return { color: '#ca8a04', bg: 'rgba(234,179,8,0.12)', label: 'Action' };
      return { color: 'var(--text-muted)', bg: 'var(--bg-secondary)', label: 'Optional' };
    }

    function renderMarketplaceAdminChecklist(admin) {
      if (!admin || !Array.isArray(admin.checklist)) return '';
      var checks = admin.checklist.map(function(check) {
        var tone = marketplaceCheckTone(check.status);
        return '<div style="padding:var(--space-3);border:1px solid var(--border);background:var(--bg-secondary);display:flex;gap:var(--space-3);align-items:flex-start;">' +
          '<span style="min-width:64px;text-align:center;font-size:11px;font-weight:600;color:' + tone.color + ';background:' + tone.bg + ';padding:3px 6px;border-radius:2px;">' + escapeHtml(tone.label) + '</span>' +
          '<div style="min-width:0;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">' + escapeHtml(check.label) + '</div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;line-height:1.4;">' + escapeHtml(check.detail || '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      var payoutLabel = admin.payouts_enabled
        ? 'Payouts ready'
        : admin.payout_connected
          ? 'Payout review pending'
          : 'Bank not connected';
      var payoutAction = admin.payouts_enabled
        ? ''
        : '<button class="btn btn-secondary btn-sm" onclick="openMarketplacePayoutSetup()">Set up payouts</button>';
      return '<div class="section-card" style="margin-top:var(--space-4);">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-3);">' +
          '<div>' +
            '<h3 class="section-title" style="margin-bottom:4px;">Launch Checklist</h3>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:0;">Next: ' + escapeHtml(admin.recommended_action || 'Share the listing and monitor offers.') + '</p>' +
          '</div>' +
          '<div style="text-align:right;min-width:140px;">' +
            '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Payout Status</div>' +
            '<div style="font-size:13px;font-weight:600;color:' + (admin.payouts_enabled ? 'var(--success)' : 'var(--text-primary)') + ';">' + escapeHtml(payoutLabel) + '</div>' +
            (admin.total_earned_light ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Earned ' + formatLight(admin.total_earned_light) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--space-2);">' + checks + '</div>' +
        (payoutAction ? '<div style="margin-top:var(--space-3);">' + payoutAction + '</div>' : '') +
      '</div>';
    }

    function marketplaceSaleMath(amount) {
      var value = Number(amount);
      if (!Number.isFinite(value) || value <= 0) return null;
      var rounded = Math.round(value);
      var fee = Math.round(rounded * getPlatformFeeRate() * 100) / 100;
      return {
        price: rounded,
        fee: fee,
        payout: Math.round((rounded - fee) * 100) / 100,
      };
    }

    function renderMarketplaceSalePreview(summary, listing, appId) {
      var publicUrl = window.location.origin + '/app/' + encodeURIComponent(appId);
      var price = summary && typeof summary.ask_price_light === 'number' ? summary.ask_price_light : null;
      var math = marketplaceSaleMath(price);
      var listingMode = summary && summary.instant_buy ? 'Instant acquisition enabled' : 'Offer review';
      var previewRows = math
        ? '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-2);margin-top:var(--space-3);">' +
            '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">Acquirer pays</div><div style="font-size:16px;font-weight:700;">' + formatLight(math.price) + '</div></div>' +
            '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">Platform fee</div><div style="font-size:16px;font-weight:700;">' + formatLight(math.fee) + '</div></div>' +
            '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">You receive</div><div style="font-size:16px;font-weight:700;color:var(--success);">' + formatLight(math.payout) + '</div></div>' +
          '</div>'
        : '<div style="font-size:13px;color:var(--text-muted);margin-top:var(--space-2);">Set an ask price to preview instant-acquisition economics. Offers use the configured ' + escapeHtml(getPlatformFeePercentLabel()) + ' platform fee when accepted.</div>';
      return '<div class="section-card" style="margin-top:var(--space-4);">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3);">' +
          '<div>' +
            '<h3 class="section-title" style="margin-bottom:4px;">Listing Preview</h3>' +
            '<div style="font-size:12px;color:var(--text-muted);">' + escapeHtml(listingMode) + (listing && listing.show_metrics ? ' · metrics public' : ' · metrics hidden') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end;">' +
            '<button class="btn btn-ghost btn-sm" onclick="copyMarketplacePublicUrl(\\\'' + appId + '\\\')">Copy URL</button>' +
            '<a class="btn btn-secondary btn-sm" href="' + escapeHtml(publicUrl) + '" target="_blank">Open page</a>' +
          '</div>' +
        '</div>' +
        previewRows +
        '<div id="mktOwnerMetricsPreview" style="margin-top:var(--space-3);"></div>' +
      '</div>';
    }

    window.updateMarketplaceSalePreview = function() {
      var preview = document.getElementById('mktSalePreviewLive');
      if (!preview) return;
      var ask = Math.round(parseFloat((document.getElementById('mktAskPrice') || {}).value) || 0);
      var floor = Math.round(parseFloat((document.getElementById('mktFloorPrice') || {}).value) || 0);
      var instantBuy = (document.getElementById('mktInstantBuy') || {}).checked || false;
      var math = marketplaceSaleMath(ask);
      var warnings = [];
      if (instantBuy && !math) warnings.push('Instant acquisition requires an ask price.');
      if (math && floor > math.price) warnings.push('Floor price cannot exceed ask price.');
      var rows = math
        ? '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-2);">' +
            '<div><div style="font-size:11px;color:var(--text-muted);">Ask</div><div style="font-size:15px;font-weight:700;">' + formatLight(math.price) + '</div></div>' +
            '<div><div style="font-size:11px;color:var(--text-muted);">Fee</div><div style="font-size:15px;font-weight:700;">' + formatLight(math.fee) + '</div></div>' +
            '<div><div style="font-size:11px;color:var(--text-muted);">Payout</div><div style="font-size:15px;font-weight:700;color:var(--success);">' + formatLight(math.payout) + '</div></div>' +
          '</div>'
        : '<div style="font-size:12px;color:var(--text-muted);">No ask price set. Acquirers can still place offers if this listing is active.</div>';
      preview.innerHTML = rows + (warnings.length
        ? '<div style="font-size:12px;color:var(--error);margin-top:var(--space-2);">' + escapeHtml(warnings.join(' ')) + '</div>'
        : '<div style="font-size:12px;color:var(--text-muted);margin-top:var(--space-2);">Accepting a bid uses the configured ' + escapeHtml(getPlatformFeePercentLabel()) + ' platform fee.</div>');
    };

    function loadOwnerMarketplaceMetrics(appId) {
      var el = document.getElementById('mktOwnerMetricsPreview');
      if (!el) return;
      el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Loading owner metrics...</div>';
      fetch('/api/marketplace/metrics/' + appId, {
        headers: { 'Authorization': 'Bearer ' + authToken },
      }).then(function(res) {
        if (!res.ok) throw new Error('metrics unavailable');
        return res.json();
      }).then(function(m) {
        el.innerHTML =
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--space-2);">' +
            '<div style="padding:var(--space-2);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">30d calls</div><div style="font-size:15px;font-weight:700;">' + (m.calls_30d || 0).toLocaleString() + '</div></div>' +
            '<div style="padding:var(--space-2);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">30d callers</div><div style="font-size:15px;font-weight:700;">' + (m.unique_callers_30d || 0).toLocaleString() + '</div></div>' +
            '<div style="padding:var(--space-2);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">30d revenue</div><div style="font-size:15px;font-weight:700;color:var(--success);">' + formatLight(m.revenue_30d_light || 0) + '</div></div>' +
            '<div style="padding:var(--space-2);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">Success rate</div><div style="font-size:15px;font-weight:700;">' + Math.round((m.success_rate_30d || 0) * 100) + '%</div></div>' +
          '</div>';
      }).catch(function() {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Metrics unavailable right now.</div>';
      });
    }

    window.copyMarketplacePublicUrl = function(appId) {
      var url = window.location.origin + '/app/' + encodeURIComponent(appId);
      navigator.clipboard.writeText(url).then(function() {
        showToast('Marketplace URL copied');
      }).catch(function() {
        showToast('Could not copy URL', 'error');
      });
    };

    window.openMarketplacePayoutSetup = function() {
      showView('dashboard');
      switchDashSection('billing');
      selectWalletTab('earnings');
      if (typeof window.startConnectOnboarding === 'function') window.startConnectOnboarding();
    };

    function readMarketplaceJson(res, fallback) {
      if (res.ok) return res.json();
      return res.json().catch(function() { return {}; }).then(function(errBody) {
        var err = new Error(errBody.error || fallback || 'Marketplace action failed');
        err.status = res.status;
        throw err;
      });
    }

    function showMarketplaceActionError(err, fallback) {
      var msg = err && err.message ? err.message : (fallback || 'Marketplace action failed');
      if ((err && err.status === 402) || /insufficient balance/i.test(msg)) {
        showToast(msg + '. Add Light from Wallet.', 'error');
        return;
      }
      showToast(msg, 'error');
    }

    function shortReceiptId(id) {
      if (!id) return '';
      var str = String(id);
      return str.length > 12 ? str.slice(0, 8) + '...' + str.slice(-4) : str;
    }

    window.copyMarketplaceReceiptId = function(id) {
      if (!id) return;
      navigator.clipboard.writeText(String(id)).then(function() {
        showToast('Receipt ID copied');
      }).catch(function() {
        showToast('Could not copy receipt ID', 'error');
      });
    };

    window.closeMarketplaceReceipt = function() {
      var overlay = document.getElementById('marketplaceReceiptOverlay');
      if (overlay) overlay.remove();
    };

    function showMarketplaceReceipt(kind, data) {
      data = data || {};
      closeMarketplaceReceipt();
      var receiptId = data.sale_id || data.bid_id || '';
      var title = kind === 'bid'
        ? 'Bid placed'
        : kind === 'sale'
          ? 'Acquisition closed'
          : 'Acquisition complete';
      var amount = data.sale_price_light || data.amount_light || 0;
      var sellerPayout = data.seller_payout_light || null;
      var appId = data.app_id || '';
      var primaryAction = kind === 'acquisition' && appId
        ? '<button class="btn btn-primary btn-sm" onclick="closeMarketplaceReceipt(); navigateToApp(\\\'' + appId + '\\\')">Open app</button>'
        : kind === 'bid'
          ? '<button class="btn btn-primary btn-sm" onclick="closeMarketplaceReceipt()">Done</button>'
        : '<button class="btn btn-primary btn-sm" onclick="window.location.reload()">Refresh</button>';
      var overlay = document.createElement('div');
      overlay.id = 'marketplaceReceiptOverlay';
      overlay.className = 'offers-overlay';
      overlay.onclick = function(e) { if (e.target === overlay) closeMarketplaceReceipt(); };
      var panel = document.createElement('div');
      panel.className = 'offers-popup';
      panel.onclick = function(e) { e.stopPropagation(); };
      panel.innerHTML =
        '<div class="offers-popup-header">' +
          '<h3>' + escapeHtml(title) + '</h3>' +
          '<button class="offers-popup-close" onclick="closeMarketplaceReceipt()">&times;</button>' +
        '</div>' +
        '<div class="offers-popup-body">' +
          '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:var(--space-3);margin-bottom:var(--space-4);">' +
            '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">Amount</div><div style="font-size:18px;font-weight:700;color:var(--success);">' + formatLight(amount) + '</div></div>' +
            '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);"><div style="font-size:11px;color:var(--text-muted);">Receipt</div><div style="font-size:13px;font-family:var(--font-mono);color:var(--text-primary);">' + escapeHtml(shortReceiptId(receiptId)) + '</div></div>' +
          '</div>' +
          (sellerPayout ? '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:var(--space-3);">Seller payout: <strong>' + formatLight(sellerPayout) + '</strong>. Platform fee and acquisition transfer were recorded atomically.</div>' : '') +
          '<div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">' +
            primaryAction +
            (receiptId ? '<button class="btn btn-secondary btn-sm" onclick="copyMarketplaceReceiptId(\\\'' + receiptId + '\\\')">Copy receipt</button>' : '') +
            '<button class="btn btn-ghost btn-sm" onclick="closeMarketplaceReceipt()">Close</button>' +
          '</div>' +
        '</div>';
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    }

    function loadMarketplaceBidBalance(targetId) {
      var el = document.getElementById(targetId);
      if (!el || !authToken) return;
      fetch('/api/user/hosting', { headers: { 'Authorization': 'Bearer ' + authToken } })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          if (!d || !el) return;
          var avail = d.balance_light || 0;
          el.dataset.balanceLight = String(avail);
          el.innerHTML = 'Available balance: <span>' + formatLight(avail) + '</span>';
        }).catch(function() {});
    }

    // ===== Offers Tab =====
    function loadAppOffers(appId, app) {
      const contentEl = document.getElementById('appOffersContent');
      const bidsEl = document.getElementById('appOffersBids');
      const historyEl = document.getElementById('appOffersHistory');
      if (!contentEl) return;

      // Apps that have ever used an external database are permanently ineligible
      if (app && app.had_external_db) {
        contentEl.innerHTML =
          '<div class="section-card">' +
            '<h3 class="section-title">Trading Unavailable</h3>' +
            '<p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-2)">This app is permanently ineligible for marketplace trading because it has used an external database.</p>' +
            '<p style="font-size:13px;color:var(--text-muted)">Apps that connect to external Supabase are excluded from trading to protect acquirers from taking over apps with inaccessible data dependencies.</p>' +
          '</div>';
        if (bidsEl) bidsEl.innerHTML = '';
        if (historyEl) historyEl.innerHTML = '';
        return;
      }

      const isOwner = app && app.owner_id === window._currentUserId;

      contentEl.innerHTML = renderShellState('loading', 'Loading marketplace data', 'Checking listing status, bids, and acquisition history.', { compact: true });
      if (bidsEl) bidsEl.innerHTML = '';
      if (historyEl) historyEl.innerHTML = '';

      fetch('/api/marketplace/listing/' + appId, {
        headers: { 'Authorization': 'Bearer ' + authToken },
      }).then(function(res) {
        if (!res.ok) throw new Error('Failed to load');
        return res.json();
      }).then(function(data) {
        const listing = data.listing;
        const bids = data.bids || [];
        const appData = data.app;
        const summary = data.marketplace_summary || {};

        // ── Listing / Ask Price Section ──
        if (isOwner) {
          // Owner: show ask price form + incoming bids
          var askVal = listing && listing.ask_price_light ? String(listing.ask_price_light) : '';
          var floorVal = listing && listing.floor_price_light ? String(listing.floor_price_light) : '';
          var instantBuy = listing ? listing.instant_buy : false;
          var noteVal = listing && listing.listing_note ? listing.listing_note : '';
          var ownerAdmin = data.owner_admin || null;
          var statusLabels = {
            ineligible: 'Ineligible',
            unlisted: 'Unlisted',
            open_to_offers: 'Open to offers',
            listed: 'Listed',
            sold: 'Acquired',
          };
          var statusLabel = statusLabels[summary.status] || (listing ? 'Listed' : 'Unlisted');
          var statusColor = summary.status === 'listed' || summary.status === 'open_to_offers'
            ? 'var(--success)'
            : summary.status === 'ineligible'
              ? 'var(--error)'
              : 'var(--text-primary)';
          var summaryAsk = typeof summary.ask_price_light === 'number' ? formatLight(summary.ask_price_light) : 'No ask';
          var summaryBid = typeof summary.highest_bid_light === 'number'
            ? formatLight(summary.highest_bid_light)
            : 'No active bids';
          var bidSubtext = typeof summary.active_bid_count === 'number'
            ? (summary.active_bid_count === 1 ? '1 active bid' : summary.active_bid_count + ' active bids')
            : (bids.length === 1 ? '1 active bid' : bids.length + ' active bids');
          var payoutDisplay = typeof summary.seller_payout_at_ask_light === 'number'
            ? formatLight(summary.seller_payout_at_ask_light)
            : 'Set ask';
          var feeDisplay = typeof summary.platform_fee_at_ask_light === 'number'
            ? 'Fee ' + formatLight(summary.platform_fee_at_ask_light)
            : 'No fee yet';
          var readinessHtml = summary.eligible === false
            ? '<div style="margin-top:var(--space-3);padding:var(--space-3);border:1px solid var(--error);color:var(--error);font-size:13px">Trading blocked: ' + escapeHtml((summary.blockers || []).join(', ') || 'not eligible') + '</div>'
            : '';
          var adminChecklistHtml = renderMarketplaceAdminChecklist(ownerAdmin);
          var previewHtml = renderMarketplaceSalePreview(summary, listing, appId);

          contentEl.innerHTML =
            '<div class="section-card">' +
              '<h3 class="section-title">Marketplace Status</h3>' +
              '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:var(--space-3)">' +
                '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border)">' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em">Status</div>' +
                  '<div style="font-size:15px;font-weight:700;color:' + statusColor + '">' + escapeHtml(statusLabel) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + (summary.instant_buy ? 'Instant acquisition enabled' : 'Bids enabled') + '</div>' +
                '</div>' +
                '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border)">' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em">Ask</div>' +
                  '<div style="font-size:15px;font-weight:700;color:var(--text-primary)">' + escapeHtml(summaryAsk) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + (summary.show_metrics ? 'Metrics public' : 'Metrics hidden') + '</div>' +
                '</div>' +
                '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border)">' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em">Highest Bid</div>' +
                  '<div style="font-size:15px;font-weight:700;color:var(--text-primary)">' + escapeHtml(summaryBid) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + escapeHtml(bidSubtext) + '</div>' +
                '</div>' +
                '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border)">' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em">Seller Payout</div>' +
                  '<div style="font-size:15px;font-weight:700;color:var(--text-primary)">' + escapeHtml(payoutDisplay) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + escapeHtml(feeDisplay) + '</div>' +
                '</div>' +
              '</div>' +
              readinessHtml +
            '</div>' +
            adminChecklistHtml +
            previewHtml +
            '<div class="section-card">' +
              '<h3 class="section-title">Acquisition Terms</h3>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(--space-3)">' +
                '<div>' +
                  '<label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Ask Price (\\u2726)</label>' +
                  '<input id="mktAskPrice" type="number" step="1" min="0" placeholder="e.g. 50000" value="' + askVal + '" class="input-field" style="width:100%" oninput="updateMarketplaceSalePreview()">' +
                '</div>' +
                '<div>' +
                  '<label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Floor Price (\\u2726)</label>' +
                  '<input id="mktFloorPrice" type="number" step="1" min="0" placeholder="Min bid" value="' + floorVal + '" class="input-field" style="width:100%" oninput="updateMarketplaceSalePreview()">' +
                '</div>' +
              '</div>' +
              '<div id="mktSalePreviewLive" style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);margin-bottom:var(--space-3);"></div>' +
              '<div style="margin-bottom:var(--space-3)">' +
                '<label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Listing Note</label>' +
                  '<input id="mktNote" type="text" placeholder="Optional pitch to acquirers" value="' + escapeHtml(noteVal) + '" class="input-field" style="width:100%">' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:var(--space-4)">' +
                '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">' +
                  '<input id="mktInstantBuy" type="checkbox"' + (instantBuy ? ' checked' : '') + ' onchange="updateMarketplaceSalePreview()">' +
                  ' Allow instant acquisition at ask price' +
                '</label>' +
                '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">' +
                  '<input id="mktShowMetrics" type="checkbox"' + (listing && listing.show_metrics ? ' checked' : '') + ' onchange="toggleMetricsVisibility(\\\'' + appId + '\\\', this.checked)">' +
                  ' Show usage metrics to potential bidders' +
                '</label>' +
              '</div>' +
              '<div style="display:flex;gap:var(--space-2)">' +
                '<button class="btn btn-primary btn-sm" onclick="saveAskPrice(\\\'' + appId + '\\\')">Save Listing</button>' +
                (askVal ? '<button class="btn btn-secondary btn-sm" onclick="removeAskPrice(\\\'' + appId + '\\\')">Remove Ask Price</button>' : '') +
              '</div>' +
            '</div>';
          updateMarketplaceSalePreview();
          loadOwnerMarketplaceMetrics(appId);

          // ── Incoming Bids Table ──
          if (bidsEl) {
            if (bids.length === 0) {
              bidsEl.innerHTML =
                '<div class="section-card">' +
                  '<h3 class="section-title">Incoming Bids</h3>' +
                  '<p style="font-size:13px;color:var(--text-muted)">No active bids on this app.</p>' +
                '</div>';
            } else {
              bidsEl.innerHTML =
                '<div class="section-card">' +
                  '<h3 class="section-title">Incoming Bids (' + bids.length + ')</h3>' +
                  '<div style="display:flex;flex-direction:column;gap:var(--space-3);">' +
                    bids.map(function(bid) {
                      var bidMath = marketplaceSaleMath(bid.amount_light);
                      var bidder = bid.bidder_email || bid.bidder_id.slice(0, 8);
                      var expires = bid.expires_at ? ' · expires ' + new Date(bid.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                      return '<div style="border:1px solid var(--border);background:var(--bg-secondary);padding:var(--space-3);">' +
                        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3);">' +
                          '<div style="min-width:0;">' +
                            '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">' + escapeHtml(bidder) + '</div>' +
                            '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + relTime(bid.created_at) + expires + '</div>' +
                            (bid.message ? '<div style="font-size:13px;color:var(--text-secondary);margin-top:var(--space-2);line-height:1.4;">' + escapeHtml(bid.message) + '</div>' : '') +
                          '</div>' +
                          '<div style="text-align:right;min-width:160px;">' +
                            '<div style="font-size:20px;font-weight:700;color:var(--success);">' + formatLight(bid.amount_light) + '</div>' +
                            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">You receive ' + formatLight(bidMath ? bidMath.payout : 0) + ' · fee ' + formatLight(bidMath ? bidMath.fee : 0) + '</div>' +
                          '</div>' +
                        '</div>' +
                        '<div style="display:flex;gap:var(--space-2);margin-top:var(--space-3);">' +
                          '<button class="btn btn-primary btn-sm" onclick="acceptBid(\\\'' + bid.id + '\\\',\\\'' + appId + '\\\')">Accept offer</button>' +
                          '<button class="btn btn-secondary btn-sm" onclick="rejectBid(\\\'' + bid.id + '\\\',\\\'' + appId + '\\\')">Reject</button>' +
                        '</div>' +
                      '</div>';
                    }).join('') +
                  '</div>' +
                '</div>';
            }
          }
        } else {
          // Non-owner: show ask price info + bid form
          var soldNotice = summary.status === 'sold'
            ? '<div style="padding:var(--space-3);background:var(--bg-secondary);border:1px solid var(--border);color:var(--text-secondary);font-size:13px;margin-top:var(--space-3);">This app was already acquired. New bids and instant acquisitions are closed until the current owner relists it.</div>'
            : '';
          var askDisplay = listing && listing.ask_price_light
            ? '<span style="font-size:24px;font-weight:700;color:var(--success)">' + formatLight(listing.ask_price_light) + '</span>'
            : '<span style="font-size:14px;color:var(--text-muted)">Open to offers</span>';

          var floorDisplay = listing && listing.floor_price_light
            ? '<span style="font-size:12px;color:var(--text-muted);margin-left:var(--space-2)">Floor: ' + formatLight(listing.floor_price_light) + '</span>'
            : '';

          var instantBuyBtn = summary.status !== 'sold' && listing && listing.instant_buy && listing.ask_price_light
            ? '<button class="btn btn-primary" style="margin-top:var(--space-3)" onclick="acquireNow(\\\'' + appId + '\\\')">Acquire — ' + formatLight(listing.ask_price_light) + '</button>'
            : '';

          var noteDisplay = listing && listing.listing_note
            ? '<p style="font-size:13px;color:var(--text-secondary);margin-top:var(--space-2);font-style:italic">' + escapeHtml(listing.listing_note) + '</p>'
            : '';

          // Fetch and display metrics if enabled
          var metricsHtml = '';
          if (listing && listing.show_metrics) {
            metricsHtml = '<div id="mktMetrics" style="margin-top:var(--space-3);padding:var(--space-3);background:var(--bg-secondary);border-radius:var(--radius);border:1px solid var(--border)">' +
              '<p style="font-size:12px;color:var(--text-muted)">Loading metrics...</p>' +
            '</div>';
            // Fire-and-forget metrics load
            (function(aid) {
              fetch('/api/marketplace/metrics/' + aid, {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('auth_token') }
              })
              .then(function(r) { return r.ok ? r.json() : null; })
              .then(function(m) {
                if (!m) return;
                var el = document.getElementById('mktMetrics');
                if (!el) return;
                el.innerHTML =
                  '<h4 style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:var(--space-2);text-transform:uppercase;letter-spacing:0.5px">Usage Metrics</h4>' +
                  '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:var(--space-2)">' +
                    '<div style="text-align:center;padding:var(--space-2)">' +
                      '<div style="font-size:20px;font-weight:700;color:var(--text-primary)">' + (m.total_calls || 0).toLocaleString() + '</div>' +
                      '<div style="font-size:11px;color:var(--text-muted)">Total Calls</div>' +
                    '</div>' +
                    '<div style="text-align:center;padding:var(--space-2)">' +
                      '<div style="font-size:20px;font-weight:700;color:var(--text-primary)">' + (m.calls_30d || 0).toLocaleString() + '</div>' +
                      '<div style="font-size:11px;color:var(--text-muted)">Calls (30d)</div>' +
                    '</div>' +
                    '<div style="text-align:center;padding:var(--space-2)">' +
                      '<div style="font-size:20px;font-weight:700;color:var(--text-primary)">' + (m.unique_callers_30d || 0).toLocaleString() + '</div>' +
                      '<div style="font-size:11px;color:var(--text-muted)">Unique Callers (30d)</div>' +
                    '</div>' +
                    '<div style="text-align:center;padding:var(--space-2)">' +
                      '<div style="font-size:20px;font-weight:700;color:var(--success)">' + formatLight((m.revenue_30d_light || 0)) + '</div>' +
                      '<div style="font-size:11px;color:var(--text-muted)">Revenue (30d)</div>' +
                    '</div>' +
                  '</div>';
              })
              .catch(function() {});
            })(appId);
          }

          // Check if user already has active bid
          var myBid = bids.find(function(b) { return b.bidder_id === window._currentUserId; });

          contentEl.innerHTML =
            '<div class="section-card">' +
              '<h3 class="section-title">Acquire This App</h3>' +
              '<div style="margin-bottom:var(--space-4)">' +
                '<div style="display:flex;align-items:baseline;gap:var(--space-2)">' +
                  '<span style="font-size:12px;color:var(--text-muted)">Ask Price:</span> ' + askDisplay + floorDisplay +
                '</div>' +
                noteDisplay +
                instantBuyBtn +
                soldNotice +
                metricsHtml +
              '</div>' +
              (summary.status === 'sold'
                ? ''
                : myBid
                ? '<div style="padding:var(--space-3);background:var(--bg-secondary);border-radius:var(--radius);margin-bottom:var(--space-3)">' +
                    '<p style="font-size:13px;font-weight:500">Your active bid: <span style="color:var(--success)">' + formatLight(myBid.amount_light) + '</span></p>' +
                    '<button class="btn btn-secondary btn-sm" style="margin-top:var(--space-2)" onclick="cancelBidFromUI(\\\'' + myBid.id + '\\\',\\\'' + appId + '\\\')">Cancel Bid</button>' +
                  '</div>'
                : '<div style="border-top:1px solid var(--border);padding-top:var(--space-4)">' +
                    '<h4 style="font-size:14px;font-weight:500;margin-bottom:var(--space-3)">Place a Bid</h4>' +
                    '<div style="display:grid;grid-template-columns:1fr 2fr;gap:var(--space-3);margin-bottom:var(--space-3)">' +
                      '<div>' +
                        '<label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Amount (\\u2726)</label>' +
                        '<input id="mktBidAmount" type="number" step="1" min="1" placeholder="50000" class="input-field" style="width:100%">' +
                      '</div>' +
                      '<div>' +
                        '<label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Message (optional)</label>' +
                        '<input id="mktBidMessage" type="text" placeholder="Message to owner" class="input-field" style="width:100%">' +
                      '</div>' +
                    '</div>' +
                    '<div id="mktBidBalance" style="font-size:12px;color:var(--text-muted);margin-bottom:var(--space-3);"></div>' +
                    '<button class="btn btn-primary btn-sm" onclick="placeBidFromUI(\\\'' + appId + '\\\')">Place Bid</button>' +
                  '</div>'
              ) +
            '</div>';
          loadMarketplaceBidBalance('mktBidBalance');
        }

        // ── Provenance / Sale History ──
        if (historyEl) {
          var provenance = listing && listing.provenance ? listing.provenance : [];
          if (provenance.length > 0) {
            historyEl.innerHTML =
              '<div class="section-card">' +
                '<h3 class="section-title">Provenance</h3>' +
                '<div style="font-size:13px">' +
                  provenance.map(function(p, i) {
                    return '<div style="display:flex;align-items:center;gap:var(--space-2);padding:8px 0' + (i < provenance.length - 1 ? ';border-bottom:1px solid var(--border)' : '') + '">' +
                      '<div style="width:20px;height:20px;border-radius:50%;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-muted)">' + (i + 1) + '</div>' +
                      '<div>' +
                        '<span style="color:var(--text-primary)">' + escapeHtml(p.email || p.owner_id.slice(0, 8)) + '</span>' +
                        (p.price_light ? ' <span style="color:var(--text-muted)">— ' + formatLight(p.price_light) + '</span>' : '') +
                        ' <span style="color:var(--text-muted);font-size:11px">' + (p.acquired_at ? relTime(p.acquired_at) : '') + '</span>' +
                      '</div>' +
                    '</div>';
                  }).join('') +
                '</div>' +
              '</div>';
          }
        }
      }).catch(function(err) {
        contentEl.innerHTML = renderSectionState('', 'error', 'Marketplace data unavailable', 'We could not load listing and bid data for this app.');
      });
    }

    // Market action handlers
    window.saveAskPrice = function(appId) {
      var price = parseFloat((document.getElementById('mktAskPrice') || {}).value) || 0;
      var floor = parseFloat((document.getElementById('mktFloorPrice') || {}).value) || 0;
      var instantBuy = (document.getElementById('mktInstantBuy') || {}).checked || false;
      var note = (document.getElementById('mktNote') || {}).value || '';
      var roundedPrice = price > 0 ? Math.round(price) : null;
      var roundedFloor = floor > 0 ? Math.round(floor) : null;

      if (instantBuy && !roundedPrice) {
        showToast('Instant acquisition requires an ask price', 'error');
        return;
      }
      if (roundedPrice && roundedFloor && roundedFloor > roundedPrice) {
        showToast('Floor price cannot exceed ask price', 'error');
        return;
      }

      fetch('/api/marketplace/ask', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: appId,
          price_light: roundedPrice,
          floor_light: roundedFloor,
          instant_buy: instantBuy,
          note: note || null,
        }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast('Listing updated!');
        loadAppOffers(appId, window._currentApp);
      }).catch(function(err) {
        showToast(err.message || 'Failed to save listing', 'error');
      });
    };

    window.removeAskPrice = function(appId) {
      fetch('/api/marketplace/ask', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, price_light: null }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast('Ask price removed');
        loadAppOffers(appId, window._currentApp);
      }).catch(function(err) {
        showToast(err.message || 'Failed to remove ask price', 'error');
      });
    };

    window.toggleMetricsVisibility = function(appId, showMetrics) {
      fetch('/api/marketplace/metrics-visibility', {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, show_metrics: showMetrics }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast(showMetrics ? 'Metrics visible to bidders' : 'Metrics hidden from bidders');
        loadAppOffers(appId, window._currentApp);
      }).catch(function(err) {
        showToast(err.message || 'Failed to update metrics visibility', 'error');
      });
    };

    window.acceptBid = function(bidId, appId) {
      if (!confirm('Accept this bid? This will transfer ownership of the app.')) return;
      fetch('/api/marketplace/accept', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      }).then(function(res) {
        return readMarketplaceJson(res, 'Failed to accept bid');
      }).then(function(data) {
        showMarketplaceReceipt('sale', data);
      }).catch(function(err) {
        showMarketplaceActionError(err, 'Failed to accept bid');
      });
    };

    window.rejectBid = function(bidId, appId) {
      fetch('/api/marketplace/reject', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast('Bid rejected');
        loadAppOffers(appId, window._currentApp);
        loadMyOffers(); // Refresh offers dashboard if visible
      }).catch(function(err) {
        showToast(err.message || 'Failed to reject bid', 'error');
      });
    };

    window.placeBidFromUI = function(appId) {
      var amount = parseFloat((document.getElementById('mktBidAmount') || {}).value);
      var message = (document.getElementById('mktBidMessage') || {}).value || '';
      if (!amount || amount <= 0) { showToast('Enter a valid bid amount', 'error'); return; }
      var balanceEl = document.getElementById('mktBidBalance');
      var available = balanceEl && balanceEl.dataset.balanceLight ? parseFloat(balanceEl.dataset.balanceLight) : null;
      if (available !== null && amount > available) {
        showToast('Insufficient balance. Add Light from Wallet.', 'error');
        return;
      }

      fetch('/api/marketplace/bid', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: appId,
          amount_light: Math.round(amount),
          message: message || null,
        }),
      }).then(function(res) {
        return readMarketplaceJson(res, 'Failed to place bid');
      }).then(function(data) {
        showMarketplaceReceipt('bid', data);
        loadAppOffers(appId, window._currentApp);
      }).catch(function(err) {
        showMarketplaceActionError(err, 'Failed to place bid');
      });
    };

    window.cancelBidFromUI = function(bidId, appId) {
      fetch('/api/marketplace/cancel', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast('Bid cancelled. Escrow refunded.');
        loadAppOffers(appId, window._currentApp);
        loadMyOffers(); // Refresh offers dashboard if visible
      }).catch(function(err) {
        showToast(err.message || 'Failed to cancel bid', 'error');
      });
    };

    window.acquireNow = function(appId) {
      if (!confirm('Acquire this app now at the listed ask price? Ownership transfers to you immediately.')) return;
      fetch('/api/marketplace/acquire', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      }).then(function(res) {
        return readMarketplaceJson(res, 'Failed to acquire app');
      }).then(function(data) {
        showMarketplaceReceipt('acquisition', data);
      }).catch(function(err) {
        showMarketplaceActionError(err, 'Failed to acquire app');
      });
    };
    window.buyNow = window.acquireNow;

    // ===== Offers Popup =====
    window.openOffersPopup = function(appId) {
      // Close any existing popup
      closeOffersPopup();

      // Create overlay
      var overlay = document.createElement('div');
      overlay.className = 'offers-overlay';
      overlay.id = 'offersOverlay';
      overlay.onclick = function(e) { if (e.target === overlay) closeOffersPopup(); };

      // Create popup shell with loading state
      var popup = document.createElement('div');
      popup.className = 'offers-popup';
      popup.onclick = function(e) { e.stopPropagation(); };
      popup.innerHTML =
        '<div class="offers-popup-header">' +
          '<h3>Offer</h3>' +
          '<button class="offers-popup-close" onclick="closeOffersPopup()">&times;</button>' +
        '</div>' +
        '<div class="offers-popup-body" id="offersPopupBody">' +
          '<div style="text-align:center;padding:24px 0"><span class="btn-spinner" style="width:16px;height:16px;border-width:2px"></span></div>' +
        '</div>';

      overlay.appendChild(popup);
      document.body.appendChild(overlay);

      // Close on Escape
      var escHandler = function(e) {
        if (e.key === 'Escape') { closeOffersPopup(); document.removeEventListener('keydown', escHandler); }
      };
      document.addEventListener('keydown', escHandler);

      // Fetch listing data
      var headers = {};
      if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
      fetch('/api/marketplace/listing/' + appId, { headers: headers })
        .then(function(res) { return res.ok ? res.json() : Promise.reject(new Error('Failed')); })
        .then(function(data) {
          var body = document.getElementById('offersPopupBody');
          if (!body) return;
          renderOffersPopupContent(body, appId, data);
        })
        .catch(function() {
          var body = document.getElementById('offersPopupBody');
          if (body) body.innerHTML = '<p class="offers-no-bids">Unable to load offers data.</p>';
        });
    };

    function renderOffersPopupContent(body, appId, data) {
      var listing = data.listing;
      var bids = data.bids || [];
      var appData = data.app;
      var summary = data.marketplace_summary || {};
      var isOwner = appData && appData.owner_id === window._currentUserId;
      var highestBid = bids.length > 0 ? bids[0] : null;
      var html = '';

      // Check if current user has an active bid
      var myBid = null;
      if (window._currentUserId) {
        myBid = bids.find(function(b) { return b.bidder_id === window._currentUserId; });
      }

      // ── Price Overview: Ask + Highest Bid side by side ──
      html += '<div class="offers-price-row">';
      html += '<div class="offers-price-col">';
      html += '<div class="offers-ask-label">Ask</div>';
      if (listing && listing.ask_price_light) {
        html += '<div class="offers-ask-price">' + formatLight(listing.ask_price_light) + '</div>';
      } else {
        html += '<div class="offers-ask-price" style="font-size:16px">Open</div>';
      }
      html += '</div>';
      html += '<div class="offers-price-col" style="text-align:right">';
      html += '<div class="offers-ask-label">Highest Bid</div>';
      if (highestBid) {
        html += '<div class="offers-ask-price">' + formatLight(highestBid.amount_light) + '</div>';
      } else {
        html += '<div class="offers-ask-price" style="font-size:16px">&mdash;</div>';
      }
      html += '</div>';
      html += '</div>';

      // ── Note + instant acquisition ──
      if (listing && listing.listing_note) {
        html += '<div class="offers-ask-note">' + escapeHtml(listing.listing_note) + '</div>';
      }
      if (summary.status === 'sold' && !isOwner) {
        html += '<div class="offers-ask-note">This app has already been acquired. Offers are closed until the current owner relists it.</div>';
      }
      if (summary.status !== 'sold' && !isOwner && listing && listing.instant_buy && listing.ask_price_light) {
        html += '<button class="offers-buynow-btn" onclick="popupAcquireNow(\\\'' + appId + '\\\')">Acquire &mdash; ' + formatLight(listing.ask_price_light) + '</button>';
      }

      // ── Your Bid (if exists) ──
      if (myBid && !isOwner) {
        html += '<div class="offers-your-bid">' +
          '<span>Your bid: <strong>' + formatLight(myBid.amount_light) + '</strong></span>' +
          '<button class="offers-bid-cancel" onclick="popupCancelBid(\\\'' + myBid.id + '\\\',\\\'' + appId + '\\\')">Cancel</button>' +
        '</div>';
      }

      // ── Place Bid Form (non-owners only, no existing bid) ──
      if (summary.status !== 'sold' && !isOwner && !myBid) {
        if (!authToken) {
          html += '<div class="offers-login-msg">Sign in to place a bid.</div>';
        } else {
          html += '<div class="offers-bid-form">';
          html += '<div class="offers-bid-amount-row">' +
            '<span class="offers-bid-currency">\\u2726</span>' +
            '<input class="offers-bid-input" id="popupBidAmount" type="number" step="1" min="1" placeholder="0">' +
          '</div>';
          html += '<input class="offers-bid-input-msg" id="popupBidMessage" type="text" placeholder="Message (optional)">';
          html += '<div class="offers-bid-balance" id="popupBidBalance"></div>';
          html += '<button class="offers-bid-submit" id="popupBidBtn" onclick="popupPlaceBid(\\\'' + appId + '\\\')">Place Bid</button>';
          html += '</div>';
        }
      }

      // ── Bids List ──
      if (bids.length > 0) {
        html += '<div class="offers-bids-section">';
        html += '<div class="offers-bids-title">All Bids (' + bids.length + ')</div>';
        bids.forEach(function(bid) {
          var isMyBid = bid.bidder_id === window._currentUserId;
          html += '<div class="offers-bid-row">';
          html += '<span class="offers-bid-amount">' + formatLight(bid.amount_light) + '</span>';
          html += '<span class="offers-bid-info">' +
            (bid.message ? escapeHtml(bid.message) : (bid.bidder_email ? escapeHtml(bid.bidder_email) : bid.bidder_id.slice(0, 8))) +
            (isMyBid ? ' <strong>(you)</strong>' : '') +
          '</span>';
          html += '<span class="offers-bid-time">' + relTime(bid.created_at) + '</span>';
          if (isOwner) {
            html += '<button class="offers-bid-cancel" style="border-color:var(--text-primary);color:var(--text-primary)" onclick="popupAcceptBid(\\\'' + bid.id + '\\\',\\\'' + appId + '\\\')">Accept</button>';
            html += '<button class="offers-bid-cancel" onclick="popupRejectBid(\\\'' + bid.id + '\\\',\\\'' + appId + '\\\')">Reject</button>';
          }
          html += '</div>';
        });
        html += '</div>';
      }

      body.innerHTML = html;

      // Load available balance into bid form
      loadMarketplaceBidBalance('popupBidBalance');
    }

    window.closeOffersPopup = closeOffersPopup;
    function closeOffersPopup() {
      var overlay = document.getElementById('offersOverlay');
      if (overlay) overlay.remove();
    }

    window.popupPlaceBid = function(appId) {
      var amountEl = document.getElementById('popupBidAmount');
      var messageEl = document.getElementById('popupBidMessage');
      var btn = document.getElementById('popupBidBtn');
      var amount = parseFloat(amountEl ? amountEl.value : '');
      var message = messageEl ? messageEl.value : '';
      if (!amount || amount <= 0) { showToast('Enter a valid bid amount', 'error'); return; }
      var balanceEl = document.getElementById('popupBidBalance');
      var available = balanceEl && balanceEl.dataset.balanceLight ? parseFloat(balanceEl.dataset.balanceLight) : null;
      if (available !== null && amount > available) {
        showToast('Insufficient balance. Add Light from Wallet.', 'error');
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }

      fetch('/api/marketplace/bid', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, amount_light: Math.round(amount), message: message || null }),
      }).then(function(res) {
        return readMarketplaceJson(res, 'Failed to place bid');
      }).then(function(data) {
        closeOffersPopup();
        showMarketplaceReceipt('bid', data);
        // Refresh wallet balance display
        var balEl = document.getElementById('accountBalance');
        if (balEl && typeof loadHostingData === 'function') {
          loadHostingData();
        }
      }).catch(function(err) {
        showMarketplaceActionError(err, 'Failed to place bid');
        if (btn) { btn.disabled = false; btn.textContent = 'Place Bid'; }
      });
    };

    window.popupCancelBid = function(bidId, appId) {
      fetch('/api/marketplace/cancel', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast('Bid cancelled. Escrow refunded.');
        if (typeof loadHostingData === 'function') loadHostingData();
        openOffersPopup(appId); // Refresh popup
      }).catch(function(err) {
        showToast(err.message || 'Failed to cancel bid', 'error');
      });
    };

    window.popupAcquireNow = function(appId) {
      if (!confirm('Acquire this app now at the listed price? Ownership transfers immediately.')) return;
      fetch('/api/marketplace/acquire', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId }),
      }).then(function(res) {
        return readMarketplaceJson(res, 'Failed to acquire app');
      }).then(function(data) {
        closeOffersPopup();
        showMarketplaceReceipt('acquisition', data);
      }).catch(function(err) {
        showMarketplaceActionError(err, 'Failed to acquire app');
      });
    };
    window.popupBuyNow = window.popupAcquireNow;

    window.popupAcceptBid = function(bidId, appId) {
      if (!confirm('Accept this bid? Ownership will transfer.')) return;
      fetch('/api/marketplace/accept', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      }).then(function(res) {
        return readMarketplaceJson(res, 'Failed to accept bid');
      }).then(function(data) {
        closeOffersPopup();
        showMarketplaceReceipt('sale', data);
      }).catch(function(err) {
        showMarketplaceActionError(err, 'Failed to accept bid');
      });
    };

    window.popupRejectBid = function(bidId, appId) {
      fetch('/api/marketplace/reject', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      }).then(function(res) {
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Failed'); });
        showToast('Bid rejected');
        openOffersPopup(appId); // Refresh popup
      }).catch(function(err) {
        showToast(err.message || 'Failed to reject bid', 'error');
      });
    };

    // ===== Copy Functions =====
    window.copyAppEndpoint = function() {
      const base = window.location.origin + '/mcp/' + currentAppId;
      navigator.clipboard.writeText(base).then(function() {
        showToast('MCP endpoint copied. Send your API key in the Authorization header.');
      });
    };

    window.copyPlatformMcpUrl = function() {
      navigator.clipboard.writeText(window.location.origin + '/mcp/platform').then(function() { showToast('Platform MCP URL copied!'); });
    };

    window.copyTrustValue = function(field) {
      var trust = getTrustCard(window._currentApp || {});
      var value = trust && trust[field];
      if (!value) {
        showToast('Trust value unavailable', 'error');
        return;
      }
      navigator.clipboard.writeText(String(value)).then(function() {
        showToast(field === 'manifest_hash' ? 'Manifest hash copied' : 'Artifact hash copied');
      }).catch(function() {
        showToast('Failed to copy trust value', 'error');
      });
    };

    window.copyReceiptId = function(btn) {
      var receiptId = btn && btn.dataset ? btn.dataset.receiptId : '';
      if (!receiptId) {
        showToast('Receipt unavailable', 'error');
        return;
      }
      navigator.clipboard.writeText(receiptId).then(function() {
        showToast('Receipt ID copied');
      }).catch(function() {
        showToast('Failed to copy receipt', 'error');
      });
    };

    window.downloadAppCode = async function() {
      if (!currentAppId || !authToken) return;
      try {
        const res = await fetch('/api/apps/' + currentAppId + '/download', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) { showToast('Failed to download', 'error'); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (window._currentApp?.slug || currentAppId) + '.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch { showToast('Download failed', 'error'); }
    };

    // (Old loadAppSettings removed — content split across loadAppOverview, loadAppPermissions, loadAppEnvironment)

    window.saveAppSettings = async function() {
      if (!currentAppId || !authToken) return;
      try {
        const body = {
          name: document.getElementById('settingName')?.value,
          visibility: document.getElementById('settingVisibility')?.value,
          download_access: document.getElementById('settingDownload')?.value,
        };
        const versionVal = document.getElementById('settingVersion')?.value;
        if (versionVal && window._currentApp && versionVal !== window._currentApp.current_version) {
          body.current_version = versionVal;
        }
        const res = await fetch('/api/apps/' + currentAppId, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          // Update cached app data and tab visibility
          if (body.visibility) {
            window._currentApp.visibility = body.visibility;
            updatePublicTabVisibility();
            var permVisSel = document.getElementById('permVisibility');
            if (permVisSel) permVisSel.value = body.visibility;
          }
          showToast('Settings saved!');
          await loadApps();
        } else {
          const data = await res.json().catch(function() { return {}; });
          showToast(data.error || 'Failed to save', 'error');
        }
      } catch { showToast('Failed to save settings', 'error'); }
    };

    // ===== 15. Delete App =====
    window.showDeleteConfirm = function() {
      const modal = document.getElementById('deleteConfirmModal');
      if (modal) {
        const nameEl = modal.querySelector('.delete-app-name');
        if (nameEl) nameEl.textContent = window._currentApp?.name || currentAppId;
        modal.classList.remove('hidden');
      }
    };

    document.getElementById('deleteConfirm')?.addEventListener('click', async function() {
      if (!currentAppId || !authToken) return;
      this.disabled = true;
      this.textContent = 'Deleting...';
      try {
        const res = await fetch('/api/apps/' + currentAppId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          showToast('App deleted');
          document.getElementById('deleteConfirmModal').classList.add('hidden');
          await loadApps();
          navigateToDashboard();
        } else {
          showToast('Failed to delete app', 'error');
        }
      } catch { showToast('Failed to delete', 'error'); }
      this.disabled = false;
      this.textContent = 'Delete Permanently';
    });
    document.getElementById('deleteCancel')?.addEventListener('click', function() {
      document.getElementById('deleteConfirmModal').classList.add('hidden');
    });

    // ===== 16. Permissions =====
    async function loadPermissions(appId) {
      const container = document.getElementById('permissionsContent');
      if (!container) return;
      try {
        const res = await fetch('/api/user/permissions/' + appId, {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          container.innerHTML = renderShellState('error', 'Permissions unavailable', 'We could not load the access list right now.', { compact: true });
          return;
        }
        const data = await res.json();
        permsGrantedUsers = data.users || data || [];

        let html = '<div style="display:flex;gap:8px;margin-bottom:12px">' +
          '<input type="email" id="permEmailInput" class="form-input form-input-sm" placeholder="user@email.com" style="flex:1">' +
          '<button class="btn btn-primary btn-sm" onclick="addPermissionUser()">Grant Access</button>' +
        '</div>';

        if (permsGrantedUsers.length > 0) {
          html += permsGrantedUsers.map(function(u) {
            const email = escapeHtml(u.email || u.granted_to_email || 'Unknown');
            const fnCount = u.functions ? u.functions.length : 0;
            return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">' +
              '<span style="flex:1;font-size:13px">' + email + '</span>' +
              '<span style="font-size:12px;color:var(--text-muted)">' + fnCount + ' fn</span>' +
              '<button class="btn btn-ghost btn-sm" onclick="openPermissionsDetail(\\\'' + escapeHtml(u.user_id || '') + '\\\', \\\'' + email + '\\\')">Edit</button>' +
              '<button class="btn btn-danger btn-sm" onclick="revokePermission(\\\'' + escapeHtml(u.user_id || '') + '\\\', \\\'' + email + '\\\')">Revoke</button>' +
            '</div>';
          }).join('');
        } else {
          html += renderShellState('empty', 'No one else has access yet', 'Grant access to share this app with another user.', { compact: true });
        }
        container.innerHTML = html;
      } catch {
        container.innerHTML = renderShellState('error', 'Permissions unavailable', 'We could not load the access list right now.', { compact: true });
      }
    }

    window.addPermissionUser = async function() {
      const email = document.getElementById('permEmailInput')?.value?.trim();
      if (!email || !currentAppId) return;
      try {
        // Get app functions
        const fns = getAppFunctions(window._currentApp || {}).functions.map(function(f) { return f.name; });
        const perms = fns.map(function(fn) { return { function_name: fn, allowed: true }; });

        const res = await fetch('/api/user/permissions/' + currentAppId, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, permissions: perms }),
        });
        if (res.ok) {
          showToast('Access granted to ' + email);
          document.getElementById('permEmailInput').value = '';
          loadPermissions(currentAppId);
        } else {
          const data = await res.json().catch(function() { return {}; });
          showToast(data.error || 'Failed to grant access', 'error');
        }
      } catch { showToast('Failed to grant access', 'error'); }
    };

    window.revokePermission = async function(userId, email) {
      if (!confirm('Revoke access for ' + email + '?')) return;
      try {
        const res = await fetch('/api/user/permissions/' + currentAppId + '?user_id=' + userId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          showToast('Access revoked');
          loadPermissions(currentAppId);
        } else showToast('Failed to revoke', 'error');
      } catch { showToast('Failed to revoke', 'error'); }
    };

    window.openPermissionsDetail = function(userId, email) {
      // Open the permissions modal for detailed per-function editing
      permsSelectedUserId = userId;
      const modal = document.getElementById('permissionsModal');
      modal.classList.remove('hidden');
      const detail = document.getElementById('permsDetail');
      if (detail) {
        detail.innerHTML = renderShellState('loading', 'Loading access for ' + email, 'Checking per-function access and constraints.', { compact: true });
        loadPermissionDetail(currentAppId, userId, email);
      }
    };

    async function loadPermissionDetail(appId, userId, email) {
      const detail = document.getElementById('permsDetail');
      try {
        const res = await fetch('/api/user/permissions/' + appId + '?user_id=' + userId, {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          detail.innerHTML = renderShellState('error', 'Permission details unavailable', 'We could not load this user\\'s access settings.', { compact: true });
          return;
        }
        const data = await res.json();
        const perms = data.permissions || data || [];
        const fns = getAppFunctions(window._currentApp || {}).functions;

        let html = '<h4 style="margin-bottom:12px;font-size:14px">' + escapeHtml(email) + '</h4>';
        html += fns.map(function(fn, idx) {
          const perm = perms.find(function(p) { return p.function_name === fn.name; });
          const allowed = perm ? perm.allowed : false;
          const constraints = perm?.constraints ? JSON.stringify(perm.constraints, null, 2) : '';
          return '<div style="padding:8px 0;border-bottom:1px solid var(--border)">' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">' +
              '<input type="checkbox" class="perm-fn-cb" data-fn="' + escapeHtml(fn.name) + '" ' + (allowed ? 'checked' : '') + '>' +
              '<code>' + escapeHtml(fn.name) + '</code>' +
            '</label>' +
            (constraints ? '<textarea class="form-input perm-constraints" data-fn="' + escapeHtml(fn.name) + '" style="margin-top:6px;font-size:12px;height:60px" placeholder="Arg constraints JSON">' + escapeHtml(constraints) + '</textarea>' : '') +
          '</div>';
        }).join('');

        html += '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="btn btn-primary btn-sm" onclick="savePermissionDetail(\\\'' + escapeHtml(userId) + '\\\')">Save</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\\\'permissionsModal\\\').classList.add(\\\'hidden\\\')">Cancel</button>' +
        '</div>';

        detail.innerHTML = html;
      } catch {
        detail.innerHTML = renderShellState('error', 'Permission details unavailable', 'We could not load this user\\'s access settings.', { compact: true });
      }
    }

    window.savePermissionDetail = async function(userId) {
      const checkboxes = document.querySelectorAll('.perm-fn-cb');
      const perms = [];
      checkboxes.forEach(function(cb) {
        const fn = cb.dataset.fn;
        const allowed = cb.checked;
        const constraintsEl = document.querySelector('.perm-constraints[data-fn="' + fn + '"]');
        let constraints = null;
        if (constraintsEl && constraintsEl.value.trim()) {
          try { constraints = JSON.parse(constraintsEl.value); } catch { showToast('Invalid JSON for ' + fn, 'error'); return; }
        }
        const perm = { function_name: fn, allowed: allowed };
        if (constraints) perm.constraints = constraints;
        perms.push(perm);
      });

      try {
        const res = await fetch('/api/user/permissions/' + currentAppId, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, permissions: perms }),
        });
        if (res.ok) {
          showToast('Permissions saved!');
          document.getElementById('permissionsModal').classList.add('hidden');
          loadPermissions(currentAppId);
        } else showToast('Failed to save permissions', 'error');
      } catch { showToast('Failed to save', 'error'); }
    };

    // ===== 17. Database (Supabase) =====
    let supabaseOAuthConnected = null; // null = unchecked, true/false

    async function loadDatabase(appId) {
      const container = document.getElementById('databaseContent');
      if (!container) return;

      try {
        // Load saved servers if not cached
        if (!savedSupabaseServers) {
          const srvRes = await fetch('/api/user/supabase', {
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
          if (srvRes.ok) savedSupabaseServers = await srvRes.json();
        }

        // Check OAuth status if not already checked
        if (supabaseOAuthConnected === null) {
          try {
            const oauthRes = await fetch('/api/user/supabase/oauth/status', {
              headers: { 'Authorization': 'Bearer ' + authToken },
            });
            if (oauthRes.ok) {
              const oauthData = await oauthRes.json();
              supabaseOAuthConnected = oauthData.connected;
            } else {
              supabaseOAuthConnected = false;
            }
          } catch { supabaseOAuthConnected = false; }
        }

        // Load current app config
        let currentConfig = null;
        try {
          const cfgRes = await fetch('/api/apps/' + appId + '/supabase', {
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
          if (cfgRes.ok) currentConfig = await cfgRes.json();
        } catch {}

        const servers = (savedSupabaseServers && savedSupabaseServers.configs) ? savedSupabaseServers.configs : (savedSupabaseServers || []);
        let html = '';

        // --- OAuth "Connect Supabase" section ---
        if (supabaseOAuthConnected) {
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:var(--success);"></div>' +
            '<span style="font-size:13px;color:var(--text-muted);">Supabase account connected</span>' +
            '<button class="btn btn-sm" style="margin-left:auto;font-size:11px;padding:2px 8px;color:var(--text-muted);border-color:var(--border);" onclick="disconnectSupabase()">Disconnect</button>' +
          '</div>';

          // Project picker
          html += '<div class="form-group"><label class="form-label">Supabase Project</label>' +
            '<div style="display:flex;gap:8px;align-items:center;">' +
              '<select id="oauthProjectSelect" class="form-input" style="flex:1;"></select>' +
              '<button class="btn btn-primary btn-sm" onclick="wireSupabaseProject()" id="wireProjectBtn">Wire to App</button>' +
            '</div>' +
            '<div id="oauthProjectStatus" style="font-size:12px;color:var(--text-muted);margin-top:6px;"></div>' +
          '</div>';
        } else {
          html += '<div style="margin-bottom:20px;">' +
            '<button class="btn btn-primary" onclick="connectSupabaseOAuth()" style="display:flex;align-items:center;gap:8px;">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>' +
              'Connect Supabase Account' +
            '</button>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:8px 0 0;">Authorize Ultralight to auto-wire your Supabase projects. No more copy-pasting keys.</p>' +
          '</div>';
        }

        // --- Manual server dropdown (always available as fallback) ---
        html += '<div style="border-top:1px solid var(--border);padding-top:16px;margin-top:8px;">' +
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:10px;">' +
            (supabaseOAuthConnected ? 'Or use saved server' : 'Manual Configuration') +
          '</div>' +
          '<div class="form-group"><label class="form-label">Supabase Server</label>' +
          '<select id="dbServerSelect" class="form-input" onchange="onDbServerChange()">' +
            '<option value="">None</option>' +
            servers.map(function(s) {
              const selected = currentConfig && currentConfig.config_id === s.id ? ' selected' : '';
              return '<option value="' + s.id + '"' + selected + '>' + escapeHtml(s.supabase_url || s.url || s.name || s.id) + '</option>';
            }).join('') +
          '</select></div>' +
          '<button class="btn btn-sm" style="border-color:var(--border);color:var(--text-secondary);" onclick="saveDbConfig()">Save Database Config</button>' +
        '</div>';

        container.innerHTML = html;
        appSupabaseChanged = false;

        // If OAuth connected, load projects into the dropdown
        if (supabaseOAuthConnected) {
          loadOAuthProjects(currentConfig);
        }
      } catch {
        container.innerHTML = renderSectionState('Database', 'error', 'Database settings unavailable', 'We could not load the current database configuration.');
      }
    }

    async function loadOAuthProjects(currentConfig) {
      const select = document.getElementById('oauthProjectSelect');
      const status = document.getElementById('oauthProjectStatus');
      if (!select) return;

      select.innerHTML = '<option value="">Loading projects...</option>';
      select.disabled = true;

      try {
        const res = await fetch('/api/user/supabase/oauth/projects', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });

        if (!res.ok) {
          if (res.status === 401) {
            // Token revoked or expired beyond refresh
            supabaseOAuthConnected = false;
            loadDatabase(currentAppId);
            return;
          }
          throw new Error('Failed to load projects');
        }

        const data = await res.json();
        const projects = data.projects || [];

        if (projects.length === 0) {
          select.innerHTML = '<option value="">No projects found</option>';
          select.disabled = true;
          return;
        }

        // Check if current config matches an OAuth project
        let matchedRef = '';
        if (currentConfig && currentConfig.url) {
          var urlStr = currentConfig.url || '';
          if (urlStr.indexOf('.supabase.co') > -1) {
            matchedRef = urlStr.replace('https://', '').split('.')[0];
          }
        }

        select.innerHTML = '<option value="">Select a project...</option>' +
          projects.map(function(p) {
            const selected = p.ref === matchedRef ? ' selected' : '';
            return '<option value="' + p.ref + '"' + selected + '>' +
              escapeHtml(p.name) + ' (' + p.region + ')' +
            '</option>';
          }).join('');
        select.disabled = false;

        if (matchedRef && currentConfig && currentConfig.enabled) {
          if (status) status.innerHTML = '<span style="color:var(--success);">&#10003; Wired to ' + escapeHtml(currentConfig.url || '') + '</span>';
        }
      } catch {
        select.innerHTML = '<option value="">Failed to load projects</option>';
        if (status) status.textContent = 'Could not fetch projects from Supabase.';
      }
    }

    window.connectSupabaseOAuth = async function() {
      try {
        const res = await fetch('/api/user/supabase/oauth/authorize', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          showToast('Failed to start Supabase connection', 'error');
          return;
        }
        const data = await res.json();
        if (!data.url) {
          showToast('Supabase OAuth not configured on this server', 'error');
          return;
        }

        // Open popup
        var popup = window.open(data.url, 'supabase-oauth', 'width=600,height=700,scrollbars=yes');

        // Listen for success message from popup
        function onMessage(event) {
          if (event.data && event.data.type === 'supabase-oauth-success') {
            window.removeEventListener('message', onMessage);
            supabaseOAuthConnected = true;
            savedSupabaseServers = null; // invalidate cache
            showToast('Supabase account connected!');
            loadDatabase(currentAppId);
          }
        }
        window.addEventListener('message', onMessage);

        // Fallback: poll for popup close
        var pollTimer = setInterval(function() {
          if (popup && popup.closed) {
            clearInterval(pollTimer);
            // Re-check status in case message was missed
            setTimeout(function() {
              supabaseOAuthConnected = null;
              loadDatabase(currentAppId);
            }, 500);
          }
        }, 1000);
      } catch {
        showToast('Failed to connect Supabase', 'error');
      }
    };

    window.wireSupabaseProject = async function() {
      const select = document.getElementById('oauthProjectSelect');
      const projectRef = select ? select.value : '';
      if (!projectRef) {
        showToast('Please select a project first', 'error');
        return;
      }

      const btn = document.getElementById('wireProjectBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Wiring...'; }

      try {
        const res = await fetch('/api/user/supabase/oauth/connect', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_ref: projectRef, app_id: currentAppId }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(function() { return {}; });
          showToast(errData.error || 'Failed to wire project', 'error');
          return;
        }

        const data = await res.json();
        showToast('Supabase project wired!');
        savedSupabaseServers = null; // invalidate cache
        loadDatabase(currentAppId);
      } catch {
        showToast('Failed to wire project', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Wire to App'; }
      }
    };

    window.disconnectSupabase = async function() {
      if (!confirm('Disconnect your Supabase account? Already-wired apps will keep working.')) return;
      try {
        const res = await fetch('/api/user/supabase/oauth/disconnect', {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          supabaseOAuthConnected = false;
          showToast('Supabase account disconnected');
          loadDatabase(currentAppId);
        } else {
          showToast('Failed to disconnect', 'error');
        }
      } catch { showToast('Failed to disconnect', 'error'); }
    };

    window.onDbServerChange = function() { appSupabaseChanged = true; };

    window.saveDbConfig = async function() {
      const serverId = document.getElementById('dbServerSelect')?.value || '';
      try {
        const res = await fetch('/api/apps/' + currentAppId + '/supabase', {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ config_id: serverId || null }),
        });
        if (res.ok) showToast('Database config saved!');
        else showToast('Failed to save', 'error');
      } catch { showToast('Failed to save', 'error'); }
    };

    // ===== 18. Environment Variables =====
    async function loadEnvVars(appId) {
      const container = document.getElementById('envVarsContent');
      if (!container) return;
      currentEnvVars = {};
      pendingEnvVarChanges = {};

      try {
        const res = await fetch('/api/apps/' + appId + '/env', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          const data = await res.json();
          // API returns { env_vars: [{key, masked, length}], count, limits }
          if (data && Array.isArray(data.env_vars)) {
            data.env_vars.forEach(function(item) { currentEnvVars[item.key] = item.masked || '••••••••'; });
          } else if (Array.isArray(data)) {
            data.forEach(function(item) { currentEnvVars[item.key] = item.value || item.masked || '••••••••'; });
          }
        }
      } catch {}

      renderEnvVars(document.getElementById('envVarsContent'));
    }

    function renderEnvVars(container) {
      const keys = Object.keys(currentEnvVars);
      let html = '';

      keys.forEach(function(key) {
        html += '<div class="env-var-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
          '<input type="text" class="form-input form-input-sm" value="' + escapeHtml(key) + '" readonly style="width:140px;font-family:var(--font-mono);font-size:12px">' +
          '<input type="password" class="form-input form-input-sm env-value" data-key="' + escapeHtml(key) + '" value="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" style="flex:1;font-family:var(--font-mono);font-size:12px">' +
          '<button class="btn btn-ghost btn-sm" onclick="this.previousElementSibling.type = this.previousElementSibling.type === \\\'password\\\' ? \\\'text\\\' : \\\'password\\\'">&#128065;</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteEnvVar(\\\'' + escapeHtml(key) + '\\\')">&#215;</button>' +
        '</div>';
      });

      html += '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<input type="text" id="newEnvKey" class="form-input form-input-sm" placeholder="KEY_NAME" style="width:140px;font-family:var(--font-mono);font-size:12px">' +
        '<input type="text" id="newEnvValue" class="form-input form-input-sm" placeholder="value" style="flex:1;font-family:var(--font-mono);font-size:12px">' +
        '<button class="btn btn-primary btn-sm" onclick="addEnvVar()">Add</button>' +
      '</div>' +
      '<button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="saveEnvVars()">Save Environment Variables</button>';

      container.innerHTML = html;
    }

    window.addEnvVar = function() {
      const key = document.getElementById('newEnvKey')?.value?.trim().toUpperCase();
      const value = document.getElementById('newEnvValue')?.value || '';
      if (!key) { showToast('Key is required', 'error'); return; }
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) { showToast('Key must be uppercase A-Z, 0-9, underscore', 'error'); return; }
      if (key.startsWith('ULTRALIGHT')) { showToast('ULTRALIGHT prefix is reserved', 'error'); return; }
      currentEnvVars[key] = value;
      pendingEnvVarChanges[key] = value;
      renderEnvVars(document.getElementById('envVarsContent'));
    };

    window.deleteEnvVar = function(key) {
      delete currentEnvVars[key];
      pendingEnvVarChanges[key] = null; // null = delete
      renderEnvVars(document.getElementById('envVarsContent'));
    };

    window.saveEnvVars = async function() {
      if (!currentAppId) return;
      try {
        // Collect all env var values (including modified password fields)
        const envData = {};
        document.querySelectorAll('.env-value').forEach(function(input) {
          const key = input.dataset.key;
          if (input.value && input.value !== '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') {
            envData[key] = input.value;
          }
        });
        // Add pending changes
        Object.keys(pendingEnvVarChanges).forEach(function(key) {
          if (pendingEnvVarChanges[key] === null) {
            // Delete
            delete envData[key];
          } else {
            envData[key] = pendingEnvVarChanges[key];
          }
        });

        // Handle deletions
        const deleteKeys = Object.keys(pendingEnvVarChanges).filter(function(k) { return pendingEnvVarChanges[k] === null; });
        for (const key of deleteKeys) {
          await fetch('/api/apps/' + currentAppId + '/env/' + key, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
        }

        // Patch remaining
        const updateData = {};
        Object.keys(envData).forEach(function(k) { updateData[k] = envData[k]; });
        if (Object.keys(updateData).length > 0) {
          await fetch('/api/apps/' + currentAppId + '/env', {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData),
          });
        }

        showToast('Environment variables saved!');
        pendingEnvVarChanges = {};
        loadEnvVars(currentAppId);
      } catch { showToast('Failed to save environment variables', 'error'); }
    };

    // ===== 19. Skills / Documentation =====
    async function loadSkills(appId) {
      const container = document.getElementById('skillsContent');
      if (!container) return;
      try {
        const res = await fetch('/api/apps/' + appId + '/skills.md', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          const text = await res.text();
          container.innerHTML = '<div class="section-card"><h3 class="section-title">Skills / Documentation</h3>' +
            '<pre style="font-size:12px;font-family:var(--font-mono);white-space:pre-wrap;color:var(--text-secondary);max-height:200px;overflow:auto;padding:12px;background:var(--bg-base);border-radius:8px;border:1px solid var(--border)">' + escapeHtml(text).slice(0, 2000) + '</pre>' +
            '<div style="display:flex;gap:8px;margin-top:12px">' +
              '<button class="btn btn-secondary btn-sm" onclick="openSkillsEditor()">Edit Skills.md</button>' +
              '<button class="btn btn-ghost btn-sm" onclick="generateDocs()">Generate Docs</button>' +
            '</div></div>';
        } else {
          container.innerHTML = renderSectionState('Skills / Documentation', 'empty', 'No documentation published yet', 'Generate docs after you ship your manifest and function descriptions.', {
            actionLabel: 'Generate Documentation',
            actionOnclick: 'generateDocs()',
          });
        }
      } catch {
        container.innerHTML = renderSectionState('Skills / Documentation', 'error', 'Documentation unavailable', 'We could not load the latest docs for this app.');
      }
    }

    window.openSkillsEditor = async function() {
      const modal = document.getElementById('skillsModal');
      modal.classList.remove('hidden');
      const editor = document.getElementById('skillsEditor');
      if (editor) {
        try {
          const res = await fetch('/api/apps/' + currentAppId + '/skills.md', {
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
          if (res.ok) editor.value = await res.text();
        } catch {}
      }
    };

    window.saveSkills = async function() {
      const editor = document.getElementById('skillsEditor');
      if (!editor || !currentAppId) return;
      try {
        const res = await fetch('/api/apps/' + currentAppId + '/skills', {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: editor.value }),
        });
        if (res.ok) {
          showToast('Skills.md saved!');
          document.getElementById('skillsModal').classList.add('hidden');
          loadSkills(currentAppId);
        } else showToast('Failed to save skills', 'error');
      } catch { showToast('Failed to save', 'error'); }
    };

    window.generateDocs = async function() {
      if (!currentAppId) return;
      showToast('Generating documentation...');
      try {
        const res = await fetch('/api/apps/' + currentAppId + '/generate-docs', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) {
          showToast('Documentation generated!');
          loadSkills(currentAppId);
        } else showToast('Failed to generate docs', 'error');
      } catch { showToast('Generation failed', 'error'); }
    };

    // ===== App Logs Tab =====
    // (Old loadAppLogs and loadAppBusiness removed — replaced by loadAppLogsSection and loadAppPayments)

    window.togglePricingOverride = function(cb) {
      var row = cb.closest('.pricing-fn-row') || cb.parentElement?.parentElement;
      if (!row) return;
      var priceInput = row.querySelector('.pricing-fn-price') || document.querySelector('.pricing-fn-price[data-fn="' + cb.dataset.fn + '"]');
      var freeInput = row.querySelector('.pricing-fn-free') || document.querySelector('.pricing-fn-free[data-fn="' + cb.dataset.fn + '"]');
      if (priceInput) { priceInput.disabled = !cb.checked; priceInput.style.opacity = cb.checked ? '1' : '0.4'; }
      if (freeInput) { freeInput.disabled = !cb.checked; freeInput.style.opacity = cb.checked ? '1' : '0.4'; }
    };

    window.updateFreeCallsScope = function() {
      var scope = document.querySelector('input[name="freeCallsScope"]:checked')?.value || 'function';
      var freeInputs = document.querySelectorAll('.pricing-fn-free');
      freeInputs.forEach(function(inp) {
        var cb = document.querySelector('.pricing-override-cb[data-fn="' + inp.dataset.fn + '"]');
        if (scope === 'app') {
          inp.disabled = true;
          inp.style.opacity = '0.4';
          inp.title = 'Free calls are shared across entire app when scope is "Entire app"';
        } else {
          inp.disabled = !(cb && cb.checked);
          inp.style.opacity = (cb && cb.checked) ? '1' : '0.4';
          inp.title = '';
        }
      });
    };

    window.savePricing = async function() {
      if (!currentAppId) return;
      var defaultLight = parseFloat(document.getElementById('pricingDefault')?.value || '0');
      var defaultFreeCalls = parseInt(document.getElementById('pricingFreeCalls')?.value || '0', 10);
      var scope = document.querySelector('input[name="freeCallsScope"]:checked')?.value || 'function';

      var pricingConfig = {
        default_price_light: defaultLight
      };
      if (defaultFreeCalls > 0) pricingConfig.default_free_calls = defaultFreeCalls;
      if (scope !== 'function') pricingConfig.free_calls_scope = scope;

      // Collect per-function overrides
      var fnFunctions = {};
      var hasOverrides = false;
      var checkboxes = document.querySelectorAll('.pricing-override-cb');
      checkboxes.forEach(function(cb) {
        if (!cb.checked) return;
        var fnName = cb.dataset.fn;
        var priceInput = document.querySelector('.pricing-fn-price[data-fn="' + fnName + '"]');
        var freeInput = document.querySelector('.pricing-fn-free[data-fn="' + fnName + '"]');
        var price = parseFloat(priceInput?.value || '0');
        var freeCalls = parseInt(freeInput?.value || '0', 10);

        // Use object format if free_calls differs from default, otherwise plain number for compat
        if (freeCalls > 0 && freeCalls !== defaultFreeCalls) {
          fnFunctions[fnName] = { price_light: price, free_calls: freeCalls };
        } else {
          fnFunctions[fnName] = price;
        }
        hasOverrides = true;
      });
      if (hasOverrides) pricingConfig.functions = fnFunctions;

      try {
        var res = await fetch('/api/apps/' + currentAppId, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pricing_config: pricingConfig }),
        });
        if (res.ok) showToast('Pricing saved!');
        else showToast('Failed to save pricing', 'error');
      } catch { showToast('Failed to save', 'error'); }
    };

    async function loadAppRevenue(appId) {
      const container = document.getElementById('revenueSection');
      if (!container) return;
      try {
        const res = await fetch('/api/apps/' + appId + '/earnings?period=30d', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          container.innerHTML = renderSectionState('Revenue', 'empty', 'No revenue data yet', 'Revenue appears here after paid usage starts flowing through this app.');
          return;
        }
        const data = await res.json();

        let html = '<h3 class="section-title">Revenue</h3>';
        html += '<div style="display:flex;gap:24px;margin-bottom:16px">' +
          '<div><div style="font-size:12px;color:var(--text-muted)">Lifetime</div><div style="font-size:20px;font-weight:600">' + formatLight((data.total_earned_light || 0)) + '</div></div>' +
          '<div><div style="font-size:12px;color:var(--text-muted)">Last 30 days</div><div style="font-size:20px;font-weight:600">' + formatLight((data.period_earned_light || 0)) + '</div></div>' +
          '<div><div style="font-size:12px;color:var(--text-muted)">Calls</div><div style="font-size:20px;font-weight:600">' + (data.period_transfers || 0) + '</div></div>' +
        '</div>';

        if (data.by_function && data.by_function.length > 0) {
          html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">By function</div>';
          html += data.by_function.slice(0, 8).map(function(f) {
            return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid var(--border)">' +
              '<code>' + escapeHtml(f.function_name) + '</code>' +
              '<span style="color:var(--text-muted)">' + f.call_count + ' calls · ' + formatLight((f.earned_light || 0)) + '</span>' +
            '</div>';
          }).join('');
        }

        container.innerHTML = html;
      } catch {
        container.innerHTML = renderSectionState('Revenue', 'error', 'Revenue unavailable', 'We could not load the latest revenue summary.');
      }
    }

    // ===== Account Settings =====
    async function loadAccountData() {
      loadApiKey();
      loadHostingData();
      populateProfileSettings();
      loadByokConfig();
    }

    // --- API Key (single key) ---
    var currentApiKey = null;

    function renderApiKeyDisplay() {
      var valEl = document.getElementById('apiKeyValue');
      var createdEl = document.getElementById('apiKeyCreated');
      var lastUsedEl = document.getElementById('apiKeyLastUsed');
      if (!valEl) return;

      if (!currentApiKey) {
        valEl.textContent = 'No key';
        if (createdEl) createdEl.textContent = '\\u2014';
        if (lastUsedEl) lastUsedEl.textContent = 'never';
        return;
      }

      valEl.textContent = currentApiKey.plaintext_token || (currentApiKey.token_prefix + '\\u2022'.repeat(27));
      if (createdEl) createdEl.textContent = new Date(currentApiKey.created_at).toLocaleDateString();
      if (lastUsedEl) lastUsedEl.textContent = currentApiKey.last_used_at ? relTime(currentApiKey.last_used_at) : 'never';
    }

    async function loadApiKey() {
      var valEl = document.getElementById('apiKeyValue');
      if (!valEl) return;
      valEl.textContent = 'Loading API key...';
      var authHeaders = { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' };

      try {
        var res = await fetch('/api/user/tokens', { headers: authHeaders });
        if (!res.ok) { valEl.textContent = 'Failed to load'; return; }
        var tokenData = await res.json();
        var tokens = tokenData.tokens || tokenData;

        if (tokens.length > 0) {
          currentApiKey = tokens.find(function(t) { return t.name === 'default'; }) || tokens[0];

          // Token row without stored plaintext — regenerate against the canonical schema
          if (currentApiKey && !currentApiKey.plaintext_token) {
            await fetch('/api/user/tokens/' + currentApiKey.id, { method: 'DELETE', headers: authHeaders });
            var regenRes = await fetch('/api/user/tokens', {
              method: 'POST', headers: authHeaders,
              body: JSON.stringify({ name: 'default' }),
            });
            if (regenRes.ok) {
              var regenData = await regenRes.json();
              currentApiKey = regenData.token;
              if (currentApiKey) currentApiKey.plaintext_token = regenData.plaintext_token;
            }
          }
          renderApiKeyDisplay();
          return;
        }

        // No tokens — auto-create one
        var createRes = await fetch('/api/user/tokens', {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ name: 'default' }),
        });
        if (!createRes.ok) { valEl.textContent = 'Failed to create key'; return; }
        var createData = await createRes.json();
        currentApiKey = createData.token;
        if (currentApiKey) currentApiKey.plaintext_token = createData.plaintext_token;
        renderApiKeyDisplay();
      } catch { if (valEl) valEl.textContent = 'Failed to load'; }
    }

    window.copyApiKey = async function() {
      var key = currentApiKey && currentApiKey.plaintext_token;
      if (!key) { showToast('Key not available', 'error'); return; }
      try {
        await navigator.clipboard.writeText(key);
        showToast('API key copied to clipboard!');
      } catch {
        prompt('Copy your API key:', key);
      }
    };

    window.regenerateApiKey = async function() {
      if (!confirm('Regenerate your API key? The current key will stop working immediately. Connected agents will need to re-authenticate.')) return;

      var regenBtn = document.getElementById('apiKeyRegenBtn');
      if (regenBtn) { regenBtn.disabled = true; regenBtn.textContent = 'Regenerating...'; }

      try {
        // Revoke current key
        if (currentApiKey && currentApiKey.id) {
          await fetch('/api/user/tokens/' + currentApiKey.id, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
        }

        // Create new key
        var res = await fetch('/api/user/tokens', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'default' }),
        });

        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          showToast(errData.error || 'Failed to regenerate key', 'error');
          return;
        }

        var data = await res.json();
        currentApiKey = data.token;
        if (currentApiKey) currentApiKey.plaintext_token = data.plaintext_token;
        renderApiKeyDisplay();

        // Invalidate cached setup instructions (they contain the old key)
        localStorage.removeItem('ultralight_setup_v4');
        setupCommandStr = '';
        showToast('New API key generated!');
      } catch { showToast('Failed to regenerate key', 'error'); }
      finally {
        if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate Key'; }
      }
    };

    // --- BYOK (Bring Your Own Key) ---
    var byokConfig = null;
    var pendingByokProvider = null;

    function byokHeaders() {
      return { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' };
    }

    function byokProviderById(providerId) {
      var providers = (byokConfig && byokConfig.available_providers) || [];
      return providers.find(function(p) { return p.id === providerId; }) || null;
    }

    function byokConfigByProvider(providerId) {
      var configs = (byokConfig && byokConfig.configs) || [];
      return configs.find(function(c) { return c.provider === providerId; }) || null;
    }

    function byokDisplayModel(modelId) {
      if (!modelId) return '';
      var name = String(modelId).split('/').pop() || String(modelId);
      return name.replace(/:nitro$/, '');
    }

    function byokMaskedKey(provider) {
      var prefix = provider && provider.apiKeyPrefix ? provider.apiKeyPrefix : 'sk-';
      return prefix + '\\u2022'.repeat(12);
    }

    function byokSelectedModel(providerId) {
      var select = document.getElementById('byokModel_' + providerId);
      if (select && select.value) return select.value;
      var provider = byokProviderById(providerId);
      return provider ? provider.defaultModel : undefined;
    }

    async function loadByokLightTransactionsPreview() {
      var el = document.getElementById('byokLightTransactionsPreview');
      if (!el) return;
      try {
        var res = await fetch('/api/user/transactions?limit=12&offset=0', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">Transaction preview unavailable.</div>';
          return;
        }
        var data = await res.json();
        var txs = (data.transactions || []).filter(function(tx) { return tx.category === 'chat_inference'; }).slice(0, 3);
        if (txs.length === 0) {
          el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">Inference charges will appear here after Light-debit calls.</div>';
          return;
        }
        var html = '<div style="display:flex;flex-direction:column;gap:6px;">';
        txs.forEach(function(tx) {
          var when = tx.created_at ? relTime(tx.created_at) : '';
          html += '<div style="display:flex;justify-content:space-between;gap:var(--space-3);font-size:11px;">'
            + '<span style="min-width:0;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(tx.description || 'Chat inference') + '</span>'
            + '<span style="color:var(--text-muted);white-space:nowrap;">' + (when ? escapeHtml(when) + ' · ' : '') + formatLight(Math.abs(tx.amount_light || 0)) + '</span>'
            + '</div>';
        });
        html += '</div>';
        el.innerHTML = html;
      } catch {
        el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">Transaction preview unavailable.</div>';
      }
    }

    function closeByokKeyModal() {
      var modal = document.getElementById('byokKeyModal');
      var keyInput = document.getElementById('byokKeyInput');
      var saveBtn = document.getElementById('byokKeySaveBtn');
      pendingByokProvider = null;
      if (keyInput) keyInput.value = '';
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Key'; }
      if (modal) modal.classList.add('hidden');
    }
    window.closeByokKeyModal = closeByokKeyModal;

    function openByokKeyModal(providerId) {
      var provider = byokProviderById(providerId);
      if (!provider) return;
      pendingByokProvider = providerId;
      var cfg = byokConfigByProvider(providerId);
      var title = document.getElementById('byokKeyModalTitle');
      var meta = document.getElementById('byokKeyModalProviderMeta');
      var modelMeta = document.getElementById('byokKeyModalModelMeta');
      var keyInput = document.getElementById('byokKeyInput');
      var modal = document.getElementById('byokKeyModal');
      var model = byokSelectedModel(providerId);

      if (title) title.textContent = (cfg ? 'Replace ' : 'Add ') + provider.name + ' Key';
      if (meta) {
        meta.innerHTML = escapeHtml(provider.description || '') +
          '<div style="font-family:var(--font-mono);margin-top:4px;">' + escapeHtml(provider.baseUrl || '') + '</div>';
      }
      if (modelMeta) {
        modelMeta.textContent = 'Default model: ' + (model || provider.defaultModel || 'provider default') + '. BYOK calls skip Light debits.';
      }
      if (modal) modal.classList.remove('hidden');
      if (keyInput) {
        keyInput.placeholder = provider.apiKeyPrefix ? provider.apiKeyPrefix + '...' : 'Paste provider API key';
        setTimeout(function() { keyInput.focus(); }, 0);
      }
    }

    async function submitByokKeyModal() {
      if (!pendingByokProvider) return;
      var provider = byokProviderById(pendingByokProvider);
      var providerName = provider ? provider.name : pendingByokProvider;
      var keyInput = document.getElementById('byokKeyInput');
      var saveBtn = document.getElementById('byokKeySaveBtn');
      var key = keyInput && keyInput.value ? keyInput.value.trim() : '';
      if (!key) { showToast('API key is required', 'error'); return; }
      var model = byokSelectedModel(pendingByokProvider);

      try {
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
        var res = await fetch('/api/user/byok', {
          method: 'POST',
          headers: byokHeaders(),
          body: JSON.stringify({ provider: pendingByokProvider, api_key: key, model: model, validate: true }),
        });
        if (!res.ok) {
          var err = await res.json().catch(function() { return {}; });
          showToast(err.error || 'Failed to save key', 'error');
          return;
        }
        closeByokKeyModal();
        showToast(providerName + ' key saved');
        await loadByokConfig();
      } catch {
        showToast('Failed to save key', 'error');
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Key'; }
      }
    }
    window.submitByokKeyModal = submitByokKeyModal;

    var byokKeyInputEl = document.getElementById('byokKeyInput');
    if (byokKeyInputEl) {
      byokKeyInputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') submitByokKeyModal();
        if (e.key === 'Escape') closeByokKeyModal();
      });
    }

    async function loadByokConfig() {
      var container = document.getElementById('byokProviderList');
      if (!container) return;
      container.innerHTML = renderShellState('loading', 'Loading AI keys', 'Checking configured BYOK providers.', { compact: true });
      try {
        var res = await fetch('/api/user/byok', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          container.innerHTML = renderShellState('error', 'AI keys unavailable', 'We could not load provider settings right now.', { compact: true });
          return;
        }
        byokConfig = await res.json();
        renderByokProviders();
      } catch {
        container.innerHTML = renderShellState('error', 'AI keys unavailable', 'We could not load provider settings right now.', { compact: true });
      }
    }

    function renderByokModelSelect(provider, cfg) {
      var selectedModel = (cfg && cfg.model) || provider.defaultModel || '';
      var models = provider.models || [];
      if (models.length === 0) {
        return '<input id="byokModel_' + escapeHtml(provider.id) + '" type="text" value="' + escapeHtml(selectedModel) + '" placeholder="Default model" style="width:100%;padding:6px 8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);font-size:12px;font-family:var(--font-mono);" ' + (cfg ? 'onchange="updateByokModel(\\\'' + provider.id + '\\\', this.value)"' : '') + '>';
      }

      var hasSelected = models.some(function(m) { return m.id === selectedModel; });
      var html = '<select id="byokModel_' + escapeHtml(provider.id) + '" style="width:100%;padding:6px 8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);font-size:12px;font-family:var(--font-mono);" ' + (cfg ? 'onchange="updateByokModel(\\\'' + provider.id + '\\\', this.value)"' : '') + '>';
      if (selectedModel && !hasSelected) {
        html += '<option value="' + escapeHtml(selectedModel) + '" selected>' + escapeHtml(byokDisplayModel(selectedModel)) + '</option>';
      }
      models.forEach(function(model) {
        var label = model.name || byokDisplayModel(model.id);
        var selected = model.id === selectedModel ? ' selected' : '';
        html += '<option value="' + escapeHtml(model.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
      });
      html += '</select>';
      return html;
    }

    function renderByokProviders() {
      var container = document.getElementById('byokProviderList');
      if (!container || !byokConfig) return;

      var providers = byokConfig.available_providers || [];
      var configs = byokConfig.configs || [];
      var primaryProvider = byokConfig.primary_provider;

      if (providers.length === 0) {
        container.innerHTML = renderShellState('empty', 'No BYOK providers available', 'Provider settings are not configured on this server.', { compact: true });
        return;
      }

      var configuredCount = configs.length;
      var html = '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-3);margin-bottom:var(--space-2);">';
      html += '<div><div style="font-size:13px;font-weight:600;color:var(--text-primary);">Provider routing</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">' + configuredCount + ' configured · primary ' + escapeHtml(primaryProvider || 'Light balance') + '</div></div>';
      html += '<button class="btn btn-sm" style="border:1px solid var(--border);border-radius:0;" onclick="addByokKey()">Add API Key</button>';
      html += '</div>';

      if (configuredCount === 0) {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);background:var(--bg-subtle);border:1px solid var(--border);padding:var(--space-3);margin-bottom:var(--space-2);">';
        html += '<div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text-primary);">Using Light balance</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Until a BYOK provider is configured, platform inference runs through OpenRouter and appears in your Light transaction history.</div></div>';
        html += '<div style="display:flex;gap:var(--space-2);flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">';
        html += '<button class="btn btn-sm" style="font-size:11px;border:1px solid var(--border);border-radius:0;" onclick="openWalletTransactions()">Transaction history</button>';
        html += '<button class="btn btn-primary btn-sm" style="font-size:11px;border-radius:0;" onclick="openWalletBalance()">Add Light</button>';
        html += '</div></div>';
        html += '<div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-3);margin-bottom:var(--space-2);">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-2);">';
        html += '<div style="font-size:12px;font-weight:600;color:var(--text-primary);">Recent Light inference charges</div>';
        html += '<button class="btn btn-sm" style="font-size:11px;border:1px solid var(--border);border-radius:0;" onclick="openWalletTransactions()">View all</button>';
        html += '</div>';
        html += '<div id="byokLightTransactionsPreview" style="min-height:18px;font-size:11px;color:var(--text-muted);">Loading recent charges...</div>';
        html += '</div>';
      }

      providers.forEach(function(p) {
        var cfg = byokConfigByProvider(p.id);
        var isPrimary = primaryProvider === p.id;
        var hasKey = !!cfg;
        var configuredDate = cfg && cfg.added_at ? new Date(cfg.added_at).toLocaleDateString() : '';

        html += '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,260px) auto;gap:var(--space-3);align-items:center;padding:var(--space-3);background:var(--bg-raised);border:1px solid var(--border);">';
        html += '<div style="min-width:0;">';
        html += '<div style="display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;">';
        html += '<span style="font-size:13px;font-weight:600;color:var(--text-primary);">' + escapeHtml(p.name) + '</span>';
        if (isPrimary) html += '<span style="font-size:10px;background:var(--text-primary);color:var(--bg-base);padding:1px 6px;font-weight:500;">Primary</span>';
        html += '<span style="font-size:10px;border:1px solid var(--border);padding:1px 6px;color:' + (hasKey ? 'var(--success)' : 'var(--text-muted)') + ';">' + (hasKey ? 'Configured' : 'No key') + '</span>';
        html += '</div>';
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">' + escapeHtml(p.description || '') + '</div>';
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-family:var(--font-mono);">' + (hasKey ? byokMaskedKey(p) : escapeHtml(p.baseUrl || '')) + '</div>';
        if (configuredDate) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Added ' + escapeHtml(configuredDate) + '</div>';
        html += '</div>';

        html += '<div style="min-width:0;">';
        html += '<label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Default model</label>';
        html += renderByokModelSelect(p, cfg);
        html += '</div>';

        html += '<div style="display:flex;gap:var(--space-2);align-items:center;justify-content:flex-end;flex-wrap:wrap;">';
        if (p.apiKeyUrl) {
          html += '<a href="' + escapeHtml(p.apiKeyUrl) + '" target="_blank" class="btn btn-sm" style="font-size:11px;border:1px solid var(--border);border-radius:0;">Get key</a>';
        }
        if (hasKey) {
          if (!isPrimary) html += '<button class="btn btn-sm" style="font-size:11px;border:1px solid var(--border);border-radius:0;" onclick="setPrimaryByok(\\\'' + p.id + '\\\')">Set Primary</button>';
          html += '<button class="btn btn-sm" style="font-size:11px;border:1px solid var(--border);border-radius:0;" onclick="addByokKeyForProvider(\\\'' + p.id + '\\\')">Replace</button>';
          html += '<button class="btn btn-sm" style="font-size:11px;color:var(--error);border:1px solid var(--border);border-radius:0;" onclick="removeByokKey(\\\'' + p.id + '\\\')">Remove</button>';
        } else {
          html += '<button class="btn btn-primary btn-sm" style="font-size:11px;border-radius:0;" onclick="addByokKeyForProvider(\\\'' + p.id + '\\\')">Add Key</button>';
        }
        html += '</div>';
        html += '</div>';
      });

      container.innerHTML = html;
      if (configuredCount === 0) loadByokLightTransactionsPreview();
    }

    window.addByokKey = function() {
      if (!byokConfig) { loadByokConfig(); return; }
      var providers = byokConfig.available_providers || [];
      var preferred = ['deepseek', 'openrouter', 'nvidia', 'openai', 'google', 'xai'];
      var provider = null;
      for (var i = 0; i < preferred.length; i++) {
        var candidate = providers.find(function(p) {
          return p.id === preferred[i] && !byokConfigByProvider(p.id);
        });
        if (candidate) { provider = candidate; break; }
      }
      if (!provider) provider = providers.find(function(p) { return !byokConfigByProvider(p.id); }) || providers[0];
      if (provider) addByokKeyForProvider(provider.id);
    };

    window.addByokKeyForProvider = async function(provider) {
      openByokKeyModal(provider);
    };

    window.updateByokModel = async function(provider, model) {
      var cfg = byokConfigByProvider(provider);
      if (!cfg) return;
      var p = byokProviderById(provider);
      try {
        var res = await fetch('/api/user/byok/' + provider, {
          method: 'PATCH',
          headers: byokHeaders(),
          body: JSON.stringify({ model: model || undefined, validate: false }),
        });
        if (!res.ok) {
          var err = await res.json().catch(function() { return {}; });
          showToast(err.error || 'Failed to update model', 'error');
          await loadByokConfig();
          return;
        }
        showToast((p ? p.name : provider) + ' model updated');
        await loadByokConfig();
      } catch {
        showToast('Failed to update model', 'error');
        await loadByokConfig();
      }
    };

    window.removeByokKey = async function(provider) {
      var p = byokProviderById(provider);
      var providerName = p ? p.name : provider;
      if (!confirm('Remove your ' + providerName + ' API key?')) return;
      try {
        var res = await fetch('/api/user/byok/' + provider, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) { showToast('Failed to remove key', 'error'); return; }
        showToast(providerName + ' key removed');
        await loadByokConfig();
      } catch { showToast('Failed to remove key', 'error'); }
    };

    window.setPrimaryByok = async function(provider) {
      var p = byokProviderById(provider);
      try {
        var res = await fetch('/api/user/byok/primary', {
          method: 'POST',
          headers: byokHeaders(),
          body: JSON.stringify({ provider: provider }),
        });
        if (!res.ok) { showToast('Failed to set primary', 'error'); return; }
        showToast((p ? p.name : provider) + ' set as primary');
        await loadByokConfig();
      } catch { showToast('Failed to set primary', 'error'); }
    };

    // --- Transactions ---
    var txOffset = 0;
    var txLoaded = false;

    async function loadTransactions(reset) {
      if (reset) { txOffset = 0; txLoaded = false; }
      var listEl = document.getElementById('transactionsList');
      var summaryEl = document.getElementById('storageChargesSummary');
      if (!listEl) return;
      if (txOffset === 0) {
        listEl.innerHTML = renderShellState('loading', 'Loading transactions', 'Pulling deposits, credits, and storage charges.', { compact: true });
      }

      try {
        var res = await fetch('/api/user/transactions?limit=50&offset=' + txOffset, {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          listEl.innerHTML = renderShellState('error', 'Transactions unavailable', 'We could not load your transaction history right now.', { compact: true });
          return;
        }
        var data = await res.json();
        var txs = data.transactions || [];
        var rate = data.current_rate || {};

        // Separate storage charges from general transactions
        var storageTxs = [];
        var generalTxs = [];
        for (var i = 0; i < txs.length; i++) {
          if (txs[i].category === 'hosting' || txs[i].category === 'data_storage' || txs[i].category === 'storage_at_rest') {
            storageTxs.push(txs[i]);
          } else {
            generalTxs.push(txs[i]);
          }
        }

        // Render charge rate summary card with expandable storage history
        if (summaryEl && txOffset === 0) {
          var dailyLight = rate.estimated_daily_light || 0;
          var monthlyLight = rate.estimated_monthly_light || 0;
          var storageHtml = '';
          if (storageTxs.length > 0) {
            storageHtml = '<div id="storageChargesDetail" style="display:none;margin-top:var(--space-3);padding-top:var(--space-3);border-top:1px solid var(--border);">';
            for (var si = 0; si < storageTxs.length; si++) {
              var stx = storageTxs[si];
              var sDate = relTime(stx.created_at);
              var sFullDate = new Date(stx.created_at).toLocaleString();
              var sAmt = formatLight(Math.abs(stx.amount_light));
              var sMeta = stx.metadata || {};
              storageHtml += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;">'
                + '<div style="color:var(--text-secondary);">'
                + escapeHtml(stx.description)
                + '<span style="color:var(--text-muted);margin-left:6px;" title="' + escapeHtml(sFullDate) + '">' + escapeHtml(sDate) + '</span>'
                + '</div>'
                + '<div style="color:var(--text-primary);font-weight:500;white-space:nowrap;">' + sAmt + '</div>'
                + '</div>';
            }
            storageHtml += '</div>';
          }

          summaryEl.innerHTML = '<div style="background:var(--bg-raised);border:1px solid var(--border);padding:var(--space-4);margin-bottom:var(--space-4);cursor:pointer;" onclick="var d=document.getElementById(\\\'storageChargesDetail\\\');var a=document.getElementById(\\\'storageToggleArrow\\\');if(d){d.style.display=d.style.display===\\\'none\\\'?\\\'block\\\':\\\'none\\\';if(a)a.textContent=d.style.display===\\\'none\\\'?\\\'\\u25B6\\\':\\\'\\u25BC\\\';}">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;">'
            + '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">Current Storage Charges</div>'
            + '<span id="storageToggleArrow" style="font-size:10px;color:var(--text-muted);">\\u25B6</span>'
            + '</div>'
            + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-3);font-size:13px;margin-top:var(--space-3);">'
            + '<div><div style="color:var(--text-muted);font-size:11px;margin-bottom:2px;">Storage Rate</div><div style="font-weight:600;">' + formatLight((rate.storage_light_per_hour || 0)) + '</div></div>'
            + '<div><div style="color:var(--text-muted);font-size:11px;margin-bottom:2px;">Est. Daily</div><div style="font-weight:600;">' + formatLight(dailyLight) + '</div></div>'
            + '<div><div style="color:var(--text-muted);font-size:11px;margin-bottom:2px;">Est. Monthly</div><div style="font-weight:600;">' + formatLight(monthlyLight) + '</div></div>'
            + '</div>'
            + '<div style="font-size:11px;color:var(--text-muted);margin-top:var(--space-3);">'
            + (rate.storage_combined_mb || 0).toFixed(2) + ' MB used \\u00B7 ' + (rate.storage_free_mb || 100).toFixed(2) + ' MB free \\u00B7 ' + formatLightRate(rate.storage_rate_light_per_gb_month || 0) + '/GB-month'
            + ((rate.storage_overage_mb || 0) > 0 ? ' \\u00B7 ' + rate.storage_overage_mb.toFixed(2) + ' MB over free tier' : '')
            + '</div>'
            + storageHtml
            + '</div>';
        }

        // Render only general transactions (deposits, credits, etc.) in main list
        if (txOffset === 0) listEl.innerHTML = '';

        if (generalTxs.length === 0 && txOffset === 0) {
          listEl.innerHTML = renderShellState('empty', 'No transactions yet', 'Deposits, credits, and storage charges will appear here.', { compact: true });
          return;
        }

        var html = '';
        for (var ti = 0; ti < generalTxs.length; ti++) {
          var tx = generalTxs[ti];
          var isCredit = tx.amount_light > 0;
          var amtStr = (isCredit ? '+' : '') + formatLight(Math.abs(tx.amount_light));
          var amtColor = isCredit ? 'var(--success)' : 'var(--text-primary)';
          var dateStr = relTime(tx.created_at);
          var fullDate = new Date(tx.created_at).toLocaleString();
          var meta = tx.metadata || {};

          html += '<div style="display:flex;align-items:flex-start;justify-content:space-between;padding:var(--space-3) 0;border-bottom:1px solid var(--border);gap:var(--space-3);">'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="font-size:13px;color:var(--text-primary);">' + escapeHtml(tx.description) + '</div>'
            + '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;" title="' + escapeHtml(fullDate) + '">'
            + escapeHtml(dateStr)
            + (tx.app_name ? ' \\u00B7 ' + escapeHtml(tx.app_name) : '')
            + '</div>'
            + '</div>'
            + '<div style="font-size:13px;font-weight:600;color:' + amtColor + ';white-space:nowrap;">' + amtStr + '</div>'
            + '</div>';
        }
        listEl.innerHTML += html;

        txOffset += txs.length;
        // Add "Load more" button if there are more general transactions
        var totalGeneral = (data.total || 0) - storageTxs.length;
        if (generalTxs.length > 0 && txOffset < (data.total || 0)) {
          listEl.innerHTML += '<div style="text-align:center;padding:var(--space-3) 0;">'
            + '<button class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="loadTransactions()">Load more</button>'
            + '</div>';
        }
      } catch {
        if (listEl) {
          listEl.innerHTML = renderShellState('error', 'Transactions unavailable', 'We could not load your transaction history right now.', { compact: true });
        }
      }
    }
    window.loadTransactions = loadTransactions;

    // --- Billing ---
    async function loadHostingData() {
      const balanceEl = document.getElementById('accountBalance');
      const statusEl = document.getElementById('accountStatus');
      if (!balanceEl) return;

      try {
        const res = await fetch('/api/user/hosting', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) return;
        const data = await res.json();

        const light = data.balance_light || 0;
        balanceEl.textContent = formatLight(light);
        balanceEl.style.color = light <= 0 ? 'var(--error)' : 'var(--text-primary)';

        var breakdownEl = document.getElementById('walletBalanceBreakdown');
        if (breakdownEl) {
          var depositLight = data.deposit_balance_light || 0;
          var earnedLight = data.earned_balance_light || 0;
          var escrowLight = data.escrow_light || 0;
          var withdrawableLight = data.withdrawable_earnings_light || earnedLight;
          breakdownEl.innerHTML =
            '<div style="border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-3);min-width:0;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;">Purchased</div><div style="font-size:16px;font-weight:600;color:var(--text-primary);">' + formatLight(depositLight) + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Spend-only</div></div>' +
            '<div style="border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-3);min-width:0;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;">Creator Earnings</div><div style="font-size:16px;font-weight:600;color:var(--success);">' + formatLight(earnedLight) + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Convert or payout</div></div>' +
            '<div style="border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-3);min-width:0;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;">Payout Eligible</div><div style="font-size:16px;font-weight:600;color:var(--success);">' + formatLight(withdrawableLight) + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Earnings only</div></div>' +
            '<div style="border:1px solid var(--border);background:var(--bg-primary);padding:var(--space-3);min-width:0;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;">Escrowed</div><div style="font-size:16px;font-weight:600;color:var(--text-primary);">' + formatLight(escrowLight) + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Open bids</div></div>';
        }

        if (statusEl) {
          statusEl.textContent = light > 0 ? 'Active' : 'No Balance';
          statusEl.style.background = light > 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
          statusEl.style.color = light > 0 ? 'var(--success)' : 'var(--error)';
        }
      } catch {}
    }

    window.startDeposit = function() {
      showToast('Use Apple Pay / Google Pay or wire transfer in Wallet.');
    };

    // --- Earnings ---
    async function loadEarnings() {
      var el = document.getElementById('earningsSummary');
      if (!el) return;
      try {
        var res = await fetch('/api/user/earnings?period=30d', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          el.innerHTML = renderShellState('error', 'Earnings unavailable', 'We could not load your earnings summary right now.', { compact: true });
          return;
        }
        var data = await res.json();
        var total = formatLight(data.total_earned_light || 0);
        var period = formatLight(data.period_earned_light || 0);
        var withdrawn = formatLight(data.total_withdrawn_light || 0);
        var withdrawable = formatLight(data.withdrawable_light || 0);
        el.innerHTML =
          '<div style="display:flex;gap:var(--space-6);margin-bottom:var(--space-2);flex-wrap:wrap;">' +
            '<div><div style="font-size:11px;color:var(--text-muted);">Lifetime Earned</div><div style="font-size:18px;font-weight:600;">' + total + '</div></div>' +
            '<div><div style="font-size:11px;color:var(--text-muted);">Last 30 days</div><div style="font-size:18px;font-weight:600;">' + period + '</div></div>' +
            '<div><div style="font-size:11px;color:var(--text-muted);">Paid Out</div><div style="font-size:18px;font-weight:600;">' + withdrawn + '</div></div>' +
            '<div><div style="font-size:11px;color:var(--success);">Payout Eligible</div><div style="font-size:18px;font-weight:600;color:var(--success);">' + withdrawable + '</div></div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:var(--space-2);">Only creator earnings can be paid out. Purchased Light is spend-only platform credit.</div>';
      } catch {
        el.innerHTML = renderShellState('error', 'Earnings unavailable', 'We could not load your earnings summary right now.', { compact: true });
      }
    }

    // --- Connect Status ---
    // Stores connect status data for payout requests.
    var _connectData = null;
    function renderConnectSetup(message) {
      return '<p style="font-size:13px;color:var(--text-muted);margin-bottom:var(--space-3);">' + escapeHtml(message || 'Set up Stripe Connect to request payouts from creator earnings.') + '</p>' +
        '<div style="display:flex;gap:var(--space-2);align-items:end;flex-wrap:wrap;">' +
          '<div style="min-width:120px;">' +
            '<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">Country</label>' +
            '<input id="connectCountryInput" value="US" maxlength="2" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:13px;text-transform:uppercase;">' +
          '</div>' +
          '<button id="connectBankBtn" class="btn btn-sm" style="border-radius:0;border:1px solid var(--border);" onclick="startConnectOnboarding()">Set Up Payouts</button>' +
        '</div>';
    }

    function updateWithdrawPreview() {
      var preview = document.getElementById('withdrawPreview');
      var inputEl = document.getElementById('withdrawAmountLight');
      if (!preview || !inputEl) return;
      var lightAmount = parseInt(inputEl.value || '0', 10);
      var payoutRate = getPayoutLightPerUsd();
      var minLight = getMinWithdrawalLight();
      var withdrawable = _connectData && _connectData.withdrawable_earnings_light ? _connectData.withdrawable_earnings_light : 0;
      if (!lightAmount || isNaN(lightAmount)) {
        preview.textContent = 'Enter an amount to preview USD conversion and Stripe payout fees.';
        return;
      }
      var usdAmount = lightAmount / payoutRate;
      var stripeFee = Math.ceil(usdAmount * 100 * 0.0025 + 25) / 100;
      if (_connectData && _connectData.is_cross_border) stripeFee += Math.ceil(usdAmount * 100 * 0.02) / 100;
      var netUsd = Math.max(0, usdAmount - stripeFee);
      var warnings = [];
      if (lightAmount < minLight) warnings.push('minimum ' + formatLight(minLight));
      if (lightAmount > withdrawable) warnings.push('above payout-eligible earnings');
      preview.textContent = formatLight(lightAmount) + ' converts at ' + payoutRate.toLocaleString() + ' Light = $1 to $' + usdAmount.toFixed(2) + '. Estimated Stripe fees: $' + stripeFee.toFixed(2) + '. Estimated bank deposit: $' + netUsd.toFixed(2) + '. Monthly payout cutoff applies' + (warnings.length ? ' (' + warnings.join(', ') + ').' : '.');
    }
    window.updateWithdrawPreview = updateWithdrawPreview;

    function formatPayoutScheduleDate(value) {
      if (!value) return '';
      var normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00Z' : value;
      var date = new Date(normalized);
      if (isNaN(date.getTime())) return value;
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }

    async function loadConnectStatus() {
      var badge = document.getElementById('connectStatusBadge');
      var section = document.getElementById('connectSection');
      var withdrawBtn = document.getElementById('withdrawBtn');
      var payoutCard = document.getElementById('payoutRequestCard');
      try {
        var res = await fetch('/api/user/connect/status', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) return;
        var data = await res.json();
        _connectData = data;
        if (data.payouts_enabled) {
          var countryInfo = '';
          if (data.country && data.country !== 'US') {
            var currency = (data.default_currency || '').toUpperCase();
            countryInfo = '<div style="font-size:11px;color:var(--text-muted);margin-top:var(--space-2);">Payout country: ' + escapeHtml(data.country) + (currency ? ' (' + escapeHtml(currency) + ')' : '') + '. Payouts convert Light to USD at ' + getPayoutLightPerUsd().toLocaleString() + ' Light = $1, then to local currency at Stripe\\'s exchange rate (+ 2% FX fee).</div>';
          }
          if (badge) { badge.textContent = 'Connected'; badge.style.background = 'rgba(34,197,94,0.15)'; badge.style.color = 'var(--success)'; }
          if (section) section.innerHTML = '<p style="font-size:13px;color:var(--text-secondary);">Your payout account is connected. You can request payouts from creator earnings below.</p>' + countryInfo;
          if (withdrawBtn) withdrawBtn.style.display = '';
          if (payoutCard) payoutCard.style.display = 'block';
          updateWithdrawPreview();
        } else if (data.connected && data.onboarded) {
          if (badge) { badge.textContent = 'Pending'; badge.style.background = 'rgba(234,179,8,0.15)'; badge.style.color = '#ca8a04'; }
          if (section) section.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">Onboarding is complete. Stripe is reviewing your payout account.</p>';
          if (withdrawBtn) withdrawBtn.style.display = 'none';
          if (payoutCard) payoutCard.style.display = 'none';
        } else if (data.connected) {
          if (badge) { badge.textContent = 'Incomplete'; badge.style.background = 'rgba(234,179,8,0.15)'; badge.style.color = '#ca8a04'; }
          if (section) section.innerHTML = renderConnectSetup('Finish Stripe Connect onboarding to request payouts from creator earnings.');
          if (withdrawBtn) withdrawBtn.style.display = 'none';
          if (payoutCard) payoutCard.style.display = 'none';
        } else {
          if (section) section.innerHTML = renderConnectSetup();
          if (withdrawBtn) withdrawBtn.style.display = 'none';
          if (payoutCard) payoutCard.style.display = 'none';
        }
      } catch {}
    }

    // --- Connect Onboarding ---
    window.startConnectOnboarding = async function() {
      var countryInput = document.getElementById('connectCountryInput');
      var country = countryInput && countryInput.value ? countryInput.value : 'US';
      country = country.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) { showToast('Please enter a valid 2-letter country code', 'error'); return; }

      try {
        var res = await fetch('/api/user/connect/onboard', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ country: country }),
        });
        var data = await res.json();
        if (!res.ok) { showToast(data.error || 'Failed to start onboarding', 'error'); return; }
        if (data.onboarding_url) {
          window.open(data.onboarding_url, '_blank');
          showToast('Stripe onboarding opened. Complete the setup to enable payouts.');
        }
      } catch { showToast('Failed to start onboarding', 'error'); }
    };

    // --- Withdraw ---
    window.showWithdrawModal = async function() {
      var inputEl = document.getElementById('withdrawAmountLight');
      var lightAmount = parseInt(inputEl && inputEl.value ? inputEl.value : '0', 10);
      var minLight = getMinWithdrawalLight();
      var withdrawable = _connectData && _connectData.withdrawable_earnings_light ? _connectData.withdrawable_earnings_light : 0;
      if (isNaN(lightAmount) || lightAmount < minLight) { showToast('Minimum payout request is ' + formatLight(minLight), 'error'); return; }

      if (lightAmount > withdrawable) {
        showToast('Amount exceeds payout-eligible earnings (' + formatLight(withdrawable) + '). Only creator earnings can be paid out.', 'error');
        return;
      }
      if (!payoutTermsAccepted()) {
        showToast('Review and accept the payout terms before requesting payout.', 'error');
        return;
      }

      try {
        var res = await fetch('/api/user/connect/withdraw', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_light: lightAmount, terms_accepted: true }),
        });
        var data = await res.json();
        if (!res.ok) { showToast(data.error || 'Payout request failed', 'error'); return; }
        var scheduledText = data.scheduled_payout_date ? ' Scheduled for ' + formatPayoutScheduleDate(data.scheduled_payout_date) + '.' : ' The policy above determines the next eligible processing window.';
        showToast('Payout request submitted.' + scheduledText);
        if (inputEl) inputEl.value = '';
        updateWithdrawPreview();
        loadHostingData();
        loadEarnings();
        loadConnectStatus();
        loadPayouts();
      } catch { showToast('Payout request failed', 'error'); }
    };

    // --- Payout History ---
    async function loadPayouts() {
      var el = document.getElementById('payoutsHistory');
      if (!el) return;
      try {
        var res = await fetch('/api/user/connect/payouts', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) {
          el.innerHTML = renderShellState('error', 'Payout history unavailable', 'We could not load your latest payout history right now.', { compact: true });
          return;
        }
        var data = await res.json();
        if (!data.payouts || data.payouts.length === 0) {
          el.innerHTML = renderShellState('empty', 'No payouts yet', 'Completed payouts will appear here after creator earnings are processed.', { compact: true });
          return;
        }
        el.innerHTML = data.payouts.map(function(p) {
          var statusColor = p.status === 'paid' ? 'var(--success)' : p.status === 'failed' ? 'var(--error)' : p.status === 'held' ? '#ca8a04' : 'var(--text-muted)';
          var statusText = p.status;
          var scheduleDate = p.scheduled_payout_date || p.release_at;
          if (p.status === 'held' && scheduleDate) {
            statusText = 'scheduled';
          }
          var platformFee = p.platform_fee_light ? ' (fee: ' + formatLight(p.platform_fee_light) + ')' : '';
          var dateText = p.status === 'held' && scheduleDate ? 'run ' + formatPayoutScheduleDate(scheduleDate) : new Date(p.created_at).toLocaleDateString();
          return '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(76px,auto) minmax(110px,auto);gap:var(--space-2);align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">' +
            '<span style="font-weight:500;min-width:0;">' + formatLight(p.amount_light) + '<span style="font-weight:400;color:var(--text-muted);">' + platformFee + '</span></span>' +
            '<span style="color:' + statusColor + ';font-weight:500;">' + statusText + '</span>' +
            '<span style="color:var(--text-muted);text-align:right;">' + dateText + '</span>' +
          '</div>';
        }).join('');
      } catch {
        el.innerHTML = renderShellState('error', 'Payout history unavailable', 'We could not load your latest payout history right now.', { compact: true });
      }
    }

    // --- Supabase Servers ---
    async function loadSupabaseServers() {
      const container = document.getElementById('supabaseServersList');
      if (!container) return;
      try {
        const res = await fetch('/api/user/supabase', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) return;
        savedSupabaseServers = await res.json();

        if (!savedSupabaseServers || savedSupabaseServers.length === 0) {
          container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:8px 0">No Supabase servers configured.</div>';
          return;
        }

        container.innerHTML = savedSupabaseServers.map(function(s) {
          return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">' +
            '<span style="flex:1;font-family:var(--font-mono);font-size:12px">' + escapeHtml(s.url || s.id) + '</span>' +
            '<button class="btn btn-danger btn-sm" onclick="deleteSupabaseServer(\\\'' + s.id + '\\\')">Remove</button>' +
          '</div>';
        }).join('');
      } catch {}
    }

    window.addSupabaseServer = async function() {
      const url = document.getElementById('supabaseUrl')?.value?.trim();
      const anonKey = document.getElementById('supabaseAnonKey')?.value?.trim();
      const serviceKey = document.getElementById('supabaseServiceKey')?.value?.trim();
      if (!url || !anonKey) { showToast('URL and Anon Key are required', 'error'); return; }
      try {
        const body = { url: url, anon_key: anonKey };
        if (serviceKey) body.service_role_key = serviceKey;
        const res = await fetch('/api/user/supabase', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          showToast('Supabase server added!');
          document.getElementById('supabaseUrl').value = '';
          document.getElementById('supabaseAnonKey').value = '';
          document.getElementById('supabaseServiceKey').value = '';
          loadSupabaseServers();
        } else showToast('Failed to add server', 'error');
      } catch { showToast('Failed to add', 'error'); }
    };

    window.deleteSupabaseServer = async function(configId) {
      if (!confirm('Remove this Supabase server?')) return;
      try {
        const res = await fetch('/api/user/supabase/' + configId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (res.ok) { showToast('Server removed'); loadSupabaseServers(); }
        else showToast('Failed to remove', 'error');
      } catch { showToast('Failed to remove', 'error'); }
    };


    // ===== Error Handling =====
    window.onerror = function(msg, src, line) {
      errorLog('runtime', 'Runtime error', { message: msg, source: src, line: line });
    };
    window.onunhandledrejection = function(e) {
      errorLog('runtime', 'Unhandled rejection', e.reason);
    };

    // ===== Initialization =====
    await bootstrapEmbedBridgeSession();
    await updateAuthUI();

    // Handle initial view
    ${
    initialView === "app" && activeAppId
      ? `
    (async function() {
      var pathParts = window.location.pathname.slice(3).split('/');
      var section = pathParts[1] || 'overview';
      currentAppId = '${activeAppId}';
      showView('app');
      await loadAppPage('${activeAppId}', section);
    })();
    `
      : ""
  }

    // Handle ?setup=1 redirect (from OAuth popup fallback)
    (function() {
      var params = new URLSearchParams(window.location.search);
      if (params.get('setup') === '1' && authToken) {
        params.delete('setup');
        var cleanUrl = params.toString() ? window.location.pathname + '?' + params.toString() : window.location.pathname;
        history.replaceState({}, '', cleanUrl);
        setTimeout(function() { generateSetupInstructions(); }, 300);
      }
      if (params.get('popup') === '1') {
        // Clean up popup param
        params.delete('popup');
        var cleanUrl2 = params.toString() ? window.location.pathname + '?' + params.toString() : window.location.pathname;
        history.replaceState({}, '', cleanUrl2);
      }
    })();

    // Handle Stripe checkout redirect
    (function() {
      var params = new URLSearchParams(window.location.search);
      if (params.get('wallet_payment') === 'return') {
        params.delete('wallet_payment');
        var cleanWalletUrl = params.toString() ? window.location.pathname + '?' + params.toString() : window.location.pathname;
        history.replaceState({}, '', cleanWalletUrl);
        showToast('Wallet payment is being confirmed. Balance will update shortly.');
        setTimeout(function() { loadHostingData(); loadTransactions(true); }, 2000);
        setTimeout(function() { loadHostingData(); loadTransactions(true); }, 6000);
      }
      var topup = params.get('topup');
      if (topup === 'success') {
        var amountCents = parseInt(params.get('amount') || '0', 10);
        var lightReceived = Math.round(amountCents / 100 * getWalletLightPerUsd());
        var lightStr = amountCents > 0 ? ' (\\u2726' + lightReceived.toLocaleString() + ')' : '';
        showToast('Deposit successful' + lightStr + '! Balance will update shortly.');
        history.replaceState({}, '', window.location.pathname);
        setTimeout(function() { loadHostingData(); }, 2000);
        setTimeout(function() { loadHostingData(); }, 5000);
      } else if (topup === 'cancelled') {
        showToast('Deposit cancelled.', 'error');
        history.replaceState({}, '', window.location.pathname);
      }
    })();

    // Handle Stripe Connect redirect
    (function() {
      var params = new URLSearchParams(window.location.search);
      var connect = params.get('connect');
      if (connect === 'complete') {
        showToast('Payout setup complete. Checking status...');
        history.replaceState({}, '', '/wallet');
        switchDashSection('billing');
        setTimeout(function() { loadConnectStatus(); }, 1500);
      } else if (connect === 'refresh') {
        showToast('Onboarding session expired. Use Set Up Payouts to continue.', 'error');
        history.replaceState({}, '', '/wallet');
        switchDashSection('billing');
      }
    })();

  })();
  </script>
  </body>
</html>`;
}
