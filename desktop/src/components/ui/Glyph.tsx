// Glyph — typographic monogram tile used as an app/tool avatar.
//
// Ports `LB_Glyph` from handoff/mockups/library-screens.jsx. The `tone` is a
// per-app "data color" (see DESIGN-TOKENS-DIFF §1c — applied via inline
// style because it's a property of each app record, not a design token).

interface GlyphProps {
  /** 1-3 character monogram. Typically derived from app name initials. */
  glyph: string;
  /** Per-app tone color (hex). Applied as the tile background. */
  tone: string;
  /** Tile size in px (square). Defaults to 36 to match library row rhythm. */
  size?: number;
  /** Extra Tailwind classes (e.g., to add a status dot via absolute positioning). */
  className?: string;
}

export default function Glyph({ glyph, tone, size = 36, className = '' }: GlyphProps) {
  return (
    <div
      className={`rounded-pill text-white inline-flex items-center justify-center font-mono font-bold tracking-tight flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        background: tone,
        fontSize: Math.round(size * 0.36),
        letterSpacing: '-0.02em',
      }}
    >
      {glyph}
    </div>
  );
}

/** Derive a 2-character monogram from a display name.
 *  "Private Tutor" -> "PT", "email-ops" -> "EM", "Reading List" -> "RL". */
export function deriveGlyph(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9\s-]/g, '').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/[\s-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/** Derive a stable tone color from the app's id or slug. Picks from the
 *  premium-UI category palette so glyphs feel cohesive across the library.
 *  Per DESIGN-TOKENS-DIFF §1c, these hex values are data, not tokens. */
const GLYPH_PALETTE = [
  '#3b82f6', // info / blue
  '#22c55e', // success / green
  '#7c3aed', // violet
  '#722F37', // wine
  '#004225', // deep-green
  '#ef4444', // error / red
  '#0a0a0a', // text / near-black
  '#c96442', // copper
];

export function deriveTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % GLYPH_PALETTE.length;
  return GLYPH_PALETTE[idx];
}
