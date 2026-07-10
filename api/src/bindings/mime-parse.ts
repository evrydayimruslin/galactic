// MIME message parsing — pure functions, no runtime bindings.
//
// Split out from network-binding.ts so it can be unit-tested without the
// cloudflare:* imports. Everything here operates on the raw octets of an RFC
// 5322 message. The core trick: decode the raw bytes as latin1 (a byte-
// preserving 1:1 mapping) so boundaries and headers can be sliced as a string,
// then recover exact bytes via charCodeAt before the FINAL charset decode of
// each leaf part. That is what lets a Shift_JIS or ISO-2022-JP part decode
// correctly instead of turning to mojibake.

const utf8 = new TextDecoder('utf-8', { fatal: false });
const latin1 = new TextDecoder('latin1');

interface ParsedMessage {
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  date: string;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    return latin1ToBytes(atob(clean));
  } catch {
    return new Uint8Array(0);
  }
}

function qpToBytes(s: string): Uint8Array {
  const joined = s.replace(/=\r?\n/g, ''); // soft line breaks
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.substr(i + 1, 2))) {
      out.push(parseInt(joined.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function decodeCharset(bytes: Uint8Array, charset?: string): string {
  const label = (charset || 'utf-8').trim().toLowerCase().replace(/["']/g, '');
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return utf8.decode(bytes);
  }
}

// Re-interpret a latin1-decoded header value as UTF-8 when it carries raw 8-bit
// bytes (some servers emit raw-UTF-8 Subjects with no encoded-word). If the
// bytes aren't valid UTF-8 the fatal decode throws and we keep the original.
function maybeUtf8(s: string): string {
  let hasHighByte = false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) { hasHighByte = true; break; }
  }
  if (!hasHighByte) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(latin1ToBytes(s));
  } catch {
    return s;
  }
}

// RFC 2047 encoded-words (=?charset?B/Q?text?=), charset-aware, with adjacent
// encoded words joined per §6.2.
function decodeWords(input: string): string {
  const joined = input.replace(
    /(=\?[^?]+\?[bqBQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bqBQ]\?)/g,
    '$1',
  );
  const decoded = joined.replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g,
    (_m, charset: string, encoding: string, text: string) => {
      try {
        const bytes = encoding.toUpperCase() === 'B'
          ? base64ToBytes(text)
          : qpToBytes(text.replace(/_/g, ' '));
        return decodeCharset(bytes, charset);
      } catch {
        return _m;
      }
    },
  );
  return maybeUtf8(decoded);
}

function splitHeaderBody(raw: string): { header: string; body: string } {
  let idx = raw.indexOf('\r\n\r\n');
  let sep = 4;
  if (idx < 0) {
    idx = raw.indexOf('\n\n');
    sep = 2;
  }
  if (idx < 0) return { header: raw, body: '' };
  return { header: raw.substring(0, idx), body: raw.substring(idx + sep) };
}

type Headers = Record<string, string>;

function parseHeaders(headerBlock: string): Headers {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.substring(0, colon).trim().toLowerCase();
    const value = line.substring(colon + 1).trim();
    // Keep the first occurrence (RFC 5322 singleton headers).
    if (!(name in headers)) headers[name] = value;
  }
  return headers;
}

function paramOf(value: string, name: string): string {
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))', 'i');
  const m = value.match(re);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function extractAddr(value: string): string {
  const decoded = decodeWords(value);
  const angle = decoded.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  const bare = decoded.match(/[^\s<>",;]+@[^\s<>",;]+/);
  return bare ? bare[0].trim() : decoded.trim();
}

function messageIds(value: string): string {
  const ids = value.match(/<[^>]+>/g);
  if (ids) return ids.map((s) => s.replace(/[<>]/g, '')).join(' ');
  return value.replace(/[<>]/g, '').trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return _m;
      }
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Decode a single leaf part's body to text using its transfer-encoding + charset.
function decodePartBody(headers: Headers, bodyLatin1: string): string {
  const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
  const charset = paramOf(headers['content-type'] || '', 'charset');
  let bytes: Uint8Array;
  if (cte.includes('base64')) {
    bytes = base64ToBytes(bodyLatin1);
  } else if (cte.includes('quoted-printable')) {
    bytes = qpToBytes(bodyLatin1);
  } else {
    bytes = latin1ToBytes(bodyLatin1); // 7bit / 8bit / binary
  }
  return decodeCharset(bytes, charset);
}

// Split a multipart body (latin1) on its boundary, anchored to line starts so a
// boundary string appearing inside content can't cause a false split.
function splitMimeParts(bodyLatin1: string, boundary: string): string[] {
  const normalized = bodyLatin1.replace(/\r?\n/g, '\r\n');
  const segments = ('\r\n' + normalized).split('\r\n--' + boundary);
  const parts: string[] = [];
  // segments[0] is the preamble (before the first boundary) — discard it.
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('--')) break; // closing delimiter "--boundary--"
    const nl = seg.indexOf('\r\n'); // drop the remainder of the boundary line
    parts.push(nl >= 0 ? seg.slice(nl + 2) : '');
  }
  return parts;
}

// Recursively extract the best human-readable text from a MIME tree. Prefers
// text/plain; falls back to stripped text/html; recurses into nested multiparts
// and message/rfc822; skips attachments.
function extractText(headers: Headers, bodyLatin1: string, depth = 0): string {
  if (depth > 12) return '';
  const ctype = (headers['content-type'] || 'text/plain').toLowerCase();

  if (ctype.startsWith('multipart/')) {
    const boundary = paramOf(headers['content-type'] || '', 'boundary');
    if (!boundary) return '';
    let plain = '';
    let html = '';
    for (const part of splitMimeParts(bodyLatin1, boundary)) {
      const { header, body } = splitHeaderBody(part);
      const ph = parseHeaders(header);
      const disposition = (ph['content-disposition'] || '').toLowerCase();
      if (disposition.startsWith('attachment')) continue;
      const pctype = (ph['content-type'] || 'text/plain').toLowerCase();
      if (pctype.startsWith('multipart/')) {
        const nested = extractText(ph, body, depth + 1);
        if (nested && !plain) plain = nested;
      } else if (pctype.startsWith('message/rfc822')) {
        const embedded = parseMessage(latin1ToBytes(body));
        if (embedded.body && !plain) plain = embedded.body;
      } else if (pctype.startsWith('text/plain') && !plain) {
        plain = decodePartBody(ph, body).trim();
      } else if (pctype.startsWith('text/html') && !html) {
        html = htmlToText(decodePartBody(ph, body));
      }
    }
    return plain || html;
  }

  if (ctype.startsWith('text/html')) {
    return htmlToText(decodePartBody(headers, bodyLatin1));
  }
  return decodePartBody(headers, bodyLatin1).trim();
}

export function parseMessage(rawBytes: Uint8Array): ParsedMessage {
  const raw = latin1.decode(rawBytes);
  const { header, body } = splitHeaderBody(raw);
  const headers = parseHeaders(header);
  const subject = decodeWords(headers['subject'] || '').trim();
  return {
    from: extractAddr(headers['from'] || ''),
    to: extractAddr(headers['to'] || ''),
    cc: headers['cc'] ? extractAddr(headers['cc']) : '',
    replyTo: headers['reply-to'] ? extractAddr(headers['reply-to']) : '',
    subject: subject || '(no subject)',
    body: extractText(headers, body).trim(),
    messageId: messageIds(headers['message-id'] || ''),
    inReplyTo: messageIds(headers['in-reply-to'] || ''),
    references: messageIds(headers['references'] || ''),
    date: (headers['date'] || '').trim(),
  };
}
