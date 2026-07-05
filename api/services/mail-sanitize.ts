// Shared SMTP/IMAP injection guards. Imported by BOTH copies of the TCP
// protocol code (api/services/tcp-protocols.ts and
// api/src/bindings/network-binding.ts) so header/command sanitization stays
// identical. All values here are sandbox- or credential-supplied strings that
// get concatenated into a CRLF-framed protocol stream, so any raw CR, LF, or
// NUL (or, for header fields, any C0 control char) lets the caller inject
// extra envelope commands, headers, or a premature end-of-DATA.

// Reject CR/LF and control chars in a value destined for an SMTP envelope
// command or a message header. Tab (\t) is permitted (valid in header text /
// folding); everything else below 0x20 plus DEL is rejected.
export function assertNoHeaderInjection(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: line breaks are not allowed`);
  }
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${field}: control characters are not allowed`);
  }
}

// Validate a single RFC5321-ish mailbox address for use in MAIL FROM / RCPT TO
// and the From/To headers. Must be exactly one addr-spec: no CR/LF, no commas
// or angle brackets (which would allow multiple recipients / address-list
// smuggling), no whitespace, and a single '@'.
const ADDR_RE = /^[^\s<>,"@]+@[^\s<>,"@]+$/;
export function assertSingleAddress(field: string, value: string): void {
  assertNoHeaderInjection(field, value);
  if (!ADDR_RE.test(value)) {
    throw new Error(`Invalid ${field}: must be a single email address`);
  }
}

// SMTP DATA transparency (RFC 5321 sec 4.5.2): any line beginning with '.'
// must be dot-stuffed (prefixed with an extra '.') so a lone '.' line cannot
// terminate the message body early and smuggle a second message. Also
// normalizes bare CR / bare LF to CRLF so mixed line endings can't desync the
// dot-stuffing. Caller still appends the terminating "\r\n.\r\n".
export function dotStuffBody(body: string): string {
  const normalized = body.replace(/\r\n|\r|\n/g, "\r\n");
  return normalized.replace(/^\./gm, "..");
}

// An IMAP flag / keyword atom (e.g. the processed-marker keyword). Per RFC3501
// an atom excludes controls, whitespace, and the special chars
// ( ) { % * " \ ]  — restrict to a safe atom so it cannot break out of the
// UNKEYWORD / +FLAGS command.
const IMAP_ATOM_RE = /^[A-Za-z0-9$_.+-]+$/;
export function assertImapAtom(field: string, value: string): void {
  if (!IMAP_ATOM_RE.test(value)) {
    throw new Error(`Invalid ${field}: not a valid IMAP flag atom`);
  }
}

// IMAP quoted-string content (LOGIN user/pass). A quoted string may not
// contain CR or LF; backslash and double-quote must be escaped by the caller.
// We fail closed on CR/LF/NUL (and a trailing lone backslash, which would
// produce an unterminated quoted string) rather than trying to encode them.
export function assertImapQuotable(field: string, value: string): void {
  // deno-lint-ignore no-control-regex
  if (/[\r\n\x00]/.test(value)) {
    throw new Error(`Invalid ${field}: line breaks are not allowed`);
  }
  if (/\\$/.test(value)) {
    throw new Error(`Invalid ${field}: may not end with a backslash`);
  }
}
