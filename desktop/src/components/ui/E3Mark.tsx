// E3Mark — the platform constellation glyph: three colored system-agent dots
// orbiting a Light spark, behind a dashed ring. Used on AuthGate and the
// OnboardingWizard welcome screen so first launch reads as the product
// constellation, not the corporate wordmark.
//
// The three dot colors map to the system agents:
//   top         — Tool Marketer (deep-green)
//   bottom-right — Platform Manager (wine)
//   bottom-left  — Tool Builder (info-blue)

interface E3MarkProps {
  size?: number;
  color?: string;
}

export default function E3Mark({ size = 36, color = 'currentColor' }: E3MarkProps) {
  const k = 0.28;
  const r = 44;
  const cx = 128;
  const cy = 128;
  const sparkPoints = [
    [cx, cy - r],
    [cx + r * k, cy - r * k],
    [cx + r, cy],
    [cx + r * k, cy + r * k],
    [cx, cy + r],
    [cx - r * k, cy + r * k],
    [cx - r, cy],
    [cx - r * k, cy - r * k],
  ]
    .map((p) => p.join(','))
    .join(' ');

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <circle cx="128" cy="128" r="84" fill="none" stroke={color} strokeWidth="2" strokeDasharray="2 6" />
      <circle cx="128" cy="40" r="12" fill="#004225" />
      <circle cx="204" cy="174" r="12" fill="#722F37" />
      <circle cx="52" cy="174" r="12" fill="#3b82f6" />
      <polygon points={sparkPoints} fill={color} />
    </svg>
  );
}
