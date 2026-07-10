// Fixtures for the inbound MIME parser. These are the cases the production
// (host-side) parser previously got wrong — the "gibberish and code" and
// mojibake the showcase agent reported. Each asserts the DECODED text, not just
// "didn't throw".

import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import { assert } from 'https://deno.land/std@0.210.0/assert/assert.ts';
import { parseMessage } from './mime-parse.ts';

// Build raw message octets from mixed string (latin1) + byte-array segments.
function raw(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) => {
    if (typeof p !== 'string') return p;
    const b = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) b[i] = p.charCodeAt(i) & 0xff;
    return b;
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

Deno.test('parses a plain UTF-8 email with all threading headers', () => {
  const msg = parseMessage(raw(
    'From: Guest Name <guest@example.com>\r\n',
    'To: hotel@rockwood.example\r\n',
    'Cc: manager@rockwood.example\r\n',
    'Reply-To: real-guest@example.com\r\n',
    'Subject: Room availability\r\n',
    'Message-ID: <abc123@example.com>\r\n',
    'In-Reply-To: <root@rockwood.example>\r\n',
    'References: <root@rockwood.example> <mid@example.com>\r\n',
    'Date: Tue, 08 Jul 2026 10:00:00 +0900\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    '\r\n',
    'Do you have a room for two nights?\r\n',
  ));
  assertEquals(msg.from, 'guest@example.com');
  assertEquals(msg.cc, 'manager@rockwood.example');
  assertEquals(msg.replyTo, 'real-guest@example.com');
  assertEquals(msg.subject, 'Room availability');
  assertEquals(msg.messageId, 'abc123@example.com');
  assertEquals(msg.inReplyTo, 'root@rockwood.example');
  assertEquals(msg.references, 'root@rockwood.example mid@example.com');
  assert(msg.date.includes('2026'));
  assertEquals(msg.body, 'Do you have a room for two nights?');
});

Deno.test('decodes RFC 2047 B-encoded UTF-8 subject', () => {
  // "Café ☕" base64 in UTF-8.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('Café ☕')));
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Subject: =?UTF-8?B?' + b64 + '?=\r\n',
    '\r\n',
    'body\r\n',
  ));
  assertEquals(msg.subject, 'Café ☕');
});

Deno.test('decodes RFC 2047 Q-encoded subject and joins adjacent words', () => {
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Subject: =?UTF-8?Q?Late=20checkout?= =?UTF-8?Q?_request?=\r\n',
    '\r\n',
    'body\r\n',
  ));
  assertEquals(msg.subject, 'Late checkout request');
});

Deno.test('quoted-printable UTF-8 body decodes without mojibake (the reported bug)', () => {
  // "café — 予約" as UTF-8, quoted-printable. The OLD parser used
  // String.fromCharCode on each =XX byte, producing "cafÃ©". The new parser
  // rebuilds the byte stream then charset-decodes.
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Subject: s\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    'Content-Transfer-Encoding: quoted-printable\r\n',
    '\r\n',
    'caf=C3=A9 =E4=BA=88=E7=B4=84\r\n',
  ));
  assertEquals(msg.body, 'café 予約');
});

Deno.test('decodes a Shift_JIS base64 body', () => {
  // "テスト" in Shift_JIS: テ=0x8365 ス=0x8358 ト=0x8367
  const sjis = new Uint8Array([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
  const b64 = btoa(String.fromCharCode(...sjis));
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Subject: s\r\n',
    'Content-Type: text/plain; charset=Shift_JIS\r\n',
    'Content-Transfer-Encoding: base64\r\n',
    '\r\n',
    b64 + '\r\n',
  ));
  assertEquals(msg.body, 'テスト');
});

Deno.test('decodes an ISO-8859-1 (windows-1252) 8-bit body', () => {
  // "café" with é = 0xE9 (latin1), sent 8bit.
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Content-Type: text/plain; charset=iso-8859-1\r\n',
    'Content-Transfer-Encoding: 8bit\r\n',
    '\r\n',
    new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    '\r\n',
  ));
  assertEquals(msg.body, 'café');
});

Deno.test('extracts text/plain from NESTED multipart (mixed > alternative)', () => {
  // The dominant real-world shape the old top-level-only parser dumped as raw.
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Subject: s\r\n',
    'Content-Type: multipart/mixed; boundary="OUTER"\r\n',
    '\r\n',
    '--OUTER\r\n',
    'Content-Type: multipart/alternative; boundary="INNER"\r\n',
    '\r\n',
    '--INNER\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    '\r\n',
    'Hello from the plain part.\r\n',
    '--INNER\r\n',
    'Content-Type: text/html; charset=UTF-8\r\n',
    '\r\n',
    '<p>Hello from the <b>html</b> part.</p>\r\n',
    '--INNER--\r\n',
    '--OUTER--\r\n',
  ));
  assertEquals(msg.body, 'Hello from the plain part.');
});

Deno.test('HTML-only email is stripped, with <style>/<script> CONTENT removed', () => {
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Content-Type: text/html; charset=UTF-8\r\n',
    '\r\n',
    '<html><head><style>.x{color:red}</style>',
    '<script>track()</script></head>',
    '<body><p>Your booking is confirmed.</p></body></html>\r\n',
  ));
  assertEquals(msg.body, 'Your booking is confirmed.');
  assert(!msg.body.includes('color:red'), 'CSS leaked into body');
  assert(!msg.body.includes('track()'), 'script leaked into body');
});

Deno.test('prefers the body part over a text/plain ATTACHMENT', () => {
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Content-Type: multipart/mixed; boundary="B"\r\n',
    '\r\n',
    '--B\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    '\r\n',
    'The real message.\r\n',
    '--B\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    'Content-Disposition: attachment; filename="notes.txt"\r\n',
    '\r\n',
    'Attachment contents that must not be treated as the body.\r\n',
    '--B--\r\n',
  ));
  assertEquals(msg.body, 'The real message.');
});

Deno.test('a boundary string appearing inside content does not mis-split', () => {
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    'Content-Type: multipart/alternative; boundary="XYZ"\r\n',
    '\r\n',
    '--XYZ\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    '\r\n',
    'Discount code --XYZ is inline, not a real boundary.\r\n',
    '--XYZ--\r\n',
  ));
  assertEquals(msg.body, 'Discount code --XYZ is inline, not a real boundary.');
});

Deno.test('contact-form: Reply-To carries the real requester', () => {
  const msg = parseMessage(raw(
    'From: forms@rockwood.example\r\n',
    'Reply-To: visitor@gmail.com\r\n',
    'Subject: New enquiry\r\n',
    'Content-Type: text/plain; charset=UTF-8\r\n',
    '\r\n',
    'Message from the website form.\r\n',
  ));
  assertEquals(msg.from, 'forms@rockwood.example');
  assertEquals(msg.replyTo, 'visitor@gmail.com');
});

Deno.test('missing subject falls back, missing optional headers are empty', () => {
  const msg = parseMessage(raw(
    'From: a@b.com\r\n',
    '\r\n',
    'no subject here\r\n',
  ));
  assertEquals(msg.subject, '(no subject)');
  assertEquals(msg.cc, '');
  assertEquals(msg.replyTo, '');
  assertEquals(msg.references, '');
});
