// Pure layout for the per-agent OG card — builds the 1200x630 SVG string from a
// name + description. No wasm, no R2, no Worker globals, so it is unit-testable
// and can be render-proofed locally with resvg-js. The Worker-side renderer
// (og-card.ts) imports buildOgSvg from here.
//
// resvg has no DOM, so wrapping/shrink-to-fit use a deliberately conservative
// (slightly-too-wide) character-advance estimate so text wraps early rather than
// overflowing the card.

import { SWIRL_INNER } from "./og-assets.ts";

const CARD_W = 1200;
const TEXT_X = 94;
const TEXT_MAX_W = 1010; // x=94 .. ~1104, leaving a right margin
// Over-estimates width so lines wrap early and never spill past the right edge.
const ADVANCE = 0.55;

function approxWidth(s: string, fontSize: number): number {
  return s.length * fontSize * ADVANCE;
}

export function sanitize(s: string): string {
  // Replace control chars (incl. DEL) with spaces, then collapse whitespace.
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Greedy word-wrap into at most maxLines lines of ~maxChars, appending an
 * ellipsis to the last line when the text is truncated. */
export function wrapLines(
  text: string,
  maxChars: number,
  maxLines: number,
): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  let idx = 0;
  while (idx < words.length && lines.length < maxLines) {
    let w = words[idx];
    if (w.length > maxChars) w = w.slice(0, maxChars); // hard-cap an overlong token
    const cand = cur ? cur + " " + w : w;
    if (cand.length <= maxChars) {
      cur = cand;
      idx++;
    } else if (cur) {
      lines.push(cur);
      cur = "";
    } else {
      lines.push(w);
      cur = "";
      idx++;
    }
  }
  if (cur && lines.length < maxLines) {
    lines.push(cur);
    cur = "";
  }
  const truncated = idx < words.length || cur !== "";
  if (truncated && lines.length) {
    let last = lines[lines.length - 1];
    if (last.length + 1 > maxChars) last = last.slice(0, maxChars - 1).trimEnd();
    lines[lines.length - 1] = last + "…";
  }
  return lines;
}

/** Build the card SVG string for a given name + description. */
export function buildOgSvg(rawName: string, rawDescription: string): string {
  const name = sanitize(rawName) || "Agent";
  const description = sanitize(rawDescription);

  // Name: one line, shrink-to-fit from 84 down to a floor, then ellipsize.
  let nameSize = 84;
  const NAME_FLOOR = 50;
  let nameLine = name;
  while (nameSize > NAME_FLOOR && approxWidth(nameLine, nameSize) > TEXT_MAX_W) {
    nameSize -= 4;
  }
  if (approxWidth(nameLine, nameSize) > TEXT_MAX_W) {
    const maxChars = Math.max(
      1,
      Math.floor(TEXT_MAX_W / (nameSize * ADVANCE)) - 1,
    );
    nameLine = nameLine.slice(0, maxChars).trimEnd() + "…";
  }

  // Description: up to 2 lines at 33px.
  const DESC_SIZE = 33;
  const descMaxChars = Math.floor(TEXT_MAX_W / (DESC_SIZE * ADVANCE));
  const descLines = description ? wrapLines(description, descMaxChars, 2) : [];

  const descSvg = descLines
    .map(
      (line, i) =>
        `<text x="96" y="${424 + i * 42}" fill="#52555a" font-size="${DESC_SIZE}" font-weight="400">${escapeXml(line)}</text>`,
    )
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} 630" width="${CARD_W}" height="630" font-family="Newsreader, Georgia, 'Times New Roman', serif">
  <rect width="${CARD_W}" height="630" fill="#ffffff"/>
  <g transform="translate(90 150) scale(0.42)">${SWIRL_INNER}</g>
  <text x="${TEXT_X}" y="348" fill="#0a0a0a" font-family="'Newsreader Display', Georgia, serif" font-size="${nameSize}" font-weight="700" letter-spacing="-2">${escapeXml(nameLine)}</text>
  ${descSvg}
</svg>`;
}
