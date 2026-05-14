import type { Config } from 'tailwindcss';

/**
 * Ultralight Desktop — Tailwind theme.
 *
 * Phase 1 of the premium-UI port. Additions over the previous version are
 * tagged `// +premium`. No existing tokens were removed or renamed — this is
 * additive only. See `handoff/DESIGN-TOKENS-DIFF.md` for the empirical
 * rationale.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ul: {
          // ── FOREGROUND ──
          text: '#0a0a0a',
          'text-secondary': '#555555',
          'text-muted': '#999999',

          // ── BACKGROUND ──
          bg: '#ffffff',
          'bg-raised': '#fafafa',
          'bg-hover': 'rgba(0,0,0,0.04)',
          'bg-active': 'rgba(0,0,0,0.06)',
          'bg-subtle': 'rgba(0,0,0,0.02)',
          'bg-sidebar': '#f9fafb', // +premium — sidebar / toolbar canvas (was a CSS var only)

          // ── BORDERS ──
          border: 'rgba(0,0,0,0.08)',
          'border-strong': 'rgba(0,0,0,0.15)',
          'border-focus': 'rgba(0,0,0,0.4)',

          // ── ACCENT (monochrome brand) ──
          accent: '#0a0a0a',
          'accent-hover': '#333333',
          'accent-soft': 'rgba(0,0,0,0.06)',

          // ── SEMANTIC ──
          success: '#22c55e',
          'success-soft': 'rgba(34,197,94,0.1)',
          'success-strong': '#15803d',         // +premium — credit-applied / strong success text on light bg
          'success-hover': '#16a34a',          // +premium — success button :hover
          error: '#ef4444',
          'error-soft': 'rgba(239,68,68,0.08)',
          warning: '#f59e0b',
          'warning-soft': 'rgba(245,158,11,0.08)',
          info: '#3b82f6',                     // +premium — promote from CSS var
          'info-soft': 'rgba(59,130,246,0.10)',// +premium
          completed: '#60a5fa',                // +premium — tool-call "completed" indicator

          // ── DEEP ACCENTS (system agents) ──
          'deep-green': '#004225',             // +premium — Tool Marketer agent
          wine: '#722F37',                     // +premium — Platform Manager agent

          // ── CATEGORY (per-feature accents used as glyph tones / category chips) ──
          violet: '#7c3aed',                   // +premium
          'violet-soft': 'rgba(124,58,237,0.10)', // +premium

          // ── "LIGHT" / COPPER (premium upgrade, marketplace CTA, Add Light) ──
          copper: '#c96442',                   // +premium
          'copper-hover': '#b5563a',           // +premium
          'copper-soft': 'rgba(201,100,66,0.12)', // +premium

          // ── WARM PAPER THEME (marketplace canvas, acquisition modal) ──
          'warm-paper': '#f6f6f4',             // +premium
          'warm-ink': '#29261b',               // +premium
          'warm-ink-muted': 'rgba(41,38,27,0.55)', // +premium
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
      fontSize: {
        'display': ['48px', { lineHeight: '1.1', fontWeight: '700', letterSpacing: '-0.03em' }],
        'h1': ['32px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.02em' }],
        'h2': ['24px', { lineHeight: '1.3', fontWeight: '600', letterSpacing: '-0.015em' }],
        'h3': ['18px', { lineHeight: '1.4', fontWeight: '600', letterSpacing: '-0.01em' }],
        'body-lg': ['16px', { lineHeight: '1.6', fontWeight: '400' }],
        'body': ['14px', { lineHeight: '1.6', fontWeight: '400' }],
        'small': ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        'caption': ['12px', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.01em' }],
        // +premium — micro-label scale used heavily by the mockups
        'micro': ['11px', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.02em' }],
        'nano':  ['10px', { lineHeight: '1.3', fontWeight: '500', letterSpacing: '0.04em' }],
      },
      borderRadius: {
        // +premium
        'xs': '4px',
        'sm': '6px',
        'md': '8px',
        'pill': '10px',  // +premium — tool cards, library row items
        'lg': '12px',
        'card': '14px',  // +premium — premium marketplace cards
        'xl': '16px',
      },
      boxShadow: {
        'sm': '0 1px 2px rgba(0,0,0,0.05)',
        'md': '0 4px 12px rgba(0,0,0,0.08)',
        'lg': '0 8px 30px rgba(0,0,0,0.1)',
        'xl': '0 16px 50px rgba(0,0,0,0.12)',
        'glow': '0 0 0 3px rgba(0,0,0,0.06)',
      },
      spacing: {
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '8': '32px',
        '10': '40px',
        '12': '48px',
        '16': '64px',
        '20': '80px',
      },
      transitionDuration: {
        'fast': '120ms',
        'base': '200ms',
        'slow': '300ms',
      },
      maxWidth: {
        'content': '1200px',
        'narrow': '720px',
      },
      height: {
        'nav': '64px',
        'toolbar': '28px', // +premium — macOS title bar / draggable region
      },
      // +premium — named animations for the mockup motion vocabulary.
      // Keyframes live in `globals.css` under matching `ul-*` names.
      animation: {
        'msg-rise':     'ul-msg-rise 220ms cubic-bezier(0.4,0,0.2,1)',
        'toolpop':      'ul-toolpop 240ms cubic-bezier(0.4,0,0.2,1)',
        'pop':          'ul-pop 240ms cubic-bezier(0.4,0,0.2,1)',
        'fade-up':      'ul-fade-up 260ms cubic-bezier(0.4,0,0.2,1)',
        'fade-in':      'ul-fade-in 200ms cubic-bezier(0.4,0,0.2,1)',
        'pulse-slow':   'ul-pulse 1.4s ease-in-out infinite',
        'typing':       'ul-typing 1.2s infinite',
        'credit-rise':  'ul-credit-rise 1.4s ease forwards',
        'ring-resolve': 'ul-ring-resolve 700ms ease',
        'dealt-added':  'ul-dealt-added-flash 700ms ease',
        'shimmer':      'ul-shimmer 1.6s linear infinite',
        'breathe':      'ul-breathe 3s ease-in-out infinite',
        'wiggle':       'ul-wiggle 0.45s ease-in-out infinite', // +premium — edit-mode tile wiggle
        'orbit':        'ul-orbit 60s linear infinite',          // +premium — constellation empty state
        'spark-pulse':  'ul-spark-pulse 3.6s ease-in-out infinite', // +premium — constellation core
        'dot-arrive':   'ul-dot-arrive 360ms cubic-bezier(0.2,0.9,0.3,1)', // +premium — constellation dots
      },
    },
  },
  plugins: [],
} satisfies Config;
