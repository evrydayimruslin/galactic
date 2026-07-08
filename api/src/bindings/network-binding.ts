// RPC Network Binding for Dynamic Workers
// High-level protocol methods that run entire TCP sessions in a single RPC call.
// CF Workers constraint: I/O objects can't cross request contexts, so each RPC
// method must open, use, and close the socket within one call.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { isBlockedHost } from './outbound-policy.ts';
import {
  assertNoHeaderInjection,
  assertSingleAddress,
  dotStuffBody,
  assertImapQuotable,
} from '../../services/mail-sanitize.ts';
import type { ResolvedCredential } from '../../../shared/contracts/env.ts';
import { parseMessage } from './mime-parse.ts';

interface NetworkBindingProps {
  userId: string;
  appId: string;
  // Per-user values (host/user/pass etc.), decrypted, keyed by env var name.
  // net.* resolves host/user/pass from these BY KEY — the sandbox never passes a
  // raw host, so a developer cannot redirect the user's password to a host of
  // their choosing; it only ever reaches one of the user's own configured hosts.
  credentials: Record<string, ResolvedCredential>;
}

// A fully-parsed inbound message. All header fields are RFC 2047-decoded and the
// body is charset-decoded (UTF-8, ISO-2022-JP, Shift_JIS, windows-1252, …).
interface FetchedEmail {
  uid: number;
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

interface ImapFetchResult {
  emails: FetchedEmail[];
  // Every UID this call attempted to fetch, ascending. The app advances its
  // watermark only over a contiguous prefix of these that processed cleanly, so
  // a UID whose fetch/parse failed (present here but absent from `emails`) holds
  // the watermark and is retried next poll — at-least-once, never skipped.
  attemptedUids: number[];
  // Mailbox identity + cursor from SELECT. uidValidity change ⇒ the app must
  // reset its watermark; uidNext lets a first-time connect baseline to "now"
  // instead of ingesting the entire archive.
  uidValidity: number;
  uidNext: number;
  hasMore: boolean;
  // Highest existing UID in the mailbox (for logging + first-connect baseline).
  // The app's watermark is derived from the contiguous-success prefix, not this.
  maxUid: number;
}

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

// ── Security ──
// host/port are sandbox-supplied, so block connections to internal/private
// networks and the bare SMTP port before opening a socket. Reuses the shared
// egress policy (outbound-policy.ts) so the IMAP/SMTP socket path gets the SAME
// coverage as raw fetch — loopback/RFC1918/CGNAT/link-local/metadata + IPv6 +
// integer/hex encodings — instead of the old weaker prefix check.
function validateTarget(hostname: string, port: number): void {
  if (isBlockedHost(hostname)) {
    throw new Error("Connections to internal/private networks are not allowed");
  }
  if (port === 25) throw new Error("Port 25 blocked. Use 465 or 587.");
  // No allowlist here: the host is resolved from a per-user credential KEY (the
  // user's own configured server), not a sandbox-supplied string, so the egress
  // allowlist that constrains raw fetch() is unnecessary and would wrongly block
  // the user's arbitrary mail host. SSRF (internal/private) is still enforced.
}

// ── Byte-accurate line/literal reader ──
// IMAP literals declare a length in OCTETS ({N}), not characters. The previous
// reader accumulated a *decoded* string and sliced N characters, so any 8-bit
// (UTF-8/8BITMIME) message over-consumed past the literal and spliced protocol
// text into the body. This reader buffers raw bytes: readLine decodes a single
// ASCII/latin1 protocol line, readBytes returns EXACTLY N octets untouched, so
// the raw MIME handed to the parser is byte-for-byte correct.
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  private append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  private indexOfCRLF(): number {
    for (let i = 0; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i;
    }
    return -1;
  }

  async readLine(): Promise<string> {
    while (true) {
      const idx = this.indexOfCRLF();
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + 2);
        return latin1.decode(line);
      }
      const { value, done } = await this.reader.read();
      if (done) {
        const rest = latin1.decode(this.buf);
        this.buf = new Uint8Array(0);
        return rest;
      }
      this.append(value);
    }
  }

  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.append(value);
    }
    const take = Math.min(n, this.buf.length);
    const out = this.buf.slice(0, take); // copy — caller retains it across reads
    this.buf = this.buf.subarray(take);
    return out;
  }

  releaseLock(): void {
    try {
      this.reader.releaseLock();
    } catch { /* already released */ }
  }
}

// ── Network Binding ──

export class NetworkBinding extends WorkerEntrypoint<unknown, NetworkBindingProps> {
  // Resolve a per-user value by KEY from host-side props. The sandbox passes key
  // names (never raw host/user/pass), so app code never sees the secret and a
  // developer cannot point the connection at a host they choose.
  private resolveCredential(key: string): string {
    const entry = this.ctx.props.credentials?.[key];
    if (!entry) {
      throw new Error(
        `Unknown credential "${key}" — connect it (per_user) before using net.*`,
      );
    }
    return entry.value;
  }

  /**
   * Fetch inbound mail above a UID watermark in a single TCP session.
   *
   * host/user/pass are per-user credential KEYS, resolved host-side. Delivery is
   * at-least-once: this call does NOT mark messages seen/processed and does NOT
   * filter on \Seen, so mail already read in another client is still ingested and
   * a failed downstream step re-delivers on the next poll. The app owns the
   * cursor (advancing only over a contiguous prefix of `attemptedUids`) and
   * de-duplicates by Message-ID.
   *
   * `processedFlag` is accepted for wire-compat with the sandbox shim but is no
   * longer used — the UID watermark + Message-ID ledger replace the server-side
   * keyword, which silently no-ops on servers without custom-keyword support.
   */
  async imapFetchUnseen(
    hostKey: string,
    port: number,
    userKey: string,
    passKey: string,
    lastUid: number,
    businessEmail: string,
    _processedFlag: string,
    limit: number,
  ): Promise<ImapFetchResult> {
    const host = this.resolveCredential(hostKey);
    const user = this.resolveCredential(userKey);
    const pass = this.resolveCredential(passKey);
    // Fail closed on injection before opening the socket.
    assertImapQuotable('user', user);
    assertImapQuotable('pass', pass);
    validateTarget(host, port);
    const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
    const lr = new ByteReader(socket.readable);
    const writer = socket.writable.getWriter();
    let tagNum = 0;

    // Send a command and read its tagged response. Any literals ({N}) are
    // captured as raw bytes (not decoded), so a FETCH body comes back intact.
    async function cmd(command: string): Promise<{ lines: string[]; literals: Uint8Array[]; ok: boolean }> {
      tagNum++;
      const tag = 'A' + String(tagNum).padStart(4, '0');
      await writer.write(enc.encode(tag + ' ' + command + '\r\n'));
      const lines: string[] = [];
      const literals: Uint8Array[] = [];
      while (true) {
        let line = await lr.readLine();
        let lit = line.match(/\{(\d+)\}$/);
        while (lit) {
          literals.push(await lr.readBytes(parseInt(lit[1], 10)));
          const cont = await lr.readLine();
          line = cont;
          lit = cont.match(/\{(\d+)\}$/);
        }
        if (line.startsWith(tag + ' ')) {
          return { lines, literals, ok: line.includes(tag + ' OK') };
        }
        lines.push(line);
      }
    }

    try {
      console.log('[NET:IMAP] Connecting to', host, port);
      const greeting = await lr.readLine();
      if (!greeting.startsWith('* OK')) throw new Error('IMAP greeting failed: ' + greeting);

      const loginResult = await cmd(
        'LOGIN "' + user.replace(/["\\]/g, '\\$&') + '" "' + pass.replace(/["\\]/g, '\\$&') + '"',
      );
      if (!loginResult.ok) throw new Error('IMAP login failed');

      const selResult = await cmd('SELECT INBOX');
      if (!selResult.ok) throw new Error('SELECT INBOX failed');

      // Mailbox identity + cursor come back as untagged "* OK [UIDVALIDITY n]" /
      // "* OK [UIDNEXT n]" responses.
      let uidValidity = 0;
      let uidNext = 0;
      for (const l of selResult.lines) {
        const v = l.match(/\[UIDVALIDITY (\d+)\]/i);
        if (v) uidValidity = parseInt(v[1], 10);
        const n = l.match(/\[UIDNEXT (\d+)\]/i);
        if (n) uidNext = parseInt(n[1], 10);
      }

      // No UNSEEN / UNKEYWORD filter: fetch everything above the watermark so
      // mail already read elsewhere is still ingested. `<lastUid+1>:*` always
      // echoes the highest UID even when nothing is new, so filter client-side.
      const searchCmd = lastUid > 0
        ? 'UID SEARCH UID ' + (lastUid + 1) + ':*'
        : 'UID SEARCH ALL';
      const searchResult = await cmd(searchCmd);
      const uidLine = searchResult.lines.find((l) => /^\* SEARCH/i.test(l));
      const uids: number[] = [];
      if (uidLine) {
        for (const p of uidLine.replace(/^\* SEARCH/i, '').trim().split(/\s+/)) {
          const n = parseInt(p, 10);
          if (n > lastUid) uids.push(n);
        }
      }
      uids.sort((a, b) => a - b);

      if (uids.length === 0) {
        await cmd('LOGOUT');
        return { emails: [], attemptedUids: [], uidValidity, uidNext, hasMore: false, maxUid: lastUid };
      }

      const attemptedUids = uids.slice(0, Math.max(1, limit));
      const emails: FetchedEmail[] = [];

      for (const uid of attemptedUids) {
        try {
          // BODY.PEEK[] leaves \Seen untouched; the literal carries the raw
          // message which readBytes returns as exact octets.
          const fetchResult = await cmd('UID FETCH ' + uid + ' (BODY.PEEK[])');
          const rawMessage = fetchResult.literals[0];
          if (!rawMessage || rawMessage.length === 0) continue;
          const parsed = parseMessage(rawMessage);
          // Skip our own outbound (bounced back into the inbox, or a Sent copy).
          if (businessEmail && parsed.from.toLowerCase() === businessEmail.toLowerCase()) {
            continue;
          }
          emails.push({ uid, ...parsed });
        } catch {
          // Leave this UID out of `emails`; it stays in attemptedUids so the app
          // holds the watermark and retries it next poll.
        }
      }

      await cmd('LOGOUT');
      // True mailbox tip (highest existing UID), not just the batch max — lets a
      // first-connect baseline be correct even if the server omitted UIDNEXT.
      // reduce (not Math.max spread) to stay safe on very large mailboxes.
      const maxUid = uids.reduce((m, u) => (u > m ? u : m), lastUid);
      console.log('[NET:IMAP] Fetched', emails.length, 'of', attemptedUids.length, 'attempted; hasMore=', uids.length > attemptedUids.length);
      return {
        emails,
        attemptedUids,
        uidValidity,
        uidNext,
        hasMore: uids.length > attemptedUids.length,
        maxUid,
      };
    } catch (e: unknown) {
      console.error('[NET:IMAP] ERROR:', e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      lr.releaseLock();
      try { writer.releaseLock(); } catch { /* noop */ }
      try { socket.close(); } catch { /* noop */ }
    }
  }

  /**
   * Send an email via SMTP in a single TCP session. Returns the generated
   * Message-ID (without angle brackets) so the caller can persist it and thread
   * the guest's eventual reply back to this conversation.
   */
  async smtpSend(
    hostKey: string,
    port: number,
    userKey: string,
    passKey: string,
    from: string,
    fromName: string,
    to: string,
    subject: string,
    body: string,
    inReplyTo?: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const host = this.resolveCredential(hostKey);
    const user = this.resolveCredential(userKey);
    const pass = this.resolveCredential(passKey);
    // Fail closed on header/command injection before opening the socket.
    assertSingleAddress('from', from);
    assertSingleAddress('to', to);
    assertNoHeaderInjection('fromName', fromName);
    assertNoHeaderInjection('subject', subject);
    if (inReplyTo) assertNoHeaderInjection('inReplyTo', inReplyTo);
    validateTarget(host, port);
    const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
    const lr = new ByteReader(socket.readable);
    const writer = socket.writable.getWriter();

    async function send(command: string): Promise<string> {
      await writer.write(enc.encode(command + '\r\n'));
      return await lr.readLine();
    }

    // AUTH LOGIN wants base64 of the UTF-8 bytes; btoa() alone throws on any
    // non-Latin1 character in the credential.
    const b64 = (s: string): string => {
      let bin = '';
      for (const byte of enc.encode(s)) bin += String.fromCharCode(byte);
      return btoa(bin);
    };
    // EHLO/Message-ID identify as the sender's own domain (deliverability signal)
    // rather than a fixed platform hostname.
    const senderDomain = (from.split('@')[1] || 'localhost').trim();

    try {
      const greeting = await lr.readLine();
      if (!greeting.startsWith('220')) throw new Error('SMTP greeting failed: ' + greeting);

      let ehloResp = await send('EHLO ' + senderDomain);
      while (!/^250 /.test(ehloResp)) {
        if (/^[45]/.test(ehloResp)) throw new Error('EHLO rejected: ' + ehloResp);
        ehloResp = await lr.readLine();
      }

      const authResp = await send('AUTH LOGIN');
      if (!authResp.startsWith('334')) throw new Error('AUTH LOGIN not offered: ' + authResp);
      await send(b64(user));
      const passResp = await send(b64(pass));
      if (!passResp.startsWith('235')) throw new Error('SMTP auth failed: ' + passResp);

      const mailResp = await send('MAIL FROM:<' + from + '>');
      if (!mailResp.startsWith('250')) throw new Error('MAIL FROM rejected: ' + mailResp);
      const rcptResp = await send('RCPT TO:<' + to + '>');
      if (!/^25[01]/.test(rcptResp)) throw new Error('RCPT TO rejected: ' + rcptResp);

      const dataResp = await send('DATA');
      if (!dataResp.startsWith('354')) throw new Error('SMTP DATA rejected: ' + dataResp);

      const messageId = crypto.randomUUID() + '@' + senderDomain;
      let headers = 'From: ' + fromName + ' <' + from + '>\r\n';
      headers += 'To: ' + to + '\r\n';
      headers += 'Subject: ' + subject + '\r\n';
      headers += 'Message-ID: <' + messageId + '>\r\n';
      if (inReplyTo) {
        // Thread the guest's reply back to us: In-Reply-To + References carry the
        // parent id so Gmail/Outlook group the reply into the same conversation.
        headers += 'In-Reply-To: <' + inReplyTo + '>\r\n';
        headers += 'References: <' + inReplyTo + '>\r\n';
      }
      headers += 'MIME-Version: 1.0\r\n';
      headers += 'Content-Type: text/plain; charset=UTF-8\r\n';
      headers += 'Content-Transfer-Encoding: 8bit\r\n';
      headers += 'Date: ' + new Date().toUTCString() + '\r\n';

      await writer.write(enc.encode(headers + '\r\n' + dotStuffBody(body) + '\r\n.\r\n'));
      const sendResp = await lr.readLine();
      if (!sendResp.startsWith('250')) throw new Error('SMTP send failed: ' + sendResp);

      await send('QUIT');
      return { success: true, messageId };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      lr.releaseLock();
      try { writer.releaseLock(); } catch { /* noop */ }
      try { socket.close(); } catch { /* noop */ }
    }
  }
}
