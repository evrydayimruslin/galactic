// Email-Ops — Ultralight MCP App (v2: IMAP/SMTP Direct)
//
// Version-controlled email thread system. Connects directly to hotel mailbox
// via IMAP (inbound) and SMTP (outbound) using ultralight.net TCP/TLS sockets.
// Every action (draft, edit, regenerate, send, followup) creates a version.
//
// Tables: conversations, versions, conventions, imap_sync_state
// AI: ultralight.ai() with google/gemini-3-flash-preview
// Network: IMAP/SMTP via ultralight.net.connectTls (Cloudflare Workers TCP sockets)
// Widgets: widget_email_inbox_ui (full deck app), widget_email_faqs_ui (FAQ editor)
// Permissions: ai:call, net:fetch, net:connect

const ultralight = (globalThis as typeof globalThis & { ultralight: any }).ultralight;
const AI_MODEL = 'google/gemini-3-flash-preview';

type SqlValue = string | number | boolean | null;
type ConversationClassification =
  | 'inquiry'
  | 'booking_request'
  | 'booking_confirmation'
  | 'cancellation'
  | 'complaint'
  | 'feedback'
  | 'internal'
  | 'spam'
  | 'other';
type ConversationStatus = 'active' | 'resolved' | 'discarded';
type VersionType =
  | 'inbound'
  | 'auto_draft'
  | 'regeneration'
  | 'manual_edit'
  | 'followup_draft'
  | 'sent'
  | 'followup_sent'
  | 'discarded';
type EmailPriority = 'high' | 'normal' | 'low';

interface JsonObject {
  [key: string]: unknown;
}

interface ConventionRow {
  id?: string;
  key: string;
  value: string;
  category: string | null;
  created_at?: string;
  updated_at?: string;
}

interface MaxVersionRow {
  mx: number | null;
}

interface SyncStateRow {
  last_uid: number | null;
}

interface CountRow {
  cnt: number;
}

interface ConversationRow {
  id: string;
  user_id?: string;
  guest_email: string;
  guest_name: string;
  subject: string;
  language: string;
  classification: ConversationClassification;
  status: ConversationStatus;
  message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationWithVersionCountRow extends ConversationRow {
  version_count: number;
}

interface VersionRow {
  id: string;
  conversation_id: string;
  user_id?: string;
  version_num: number;
  type: VersionType;
  body: string;
  actor: string;
  actor_prompt?: string | null;
  model?: string | null;
  metadata?: string | null;
  resend_id?: string | null;
  created_at: string;
}

interface LatestVersionPreviewRow {
  type: VersionType;
  body: string;
  actor: string;
  created_at: string;
}

interface LatestDraftMetadata extends JsonObject {
  knowledge_gaps?: string[];
  priority?: EmailPriority;
  manual_trigger?: boolean;
  sent_to?: string;
  extracted_emails?: string[];
  primary_name?: string | null;
}

interface ParsedVersionRow extends Omit<VersionRow, 'metadata'> {
  metadata: LatestDraftMetadata | null;
}

interface ImapFetchedEmail {
  uid: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  inReplyTo?: string;
}

interface ImapFetchResult {
  emails?: ImapFetchedEmail[];
  maxUid: number;
  hasMore: boolean;
}

interface ReceiveEmailPayload {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  message_id?: string;
  in_reply_to?: string;
}

interface ReceiveEmailArgs extends ReceiveEmailPayload {
  method?: string;
  json?: () => Promise<ReceiveEmailPayload | null>;
  headers?: Headers | Record<string, string | undefined>;
}

interface EmailDraftResponse {
  draft_body: string;
  knowledge_gaps: string[];
}

interface EmailClassificationResponse {
  classification: ConversationClassification;
  language: string;
  should_reply: boolean;
  priority: EmailPriority;
  draft_body: string | null;
  knowledge_gaps: string[];
}

interface ApprovalBridgeRow {
  id: string;
  type: 'email_reply';
  status: 'pending';
  priority: EmailPriority;
  title: string;
  summary: string;
  payload: string;
  created_at: string;
  from_address: string;
  email_subject: string;
  original_body: string;
}

interface EmailInboxItem {
  id: string;
  guest_email: string;
  subject: string;
  language: string;
  classification: ConversationClassification;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
  version_count: number;
  latest_draft: string | null;
  knowledge_gaps: string[];
  inbound_messages: ParsedVersionRow[];
  versions: ParsedVersionRow[];
}

interface EmailInboxWidgetData {
  items: EmailInboxItem[];
  counts: {
    active: number;
    resolved: number;
    discarded: number;
  };
}

interface SocketReadable {
  getReader(): ReadableStreamDefaultReader<Uint8Array>;
}

interface SocketWritable {
  getWriter(): WritableStreamDefaultWriter<Uint8Array>;
}

interface TlsSocket {
  readable: SocketReadable;
  writable: SocketWritable;
  close(): void;
}

interface UltralightNetApi {
  connectTls?: (hostname: string, port: number) => TlsSocket | Promise<TlsSocket>;
  imapFetchUnseen?: (
    host: string,
    port: number,
    user: string,
    password: string,
    lastUid: number,
    businessEmail: string,
    processedFlag: string,
    batchSize: number,
  ) => Promise<ImapFetchResult>;
}

interface GlobalConnectApi {
  connect?: (
    address: { hostname: string; port: number },
    options: { secureTransport: 'on' },
  ) => TlsSocket | Promise<TlsSocket>;
  Deno?: {
    connectTls?: (options: { hostname: string; port: number }) => TlsSocket | Promise<TlsSocket>;
  };
}

const CLASSIFICATIONS = new Set<ConversationClassification>([
  'inquiry',
  'booking_request',
  'booking_confirmation',
  'cancellation',
  'complaint',
  'feedback',
  'internal',
  'spam',
  'other',
]);
const PRIORITIES = new Set<EmailPriority>(['high', 'normal', 'low']);
const DRAFT_VERSION_TYPES = new Set<VersionType>([
  'auto_draft',
  'regeneration',
  'manual_edit',
  'followup_draft',
]);

function getNetApi(): UltralightNetApi | null {
  return (ultralight as unknown as { net?: UltralightNetApi }).net || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string | null | undefined): JsonObject | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    .filter(Boolean);
}

function extractJsonPayload(content: string): string {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match?.[1] || content;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDraftResponse(
  rawContent: string | undefined,
  fallbackDraft: string,
): EmailDraftResponse {
  const parsed = parseJsonObject(extractJsonPayload(rawContent || ''));
  const draftBody = typeof parsed?.draft_body === 'string' && parsed.draft_body.trim()
    ? parsed.draft_body.trim()
    : fallbackDraft;
  return {
    draft_body: draftBody,
    knowledge_gaps: parseStringArray(parsed?.knowledge_gaps),
  };
}

function parseClassificationResponse(
  rawContent: string | undefined,
  fallbackLanguage: string,
): EmailClassificationResponse {
  const parsed = parseJsonObject(extractJsonPayload(rawContent || ''));
  const classification = typeof parsed?.classification === 'string' &&
      CLASSIFICATIONS.has(parsed.classification as ConversationClassification)
    ? parsed.classification as ConversationClassification
    : 'other';
  const priority =
    typeof parsed?.priority === 'string' && PRIORITIES.has(parsed.priority as EmailPriority)
      ? parsed.priority as EmailPriority
      : 'normal';
  const draftBody = typeof parsed?.draft_body === 'string' && parsed.draft_body.trim()
    ? parsed.draft_body.trim()
    : null;
  return {
    classification,
    language: typeof parsed?.language === 'string' && parsed.language.trim()
      ? parsed.language.trim()
      : fallbackLanguage,
    should_reply: Boolean(parsed?.should_reply),
    priority,
    draft_body: draftBody,
    knowledge_gaps: parseStringArray(parsed?.knowledge_gaps),
  };
}

function parseVersionMetadata(text: string | null | undefined): LatestDraftMetadata | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return {
    ...parsed,
    knowledge_gaps: parseStringArray(parsed.knowledge_gaps),
    priority:
      typeof parsed.priority === 'string' && PRIORITIES.has(parsed.priority as EmailPriority)
        ? parsed.priority as EmailPriority
        : undefined,
    sent_to: typeof parsed.sent_to === 'string' ? parsed.sent_to : undefined,
    extracted_emails: parseStringArray(parsed.extracted_emails),
    primary_name: typeof parsed.primary_name === 'string' ? parsed.primary_name : null,
    manual_trigger: Boolean(parsed.manual_trigger),
  };
}

function getHeaderValue(headers: ReceiveEmailArgs['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) || undefined;
  }
  const map = headers as Record<string, string | undefined>;
  return map[name] || map[name.toLowerCase()];
}

function formatThreadContext(
  versions: Array<Pick<VersionRow, 'type' | 'body'>>,
  cleanInbound: boolean,
): string {
  return versions.map((version) => {
    const body = cleanInbound && version.type === 'inbound'
      ? cleanEmailBody(version.body || '').cleaned
      : (version.body || '');
    return (version.type === 'inbound' ? 'Guest: ' : 'You: ') + body;
  }).join('\n---\n');
}

function parseConversationVersions(versions: VersionRow[]): ParsedVersionRow[] {
  return versions.map((version) => ({
    ...version,
    metadata: parseVersionMetadata(version.metadata),
  }));
}

// ── Helpers ──

function now(): string {
  return new Date().toISOString();
}
function uid(): string {
  return ultralight.user.id;
}
function uname(): string {
  return ultralight.user.name || ultralight.user.email || 'admin';
}
function esc(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(
    /"/g,
    '&quot;',
  ).replace(/'/g, '&#39;');
}
function stripHtml(html: string): string {
  if (!html) return '';
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").trim();
}

async function getConventionsText(): Promise<string> {
  const rows = await ultralight.db.all(
    'SELECT key, value, category FROM conventions WHERE user_id = ?',
    [uid()],
  ) as ConventionRow[];
  return rows.length > 0
    ? rows.map((convention) =>
      (convention.category ? '[' + convention.category + '] ' : '') + convention.key + ': ' +
      convention.value
    ).join('\n')
    : 'No business conventions configured yet.';
}

async function nextVersionNum(conversationId: string): Promise<number> {
  const row = await ultralight.db.first(
    'SELECT MAX(version_num) as mx FROM versions WHERE conversation_id = ? AND user_id = ?',
    [conversationId, uid()],
  ) as MaxVersionRow | null;
  return (row?.mx || 0) + 1;
}

// ── TCP/TLS Protocol Helpers ──

const enc = new TextEncoder();
const dec = new TextDecoder();

// Socket connector — tries ultralight.net first, falls back to Deno/CF Workers globals
async function openTlsSocket(hostname: string, port: number): Promise<TlsSocket> {
  const net = getNetApi();
  // Try ultralight.net (SDK-provided, works in both CF Workers and Deno sandboxes)
  if (net?.connectTls) {
    return await net.connectTls(hostname, port);
  }
  const runtimeGlobal = globalThis as unknown as GlobalConnectApi;
  // Fallback: Cloudflare Workers global connect()
  if (typeof runtimeGlobal.connect === 'function') {
    return await runtimeGlobal.connect({ hostname, port }, { secureTransport: 'on' });
  }
  // Fallback: Deno.connectTls (when running in Deno with --allow-all)
  if (runtimeGlobal.Deno?.connectTls) {
    return await runtimeGlobal.Deno.connectTls({ hostname, port });
  }
  throw new Error('No TCP/TLS socket API available. Ensure net:connect permission is declared.');
}

// Line-buffered reader for IMAP/SMTP text protocols
class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = '';

  constructor(readable: SocketReadable) {
    this.reader = readable.getReader();
  }

  async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf('\r\n');
      if (idx >= 0) {
        const line = this.buf.substring(0, idx);
        this.buf = this.buf.substring(idx + 2);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('Connection closed');
      this.buf += dec.decode(value);
    }
  }

  // Read exactly N bytes (for IMAP literals {N})
  async readBytes(n: number): Promise<string> {
    while (this.buf.length < n) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('Connection closed during literal read');
      this.buf += dec.decode(value);
    }
    const result = this.buf.substring(0, n);
    this.buf = this.buf.substring(n);
    return result;
  }

  releaseLock() {
    try {
      this.reader.releaseLock();
    } catch {}
  }
}

// ── SMTP Sender ──

async function sendViaSMTP(
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const host = ultralight.env.SMTP_HOST;
  const port = parseInt(ultralight.env.SMTP_PORT || '465');
  const user = ultralight.env.SMTP_USER;
  const pass = ultralight.env.SMTP_PASS;
  const fromAddr = ultralight.env.BUSINESS_EMAIL || user;
  const bizName = ultralight.env.BUSINESS_NAME || 'Hotel';

  if (!host || !user || !pass || !fromAddr) {
    return { success: false, error: 'SMTP credentials not configured' };
  }

  const socket = await openTlsSocket(host, port);
  const lr = new LineReader(socket.readable);
  const writer = socket.writable.getWriter();

  async function send(cmd: string): Promise<string> {
    await writer.write(enc.encode(cmd + '\r\n'));
    return await lr.readLine();
  }

  try {
    // Read greeting
    const greeting = await lr.readLine();
    if (!greeting.startsWith('220')) throw new Error('SMTP greeting failed: ' + greeting);

    // EHLO
    let resp = await send('EHLO ultralight-api.rgn4jz429m.workers.dev');
    // Read multi-line EHLO response
    while (resp.charAt(3) === '-') resp = await lr.readLine();

    // AUTH LOGIN
    resp = await send('AUTH LOGIN');
    if (!resp.startsWith('334')) throw new Error('AUTH not supported: ' + resp);
    resp = await send(btoa(user));
    if (!resp.startsWith('334')) throw new Error('AUTH user failed: ' + resp);
    resp = await send(btoa(pass));
    if (!resp.startsWith('235')) throw new Error('AUTH failed: ' + resp);

    // MAIL FROM
    resp = await send('MAIL FROM:<' + fromAddr + '>');
    if (!resp.startsWith('250')) throw new Error('MAIL FROM failed: ' + resp);

    // RCPT TO
    resp = await send('RCPT TO:<' + to + '>');
    if (!resp.startsWith('250')) throw new Error('RCPT TO failed: ' + resp);

    // DATA
    resp = await send('DATA');
    if (!resp.startsWith('354')) throw new Error('DATA failed: ' + resp);

    // Build email
    const domain = fromAddr.split('@')[1] || 'ultralight-api.rgn4jz429m.workers.dev';
    const messageId = '<' + crypto.randomUUID() + '@' + domain + '>';
    const boundary = '----=_Part_' + crypto.randomUUID().replace(/-/g, '');
    const htmlBody = body.replace(/\n/g, '<br>');

    let headers = 'From: ' + bizName + ' <' + fromAddr + '>\r\n';
    headers += 'To: ' + to + '\r\n';
    headers += 'Subject: ' + subject + '\r\n';
    headers += 'Date: ' + new Date().toUTCString() + '\r\n';
    headers += 'Message-ID: ' + messageId + '\r\n';
    headers += 'MIME-Version: 1.0\r\n';
    if (inReplyTo) {
      headers += 'In-Reply-To: ' + inReplyTo + '\r\n';
      headers += 'References: ' + inReplyTo + '\r\n';
    }
    headers += 'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n';

    let msg = headers + '\r\n';
    msg += '--' + boundary + '\r\n';
    msg += 'Content-Type: text/plain; charset=UTF-8\r\n\r\n';
    msg += body + '\r\n';
    msg += '--' + boundary + '\r\n';
    msg += 'Content-Type: text/html; charset=UTF-8\r\n\r\n';
    msg += htmlBody + '\r\n';
    msg += '--' + boundary + '--\r\n';

    // Escape leading dots (SMTP transparency)
    msg = msg.replace(/\r\n\./g, '\r\n..');

    await writer.write(enc.encode(msg + '\r\n.\r\n'));
    resp = await lr.readLine();
    if (!resp.startsWith('250')) throw new Error('Send failed: ' + resp);

    await send('QUIT');
    return { success: true, messageId };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  } finally {
    lr.releaseLock();
    try {
      writer.releaseLock();
    } catch {}
    try {
      socket.close();
    } catch {}
  }
}

// ── IMAP Helpers ──

interface ImapCommandResult {
  tag: string;
  lines: string[];
  ok: boolean;
}

interface ImapConnection {
  lr: LineReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  socket: TlsSocket;
  tag: number;
  cmd: (command: string) => Promise<ImapCommandResult>;
}

async function createImapConnection(): Promise<ImapConnection> {
  const host = ultralight.env.IMAP_HOST;
  const port = parseInt(ultralight.env.IMAP_PORT || '993');
  const user = ultralight.env.IMAP_USER;
  const pass = ultralight.env.IMAP_PASS;

  if (!host || !user || !pass) throw new Error('IMAP credentials not configured');

  const socket = await openTlsSocket(host, port);
  const lr = new LineReader(socket.readable);
  const writer = socket.writable.getWriter();
  let tagNum = 0;

  // Read server greeting
  const greeting = await lr.readLine();
  if (!greeting.startsWith('* OK')) throw new Error('IMAP greeting failed: ' + greeting);

  async function cmd(command: string): Promise<ImapCommandResult> {
    tagNum++;
    const tag = 'A' + String(tagNum).padStart(4, '0');
    await writer.write(enc.encode(tag + ' ' + command + '\r\n'));

    const lines: string[] = [];
    while (true) {
      let line = await lr.readLine();

      // Handle IMAP literals: * 1 FETCH (BODY[] {1234}\r\n<1234 bytes>)
      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        const litBytes = parseInt(litMatch[1]);
        const litData = await lr.readBytes(litBytes);
        line += '\r\n' + litData;
        // Read the closing paren line
        const closing = await lr.readLine();
        line += closing;
      }

      if (line.startsWith(tag + ' ')) {
        const ok = line.includes(tag + ' OK');
        return { tag, lines, ok };
      }
      lines.push(line);
    }
  }

  // Login
  const loginResult = await cmd(
    'LOGIN "' + user.replace(/"/g, '\\"') + '" "' + pass.replace(/"/g, '\\"') + '"',
  );
  if (!loginResult.ok) {
    lr.releaseLock();
    try {
      writer.releaseLock();
    } catch {}
    try {
      socket.close();
    } catch {}
    throw new Error('IMAP login failed');
  }

  return { lr, writer, socket, tag: tagNum, cmd };
}

function closeImap(conn: Pick<ImapConnection, 'lr' | 'writer' | 'socket'>) {
  conn.lr.releaseLock();
  try {
    conn.writer.releaseLock();
  } catch {}
  try {
    conn.socket.close();
  } catch {}
}

// ── Email Parser ──

// Charset extraction from a Content-Type header value
function getCharset(contentType: string): string {
  const m = contentType.match(/charset="?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : 'utf-8';
}

// Charset-aware byte decoding with UTF-8 fallback
function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Decode body bytes according to Content-Transfer-Encoding + charset.
// Handles base64, quoted-printable, and 7bit/8bit/binary (ISO-2022-JP etc).
function decodeBody(body: string, transferEncoding: string, charset: string): string {
  const te = (transferEncoding || '').toLowerCase();
  if (te === 'base64') {
    try {
      return decodeBytes(
        Uint8Array.from(atob(body.replace(/\s/g, '')), (c) => c.charCodeAt(0)),
        charset,
      );
    } catch {
      return body;
    }
  }
  if (te === 'quoted-printable') {
    const qp = body.replace(/=\r?\n/g, '').replace(
      /=([0-9A-F]{2})/gi,
      (_: string, h: string) => String.fromCharCode(parseInt(h, 16)),
    );
    if (charset !== 'utf-8') {
      return decodeBytes(new Uint8Array([...qp].map((c) => c.charCodeAt(0))), charset);
    }
    return qp;
  }
  // 7bit / 8bit / binary / none — apply charset if non-UTF-8 (handles ISO-2022-JP)
  if (charset !== 'utf-8') {
    return decodeBytes(new Uint8Array([...body].map((c) => c.charCodeAt(0))), charset);
  }
  return body;
}

function unfoldHeaders(h: string): string {
  return h.replace(/\r\n([ \t])/g, ' ');
}

function getPartHeader(headers: string, name: string): string {
  const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
  const m = headers.match(re);
  return m ? m[1].trim() : '';
}

// Recursive MIME text extractor: handles nested multipart, skips attachments,
// prefers text/plain over text/html, uses per-part charset.
function extractTextFromMime(rawHeaders: string, body: string): string {
  const headers = unfoldHeaders(rawHeaders);
  const ct = getPartHeader(headers, 'Content-Type');
  const cte = getPartHeader(headers, 'Content-Transfer-Encoding').toLowerCase();
  const charset = getCharset(ct);
  const ctLower = ct.toLowerCase();

  if (ctLower.includes('multipart/')) {
    const bMatch = ct.match(/boundary="?([^";\s]+)"?/i);
    if (!bMatch) return '';
    const boundary = bMatch[1];
    const parts = body.split('--' + boundary);

    let plainText = '';
    let htmlText = '';
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === '' || trimmed === '--') continue;
      const phe = part.indexOf('\r\n\r\n');
      if (phe < 0) continue;
      const partHeaders = part.substring(0, phe);
      const partBody = part.substring(phe + 4).replace(/\r?\n$/, '');
      const partCt = getPartHeader(unfoldHeaders(partHeaders), 'Content-Type').toLowerCase();

      // Skip binary attachments
      if (
        partCt.startsWith('application/') || partCt.startsWith('image/') ||
        partCt.startsWith('audio/') || partCt.startsWith('video/')
      ) continue;

      // Recurse into nested multipart
      if (partCt.includes('multipart/')) {
        const nested = extractTextFromMime(partHeaders, partBody);
        if (nested && !plainText) plainText = nested;
        continue;
      }

      const partCte = getPartHeader(unfoldHeaders(partHeaders), 'Content-Transfer-Encoding')
        .toLowerCase();
      const partCharset = getCharset(partCt || ct);

      if (partCt.includes('text/plain') && !plainText) {
        plainText = decodeBody(partBody, partCte, partCharset);
      } else if (partCt.includes('text/html') && !htmlText) {
        htmlText = decodeBody(partBody, partCte, partCharset);
      }
    }

    if (plainText) return plainText;
    if (htmlText) return stripHtml(htmlText);
    return '';
  }

  // Single-part
  const decoded = decodeBody(body, cte, charset);
  if (ctLower.includes('text/html')) {
    return stripHtml(decoded);
  }
  return decoded;
}

function parseEmail(
  raw: string,
): {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo: string;
} {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerBlock = headerEnd > 0 ? raw.substring(0, headerEnd) : raw;
  const bodyBlock = headerEnd > 0 ? raw.substring(headerEnd + 4) : '';

  // Unfold headers (continuation lines start with whitespace)
  const unfolded = unfoldHeaders(headerBlock);

  function getHeader(name: string): string {
    const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
    const m = unfolded.match(re);
    return m ? m[1].trim() : '';
  }

  // Decode RFC 2047 encoded-word with proper charset handling.
  // Per RFC 2047: whitespace between adjacent encoded-words is ignored.
  function decodeWord(s: string): string {
    // Collapse whitespace between adjacent encoded-words before decoding
    const joined = s.replace(/\?=[\s]+=\?/g, '?==?');
    return joined.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
      const cs = charset.toLowerCase();
      if (encoding.toUpperCase() === 'B') {
        try {
          return decodeBytes(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)), cs);
        } catch {
          return text;
        }
      }
      // Quoted-printable
      const qp = text.replace(/_/g, ' ').replace(
        /=([0-9A-F]{2})/gi,
        (__: string, hex: string) => String.fromCharCode(parseInt(hex, 16)),
      );
      if (cs !== 'utf-8') {
        return decodeBytes(new Uint8Array([...qp].map((c) => c.charCodeAt(0))), cs);
      }
      return qp;
    });
  }

  // Extract email address from "Name <addr>" or bare "addr"
  function extractAddr(s: string): string {
    const m = s.match(/<([^>]+)>/);
    return m ? m[1] : s.trim();
  }

  const from = extractAddr(getHeader('From'));
  const to = extractAddr(getHeader('To'));
  const subject = decodeWord(getHeader('Subject'));
  const messageId = getHeader('Message-ID').replace(/[<>]/g, '');
  const inReplyTo = getHeader('In-Reply-To').replace(/[<>]/g, '');

  const textBody = extractTextFromMime(headerBlock, bodyBlock);

  return {
    from,
    to,
    subject: subject || '(no subject)',
    body: textBody.trim(),
    messageId,
    inReplyTo,
  };
}

// ── Staff Reply Detection ──

async function checkSentFolder(guestEmail: string): Promise<boolean> {
  let conn: ImapConnection | null = null;
  try {
    conn = await createImapConnection();

    // Discover sent folder name
    const listResult = await conn.cmd('LIST "" "*"');
    let sentFolder = 'Sent';
    for (const line of listResult.lines) {
      const lower = line.toLowerCase();
      if (lower.includes('\\sent') || lower.includes('"sent"') || lower.includes('sent messages')) {
        const m = line.match(/"([^"]+)"$/);
        if (m) sentFolder = m[1];
      }
    }

    const selResult = await conn.cmd('SELECT "' + sentFolder + '"');
    if (!selResult.ok) return false; // Sent folder not found — assume no reply

    const searchResult = await conn.cmd('UID SEARCH TO "' + guestEmail + '"');
    const uidLine = searchResult.lines.find((l: string) => l.startsWith('* SEARCH'));
    if (uidLine) {
      const uids = uidLine.replace('* SEARCH', '').trim();
      if (uids.length > 0) return true;
    }

    return false;
  } catch {
    return false; // On error, don't block sending
  } finally {
    if (conn) {
      try {
        await conn.cmd('LOGOUT');
      } catch {}
      closeImap(conn);
    }
  }
}

// ============================================
// 0. CHECK INBOX — IMAP Poller
// ============================================

export async function check_inbox(
  args: { debug?: boolean; config_only?: boolean },
): Promise<unknown> {
  try {
    const businessEmail = (ultralight.env.BUSINESS_EMAIL || ultralight.env.IMAP_USER || '')
      .toLowerCase();
    const net = getNetApi();
    if (!net?.imapFetchUnseen) {
      throw new Error('IMAP fetch helper is not available in this runtime');
    }

    // Get last processed UID from DB
    const syncRow = await ultralight.db.first(
      'SELECT last_uid FROM imap_sync_state WHERE user_id = ?',
      [uid()],
    ) as SyncStateRow | null;
    const lastUid = syncRow?.last_uid || 0;

    // Config-only mode: return immediately without IMAP call
    if (args.config_only) {
      return {
        config: {
          host: ultralight.env.IMAP_HOST,
          port: ultralight.env.IMAP_PORT,
          user: ultralight.env.IMAP_USER,
          hasPass: !!ultralight.env.IMAP_PASS,
          passLength: (ultralight.env.IMAP_PASS || '').length,
          businessEmail,
          lastUid,
          smtpHost: ultralight.env.SMTP_HOST,
          smtpPort: ultralight.env.SMTP_PORT,
        },
      };
    }

    // Fetch unseen emails via high-level IMAP RPC (entire TCP session in one call)
    const host = ultralight.env.IMAP_HOST;
    const user = ultralight.env.IMAP_USER;
    const pass = ultralight.env.IMAP_PASS;
    if (!host || !user || !pass) throw new Error('IMAP credentials not configured');

    const result = await net.imapFetchUnseen(
      host,
      parseInt(ultralight.env.IMAP_PORT || '993'),
      user,
      pass,
      lastUid,
      businessEmail,
      '$ULProcessed',
      3,
    );

    // Debug mode: return raw IMAP result without AI processing
    if (args.debug) {
      return {
        success: true,
        debug: true,
        lastUid,
        config: {
          host: ultralight.env.IMAP_HOST,
          port: ultralight.env.IMAP_PORT,
          user: ultralight.env.IMAP_USER,
          hasPass: !!ultralight.env.IMAP_PASS,
          businessEmail,
        },
        imapResult: {
          emailCount: result.emails?.length,
          maxUid: result.maxUid,
          hasMore: result.hasMore,
          emails: (result.emails || []).map((email) => ({
            uid: email.uid,
            from: email.from,
            subject: email.subject,
          })),
        },
      };
    }

    if (!result.emails || result.emails.length === 0) {
      await ultralight.db.run(
        'INSERT INTO imap_sync_state (user_id, last_uid, last_check) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET last_check = ?',
        [uid(), lastUid, now(), now()],
      );
      return { success: true, processed: 0, message: 'No new emails' };
    }

    let processed = 0;
    let newConversations = 0;
    let followups = 0;

    for (const email of result.emails) {
      try {
        const processResult = await receive_email({
          from: email.from,
          to: email.to,
          subject: email.subject,
          text: email.body,
          message_id: email.messageId,
          in_reply_to: email.inReplyTo,
        }) as { success?: boolean; thread?: boolean };

        if (processResult?.success) {
          processed++;
          if (processResult.thread) followups++;
          else newConversations++;
        }
      } catch (error: unknown) {
        console.error('Failed to process email from ' + email.from + ': ' + getErrorMessage(error));
      }
    }

    // Update sync state
    await ultralight.db.run(
      'INSERT INTO imap_sync_state (user_id, last_uid, last_check) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET last_uid = MAX(imap_sync_state.last_uid, ?), last_check = ?',
      [uid(), result.maxUid, now(), result.maxUid, now()],
    );

    return {
      success: true,
      processed,
      new_conversations: newConversations,
      followups,
      has_more: result.hasMore,
    };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

// ── Phase B: Pre-processing + Classification Helpers ──

// Strip quoted replies, forwarded markers, signatures, and common footers
// for cleaner AI input. Returns both cleaned and original — we store original
// for admin reference and feed cleaned to the AI.
function cleanEmailBody(body: string): { cleaned: string; original: string } {
  if (!body) return { cleaned: '', original: '' };
  const original = body;
  let cleaned = body.replace(/\r\n/g, '\n');

  // 1. Strip quoted-reply lines (lines starting with >)
  cleaned = cleaned.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');

  // 2. Find earliest cut point across all markers (protect first 80 chars)
  const cutPatterns = [
    // Forwarded / original message markers
    /^[-—_=]{2,}\s*(?:Forwarded|Original)\s*(?:message|Message)[-—_=\s]*$/m,
    /^-----\s*転送(?:された)?メッセージ\s*-----$/m,
    // "On ... wrote:" reply headers
    /\n\s*On\s[\s\S]{5,120}?\bwrote:\s*\n/i,
    // Outlook-style forwarded headers (From/Sent/To/Subject block)
    /\n\s*From:\s[^\n]+\n\s*(?:Sent|Date):\s[^\n]+\n\s*To:\s[^\n]+\n\s*Subject:\s/i,
    // Signature separators
    /\n-- ?\n/,
    /\n[-_=*#]{10,}\n/,
    /\n\*{5,}\n/,
    // Common footer/disclaimer phrases (English + Japanese)
    /\n\s*Sent from my (?:iPhone|iPad|Android|Galaxy|Samsung)/i,
    /\n\s*CONFIDENTIAL(?:ITY)?\s+NOTICE/i,
    /\n\s*This (?:email|e-mail|message)[^\n.]{0,120}(?:confidential|privileged)/i,
    /\n\s*If you are not the intended recipient/i,
    /\n\s*(?:この|本)(?:メール|メッセージ)は[^\n]{0,100}(?:送信|配信|機密)/,
    /\n\s*本(?:メール|メッセージ)には機密情報/,
  ];

  let cutAt = cleaned.length;
  for (const p of cutPatterns) {
    const m = cleaned.match(p);
    if (m && m.index !== undefined && m.index > 80 && m.index < cutAt) {
      cutAt = m.index;
    }
  }
  cleaned = cleaned.substring(0, cutAt).replace(/\n{3,}/g, '\n\n').trim();

  return { cleaned, original };
}

// Extract guest email addresses from a message body. Runs unconditionally so
// that OTA booking confirmations and contact-form submissions reveal the real
// guest (not the noreply/system sender in the From header).
function extractEmailsFromBody(body: string): { emails: string[]; primaryName: string | null } {
  if (!body) return { emails: [], primaryName: null };

  // Find all email-like strings, dedupe, lowercase
  const allEmails = [
    ...new Set(
      (body.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
        .map((e) => e.toLowerCase()),
    ),
  ];

  // Filter out obvious system/noreply addresses (but keep for fallback)
  const filtered = allEmails.filter((e) =>
    !/(?:noreply|no-reply|donotreply|mailer-daemon|postmaster|bounce|^system@|^admin@|^info@|^support@)/i
      .test(e)
  );

  // Look for a "primary" email via labeled fields (guest form fields)
  const labelPatterns = [
    /(?:reply.?to|返信先)[\s\S]{0,10}?[:：]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    /(?:guest|customer|お客[様さ]ま?|予約者|申込者)[\s\S]{0,80}?(?:e[-\s]?mail|メール(?:アドレス)?)[\s\S]{0,10}?[:：]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    /(?:^|\n)\s*(?:e[-\s]?mail|メール(?:アドレス)?|連絡先)\s*[:：]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
  ];

  let primaryEmail: string | null = null;
  for (const p of labelPatterns) {
    const m = body.match(p);
    if (m) {
      primaryEmail = m[1].trim().toLowerCase();
      break;
    }
  }

  // Look for a labeled guest name
  const namePatterns = [
    /(?:^|\n)\s*(?:name|お名前|氏名|名前|予約者(?:名)?|申込者(?:名)?|ゲスト名)\s*[:：]\s*([^\r\n]{1,80})/i,
  ];
  let primaryName: string | null = null;
  for (const p of namePatterns) {
    const m = body.match(p);
    if (m) {
      primaryName = m[1].trim().replace(/\s*[様さん]$/, '').slice(0, 80);
      break;
    }
  }

  // Put primary first, then rest (deduped)
  let emails = filtered;
  if (primaryEmail) {
    emails = [primaryEmail, ...filtered.filter((e) => e !== primaryEmail)];
  }

  return { emails, primaryName };
}

// Rough language detection via CJK unicode ranges. Hotel context: default to
// 'ja' for any CJK (shared with Chinese but Japanese is far more common here).
function detectLanguage(text: string): string {
  if (!text) return 'en';
  // Hiragana or katakana → strong Japanese signal
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  // CJK unified ideographs → default to ja in hotel context
  if (/[\u4e00-\u9fff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  return 'en';
}

// Pattern for noreply/system/form sender addresses
const NOREPLY_PATTERN =
  /(?:noreply|no-reply|donotreply|mailer-daemon|postmaster|bounce|notification|notify|alert|system|form|mailer|info@forms|webmaster|auto|automated)/i;

// Known OTA / travel agency domains that send booking confirmations
const OTA_DOMAINS = [
  'ikyu.com',
  'jtb.co.jp',
  'rakuten.co.jp',
  'travel.rakuten.co.jp',
  'jalan.net',
  'booking.com',
  'expedia.com',
  'agoda.com',
  'hotels.com',
  'trivago.com',
  'yahoo-travel',
  'ctrip.com',
  'trip.com',
  'yomiuri-ryokou.co.jp',
  'hankyu-travel.com',
  'hankyu.co.jp',
];

// Subject keywords that indicate an automated booking confirmation
const BOOKING_CONFIRMATION_KEYWORDS =
  /(?:confirm(?:ation|ed)?|予約(?:受付|確認|完了)|reservation\s*(?:confirmed|received)|booking\s*(?:confirmed|received)|ご予約|予約番号|予約受付|confirmation\s*number|receipt)/i;

// ============================================
// 1. RECEIVE EMAIL — Webhook + Direct
// ============================================

export async function receive_email(args: ReceiveEmailArgs): Promise<unknown> {
  let from: string, to: string, subject: string, body: string, messageId: string | undefined;

  if (args.method && args.json) {
    const p = await args.json();
    if (!p) return { statusCode: 400, body: { error: 'No payload' } };
    from = p.from || '';
    to = p.to || '';
    subject = p.subject || '';
    body = p.text || stripHtml(p.html || '');
    messageId = p.message_id;
  } else {
    from = args.from || '';
    to = args.to || '';
    subject = args.subject || '';
    body = args.text || stripHtml(args.html || '');
    messageId = args.message_id;
  }

  if (!from || !subject) return { error: 'from and subject are required' };

  // ── Phase B: pre-process body, extract emails, resolve guest identity ──
  const { cleaned: cleanBody, original: originalBody } = cleanEmailBody(body);
  const { emails: bodyEmails, primaryName } = extractEmailsFromBody(originalBody);

  // Resolve guest identity: if the From is a form/noreply/OTA sender AND the
  // body yielded at least one real email, use that as the guest contact.
  // Otherwise fall back to the envelope From.
  const fromLower = from.toLowerCase();
  const fromIsSystem = NOREPLY_PATTERN.test(from) || OTA_DOMAINS.some((d) => fromLower.includes(d));
  const guestEmail = (fromIsSystem && bodyEmails.length > 0) ? bodyEmails[0] : from;
  const guestName = primaryName ||
    ((fromIsSystem && bodyEmails.length > 0) ? bodyEmails[0].split('@')[0] : from.split('@')[0]);

  // Metadata to attach to the inbound version so the widget recipient dropdown
  // can populate from extracted emails (Phase D). Piggybacks on the existing
  // metadata TEXT column — no migration needed.
  const inboundMeta = bodyEmails.length > 0 || primaryName
    ? JSON.stringify({ extracted_emails: bodyEmails, primary_name: primaryName })
    : null;

  // Check for reply threading — match by In-Reply-To or same guest+subject
  const inReplyTo = args.in_reply_to || getHeaderValue(args.headers, 'in-reply-to');
  let existingConvo: ConversationRow | null = null;

  if (inReplyTo) {
    // Try to match by message_id stored on a sent version
    existingConvo = await ultralight.db.first(
      'SELECT c.* FROM conversations c JOIN versions v ON v.conversation_id = c.id WHERE v.resend_id = ? AND c.user_id = ?',
      [inReplyTo, uid()],
    ) as ConversationRow | null;
  }
  if (!existingConvo) {
    // Match by guest email + similar subject. Do the subject comparison in JS
    // rather than SQL LIKE — D1's LIKE has a "pattern too complex" limit that
    // long full-Japanese subjects with special chars (【】：！) reliably trip.
    // Threading uses resolved guestEmail OR raw From so contact-form submissions
    // and direct replies from the same person both match.
    const normalize = (s: string) =>
      (s || '').replace(/^(Re|Fwd|Fw):\s*/gi, '').trim().toLowerCase();
    const cleanSubject = normalize(subject);
    if (cleanSubject) {
      const recent = await ultralight.db.all(
        'SELECT * FROM conversations WHERE user_id = ? AND (guest_email = ? OR guest_email = ?) AND status != ? ORDER BY updated_at DESC LIMIT 20',
        [uid(), guestEmail, from, 'discarded'],
      ) as ConversationRow[];
      existingConvo = recent.find((conversation) => {
        const n = normalize(conversation.subject);
        return n && (n.includes(cleanSubject) || cleanSubject.includes(n));
      }) || null;
    }
  }

  const ts = now();
  const conventionsText = await getConventionsText();

  if (existingConvo) {
    // ── Followup in existing thread ──
    const vNum = await nextVersionNum(existingConvo.id);
    const vId = crypto.randomUUID();
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [vId, existingConvo.id, uid(), vNum, 'inbound', originalBody, guestEmail, inboundMeta, ts],
    );

    // Skip AI draft for internal / booking_confirmation / spam followups —
    // admin can trigger a manual draft via conversation_act('generate_draft').
    const skipAutoDraft = ['internal', 'booking_confirmation', 'spam'].includes(
      existingConvo.classification,
    );
    if (!skipAutoDraft) {
      // Get full thread for context (cleaned bodies for AI input quality)
      const allVersions = await ultralight.db.all(
        'SELECT type, body, actor FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num',
        [existingConvo.id, uid()],
      ) as Array<Pick<VersionRow, 'type' | 'body' | 'actor'>>;
      const threadContext = formatThreadContext(allVersions, true);

      // AI draft followup
      const aiResp = await ultralight.ai({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an email response agent. Draft a followup reply to an ongoing conversation.\n\nBusiness conventions:\n' +
              conventionsText + '\n\nFull thread so far:\n' + threadContext +
              '\n\nRespond with JSON:\n{"draft_body": "your reply", "knowledge_gaps": ["topics not in conventions"]}',
            cache_control: { type: 'ephemeral' },
          },
          { role: 'user', content: 'Latest message from guest:\n' + cleanBody.substring(0, 2000) },
        ],
      });

      const parsed = parseDraftResponse(
        aiResp.content,
        'Thank you for your message. I will get back to you shortly.',
      );

      const draftVId = crypto.randomUUID();
      await ultralight.db.run(
        'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, model, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          draftVId,
          existingConvo.id,
          uid(),
          vNum + 1,
          'auto_draft',
          parsed.draft_body,
          'ai',
          AI_MODEL,
          JSON.stringify({ knowledge_gaps: parsed.knowledge_gaps || [] }),
          ts,
        ],
      );
    }

    await ultralight.db.run(
      'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ['active', ts, existingConvo.id, uid()],
    );

    if (args.method) {
      return {
        statusCode: 200,
        body: { received: true, conversation_id: existingConvo.id, thread: true },
      };
    }
    return {
      success: true,
      conversation_id: existingConvo.id,
      thread: true,
      classification: existingConvo.classification,
      language: existingConvo.language,
    };
  }

  // ── New conversation ──
  const convoId = crypto.randomUUID();

  // Fast-path classification: deterministic rules for internal / OTA emails
  // that don't need AI classification or drafting.
  const businessEmail = ((ultralight.env.BUSINESS_EMAIL as string) || '').toLowerCase();
  const businessDomain = businessEmail.split('@')[1] || '';

  // Internal staff emails from the same domain
  const isInternal = businessDomain && fromLower.endsWith('@' + businessDomain);

  // Booking confirmation: known OTA domain OR noreply-pattern sender with
  // booking-related subject keywords
  const isOtaSender = OTA_DOMAINS.some((d) => fromLower.includes(d));
  const isBookingConfirmation = !isInternal && (
    isOtaSender || (NOREPLY_PATTERN.test(from) && BOOKING_CONFIRMATION_KEYWORDS.test(subject))
  );

  if (isInternal || isBookingConfirmation) {
    const classification = isInternal ? 'internal' : 'booking_confirmation';
    const lang = detectLanguage(subject + '\n' + (cleanBody || originalBody).slice(0, 500));
    console.log(
      '[receive_email] fast-path classification:',
      classification,
      'lang:',
      lang,
      'from:',
      from,
    );

    await ultralight.db.run(
      'INSERT INTO conversations (id, user_id, guest_email, guest_name, subject, language, classification, status, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        convoId,
        uid(),
        guestEmail,
        guestName,
        subject,
        lang,
        classification,
        'active',
        messageId || null,
        ts,
        ts,
      ],
    );
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        convoId,
        uid(),
        1,
        'inbound',
        originalBody,
        guestEmail,
        inboundMeta,
        ts,
      ],
    );
    if (args.method) return { statusCode: 200, body: { received: true, conversation_id: convoId } };
    return {
      success: true,
      conversation_id: convoId,
      classification,
      language: lang,
      action: 'no_reply',
    };
  }

  // ── AI classify + draft ──
  const aiResp = await ultralight.ai({
    model: AI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are an email response agent for a business. Classify inbound emails and draft professional replies.\n\n' +
          'Business conventions:\n' + conventionsText + '\n\n' +
          'Classifications: inquiry | booking_request | booking_confirmation | cancellation | complaint | feedback | internal | spam | other\n\n' +
          'Hints:\n' +
          '- "booking_request" = guest asking to make a NEW reservation (should_reply=true, draft the response)\n' +
          '- "booking_confirmation" = automated confirmation from an OTA/travel agency for an existing booking (should_reply=false)\n' +
          '- "internal" = staff email from within the business (should_reply=false)\n' +
          '- "spam" / "other" that does not need a response → should_reply=false\n' +
          '- Contact-form submissions: classify by content, not by the form sender address\n\n' +
          'Instructions:\n' +
          '1. Classify intent using the enum above\n' +
          '2. Detect language (en, ja, etc.)\n' +
          '3. Draft reply IN THE SAME LANGUAGE as sender (only when should_reply=true)\n' +
          '4. Be warm, professional, accurate\n\n' +
          'Respond with JSON only:\n' +
          '{"classification":"inquiry|booking_request|booking_confirmation|cancellation|complaint|feedback|internal|spam|other","language":"en|ja|etc","should_reply":true/false,"priority":"high|normal|low","draft_body":"full reply text or null","knowledge_gaps":["topics not covered in conventions"]}',
        cache_control: { type: 'ephemeral' },
      },
      {
        role: 'user',
        content: 'From: ' + from + (guestEmail !== from ? '\nGuest: ' + guestEmail : '') +
          '\nSubject: ' + subject + '\n\n' + cleanBody.substring(0, 2000),
      },
    ],
  });

  console.log(
    '[receive_email] AI raw response:',
    JSON.stringify({ content: aiResp.content?.substring(0, 500), error: aiResp.error }),
  );
  const parsed = parseClassificationResponse(aiResp.content, detectLanguage(cleanBody));
  console.log(
    '[receive_email] Parsed:',
    JSON.stringify({
      classification: parsed.classification,
      should_reply: parsed.should_reply,
      has_draft: !!parsed.draft_body,
    }),
  );

  // Force should_reply=false for classifications that never warrant an auto-draft
  const noDraftClasses = ['booking_confirmation', 'internal', 'spam'];
  if (noDraftClasses.includes(parsed.classification)) {
    parsed.should_reply = false;
    parsed.draft_body = null;
  }

  // Create conversation
  await ultralight.db.run(
    'INSERT INTO conversations (id, user_id, guest_email, guest_name, subject, language, classification, status, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      convoId,
      uid(),
      guestEmail,
      guestName,
      subject,
      parsed.language,
      parsed.classification,
      'active',
      messageId || null,
      ts,
      ts,
    ],
  );

  // Version 1: inbound (original body for admin reference, extracted emails in metadata)
  await ultralight.db.run(
    'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), convoId, uid(), 1, 'inbound', originalBody, guestEmail, inboundMeta, ts],
  );

  // Version 2: auto_draft (if should_reply)
  if (parsed.should_reply && parsed.draft_body) {
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, model, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        convoId,
        uid(),
        2,
        'auto_draft',
        parsed.draft_body,
        'ai',
        AI_MODEL,
        JSON.stringify({ knowledge_gaps: parsed.knowledge_gaps || [], priority: parsed.priority }),
        ts,
      ],
    );
  }

  if (args.method) return { statusCode: 200, body: { received: true, conversation_id: convoId } };
  return {
    success: true,
    conversation_id: convoId,
    classification: parsed.classification,
    language: parsed.language,
    action: parsed.should_reply ? 'draft_queued' : 'no_reply',
  };
}

// ============================================
// 2. EMAIL SEND — Outbound via Resend
// ============================================

export async function email_send(
  args: { to: string; subject: string; body: string; in_reply_to?: string },
): Promise<unknown> {
  const { to, subject, body, in_reply_to } = args;
  if (!to || !subject || !body) throw new Error('to, subject, and body are required');
  const result = await sendViaSMTP(to, subject, body, in_reply_to);
  if (!result.success) throw new Error('Email send failed: ' + result.error);
  return { success: true, to, subject, message_id: result.messageId };
}

// ============================================
// 3. CONVERSATION ACTIONS — Send, Discard, Edit, Regenerate, Restore, Followup
// ============================================

export async function conversation_act(args: {
  conversation_id: string;
  action: string;
  body?: string;
  prompt?: string;
  to?: string;
}): Promise<unknown> {
  const { conversation_id, action, body: inputBody, prompt, to: toOverride } = args;
  if (!conversation_id || !action) throw new Error('conversation_id and action are required');

  const convo = await ultralight.db.first(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    [conversation_id, uid()],
  ) as ConversationRow | null;
  if (!convo) throw new Error('Conversation not found');

  const ts = now();
  const actor = uname();

  // Get latest draft version
  const latestDraft = await ultralight.db.first(
    'SELECT * FROM versions WHERE conversation_id = ? AND user_id = ? AND type IN (?, ?, ?, ?) ORDER BY version_num DESC LIMIT 1',
    [conversation_id, uid(), 'auto_draft', 'regeneration', 'manual_edit', 'followup_draft'],
  ) as VersionRow | null;

  if (action === 'send') {
    const bodyToSend = inputBody || latestDraft?.body;
    if (!bodyToSend) throw new Error('No draft to send');

    // Recipient: explicit override (from widget recipient dropdown) > convo guest_email.
    // Validate format so we don't attempt SMTP with garbage.
    const recipient = (toOverride && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toOverride))
      ? toOverride
      : convo.guest_email;

    // Check if staff already replied manually via their inbox
    const staffReplied = await checkSentFolder(recipient);
    if (staffReplied) {
      const vNum = await nextVersionNum(conversation_id);
      await ultralight.db.run(
        "INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, metadata, created_at) VALUES (?, ?, ?, ?, 'discarded', ?, 'system', ?, ?)",
        [
          crypto.randomUUID(),
          conversation_id,
          uid(),
          vNum,
          bodyToSend,
          JSON.stringify({ reason: 'staff_already_replied' }),
          ts,
        ],
      );
      await ultralight.db.run(
        'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        ['resolved', ts, conversation_id, uid()],
      );
      return { success: true, action: 'skipped', reason: 'staff_already_replied', conversation_id };
    }

    const vNum = await nextVersionNum(conversation_id);
    const isSentBefore = !!(await ultralight.db.first(
      "SELECT id FROM versions WHERE conversation_id = ? AND user_id = ? AND type IN ('sent', 'followup_sent')",
      [conversation_id, uid()],
    ));
    const vType = isSentBefore ? 'followup_sent' : 'sent';

    // Send via SMTP through hotel's mail server
    const result = await sendViaSMTP(
      recipient,
      'Re: ' + convo.subject,
      bodyToSend,
      convo.message_id || undefined,
    );
    if (!result.success) throw new Error('Send failed: ' + result.error);

    // Track recipient on the sent version's metadata so the widget can show
    // which address was actually used (useful when admin picks from the dropdown).
    const sendMeta = recipient !== convo.guest_email
      ? JSON.stringify({ sent_to: recipient })
      : null;
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, resend_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        conversation_id,
        uid(),
        vNum,
        vType,
        bodyToSend,
        actor,
        result.messageId || null,
        sendMeta,
        ts,
      ],
    );
    await ultralight.db.run(
      'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ['resolved', ts, conversation_id, uid()],
    );

    return { success: true, action: 'sent', conversation_id, to: recipient };
  }

  if (action === 'discard') {
    await ultralight.db.run(
      'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ['discarded', ts, conversation_id, uid()],
    );
    const vNum = await nextVersionNum(conversation_id);
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        conversation_id,
        uid(),
        vNum,
        'discarded',
        latestDraft?.body || '',
        actor,
        ts,
      ],
    );
    return { success: true, action: 'discarded', conversation_id };
  }

  if (action === 'restore') {
    if (convo.status !== 'discarded') {
      throw new Error('Only discarded conversations can be restored');
    }
    await ultralight.db.run(
      'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ['active', ts, conversation_id, uid()],
    );
    return { success: true, action: 'restored', conversation_id };
  }

  if (action === 'save_edit') {
    if (!inputBody) throw new Error('body is required for save_edit');
    const vNum = await nextVersionNum(conversation_id);
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), conversation_id, uid(), vNum, 'manual_edit', inputBody, actor, ts],
    );
    return { success: true, action: 'saved', conversation_id, version_num: vNum };
  }

  if (action === 'regenerate') {
    const regenPrompt = prompt || 'Rewrite the draft to be better';
    const conventionsText = await getConventionsText();

    // Get full thread for context
    const allVersions = await ultralight.db.all(
      'SELECT type, body, actor FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num',
      [conversation_id, uid()],
    ) as Array<Pick<VersionRow, 'type' | 'body' | 'actor'>>;
    const inboundBodies = allVersions.filter((version) => version.type === 'inbound').map((
      version,
    ) => version.body).join('\n---\n');
    const currentDraft = latestDraft?.body || '';

    const aiResp = await ultralight.ai({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            "You are rewriting a draft email response. Follow the admin's instructions.\n\nBusiness conventions:\n" +
            conventionsText + '\n\nInbound email(s):\n' + inboundBodies + '\n\nCurrent draft:\n' +
            currentDraft +
            '\n\nRespond with JSON:\n{"draft_body": "rewritten email", "knowledge_gaps": ["topics not covered"]}',
          cache_control: { type: 'ephemeral' },
        },
        { role: 'user', content: 'Instruction: ' + regenPrompt },
      ],
    });

    const parsed = parseDraftResponse(aiResp.content, aiResp.content || currentDraft);

    const vNum = await nextVersionNum(conversation_id);
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, actor_prompt, model, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        conversation_id,
        uid(),
        vNum,
        'regeneration',
        parsed.draft_body,
        'ai',
        regenPrompt,
        AI_MODEL,
        JSON.stringify({ knowledge_gaps: parsed.knowledge_gaps || [] }),
        ts,
      ],
    );

    return {
      success: true,
      action: 'regenerated',
      conversation_id,
      version_num: vNum,
      draft_body: parsed.draft_body,
      knowledge_gaps: parsed.knowledge_gaps || [],
    };
  }

  if (action === 'translate') {
    // Ephemeral translation — does NOT create a version. The widget shows the
    // translation inline next to the original body. Default behavior: translate
    // to English unless the text is already English, in which case translate to
    // Japanese (the hotel's staff language). Admin can override via `prompt`
    // (e.g. "translate to Korean").
    if (!inputBody) throw new Error('body is required for translate');
    const instruction = prompt
      ? prompt
      : 'Translate the following text to English. If the text is already in English, translate it to Japanese instead. Output ONLY the translation — no commentary, no quoting, no language label.';
    const aiResp = await ultralight.ai({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: inputBody },
      ],
    });
    const translation = (aiResp.content || '').trim();
    if (!translation) throw new Error('Translation failed: empty response');
    return { success: true, action: 'translated', conversation_id, translation };
  }

  if (action === 'generate_draft') {
    // Manual trigger: admin clicks "Draft Reply" on a card that has no auto-draft
    // (e.g. booking_confirmation, internal, spam, or any case where AI decided
    // should_reply=false). Reuses the same conventions + thread-context + cache
    // as the auto-draft pipeline. Optional `prompt` lets admin steer the draft.
    const conventionsText = await getConventionsText();
    const allVersions = await ultralight.db.all(
      'SELECT type, body, actor FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num',
      [conversation_id, uid()],
    ) as Array<Pick<VersionRow, 'type' | 'body' | 'actor'>>;

    // Prefer cleaned bodies for AI input (same cleanEmailBody used by receive_email)
    const threadContext = formatThreadContext(allVersions, true);

    // Detect followup context — any prior send means this is a followup, not a first draft
    const isFollowup = allVersions.some((version) =>
      version.type === 'sent' || version.type === 'followup_sent'
    );

    const adminInstruction = prompt ? '\n\nAdmin instruction for this draft: ' + prompt : '';

    const systemPrompt = isFollowup
      ? 'You are an email response agent. Draft a followup reply to an ongoing conversation.\n\n' +
        'Business conventions:\n' + conventionsText + '\n\n' +
        'Full thread so far:\n' + threadContext + '\n\n' +
        'Reply in the same language as the guest. Be warm, professional, accurate.' +
        adminInstruction + '\n\n' +
        'Respond with JSON:\n{"draft_body": "your reply", "knowledge_gaps": ["topics not in conventions"]}'
      : 'You are an email response agent for a business. Draft a professional reply to the guest.\n\n' +
        'Business conventions:\n' + conventionsText + '\n\n' +
        'Classification: ' + (convo.classification || 'other') +
        ' (admin manually requested a draft)\n\n' +
        'Reply in the same language as the guest. Be warm, professional, accurate.' +
        adminInstruction + '\n\n' +
        'Respond with JSON:\n{"draft_body": "full reply text", "knowledge_gaps": ["topics not covered in conventions"]}';

    const latestInbound = [...allVersions].reverse().find((version) => version.type === 'inbound');
    const userContent = isFollowup && latestInbound
      ? 'Latest message from guest:\n' +
        cleanEmailBody(latestInbound.body || '').cleaned.substring(0, 2000)
      : 'From: ' + convo.guest_email + '\nSubject: ' + convo.subject + '\n\n' +
        allVersions.filter((version) => version.type === 'inbound').map((version) =>
          cleanEmailBody(version.body || '').cleaned
        ).join('\n---\n').substring(0, 2000);

    const aiResp = await ultralight.ai({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt, cache_control: { type: 'ephemeral' } },
        { role: 'user', content: userContent },
      ],
    });

    const parsed = parseDraftResponse(
      aiResp.content,
      (aiResp.content || '').trim() ||
        'Thank you for your message. I will get back to you shortly.',
    );

    if (!parsed.draft_body) throw new Error('Draft generation failed: no draft_body in response');

    const vNum = await nextVersionNum(conversation_id);
    await ultralight.db.run(
      'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, actor_prompt, model, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        conversation_id,
        uid(),
        vNum,
        isFollowup ? 'followup_draft' : 'auto_draft',
        parsed.draft_body,
        'ai',
        prompt || null,
        AI_MODEL,
        JSON.stringify({ knowledge_gaps: parsed.knowledge_gaps || [], manual_trigger: true }),
        ts,
      ],
    );

    // Nudge the conversation back to active if it was resolved/archived
    if (convo.status !== 'active') {
      await ultralight.db.run(
        'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        ['active', ts, conversation_id, uid()],
      );
    }

    return {
      success: true,
      action: 'draft_generated',
      conversation_id,
      version_num: vNum,
      draft_body: parsed.draft_body,
      knowledge_gaps: parsed.knowledge_gaps || [],
    };
  }

  if (action === 'followup_draft') {
    // Admin initiates a followup on a resolved conversation
    if (prompt) {
      // AI-generated followup
      const conventionsText = await getConventionsText();
      const allVersions = await ultralight.db.all(
        'SELECT type, body FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num',
        [conversation_id, uid()],
      ) as Array<Pick<VersionRow, 'type' | 'body'>>;
      const threadContext = formatThreadContext(allVersions, false);

      const aiResp = await ultralight.ai({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Draft a followup email in an ongoing conversation.\n\nBusiness conventions:\n' +
              conventionsText + '\n\nThread:\n' + threadContext +
              '\n\nRespond with ONLY the email body text.',
            cache_control: { type: 'ephemeral' },
          },
          { role: 'user', content: 'Followup instruction: ' + prompt },
        ],
      });

      const vNum = await nextVersionNum(conversation_id);
      await ultralight.db.run(
        'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, actor_prompt, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          conversation_id,
          uid(),
          vNum,
          'followup_draft',
          aiResp.content || '',
          'ai',
          prompt,
          AI_MODEL,
          ts,
        ],
      );
      await ultralight.db.run(
        'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        ['active', ts, conversation_id, uid()],
      );
      return {
        success: true,
        action: 'followup_drafted',
        conversation_id,
        draft_body: aiResp.content,
      };
    } else if (inputBody) {
      // Manual followup draft
      const vNum = await nextVersionNum(conversation_id);
      await ultralight.db.run(
        'INSERT INTO versions (id, conversation_id, user_id, version_num, type, body, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), conversation_id, uid(), vNum, 'followup_draft', inputBody, actor, ts],
      );
      await ultralight.db.run(
        'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        ['active', ts, conversation_id, uid()],
      );
      return { success: true, action: 'followup_drafted', conversation_id };
    }
    throw new Error('prompt or body required for followup_draft');
  }

  throw new Error('Unknown action: ' + action);
}

// ============================================
// 4. CONVERSATION HISTORY
// ============================================

export async function conversation_history(args: { conversation_id: string }): Promise<unknown> {
  const { conversation_id } = args;
  if (!conversation_id) throw new Error('conversation_id is required');

  const convo = await ultralight.db.first(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    [conversation_id, uid()],
  ) as ConversationRow | null;
  if (!convo) throw new Error('Conversation not found');

  const versions = await ultralight.db.all(
    'SELECT * FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num ASC',
    [conversation_id, uid()],
  ) as VersionRow[];

  return {
    conversation: convo,
    versions: parseConversationVersions(versions),
  };
}

// ============================================
// 5. CONVERSATIONS LIST
// ============================================

export async function conversations_list(args: {
  status?: string;
  limit?: number;
  search?: string;
}): Promise<unknown> {
  const { status, limit, search } = args;

  let sql =
    'SELECT c.*, (SELECT COUNT(*) FROM versions v WHERE v.conversation_id = c.id AND v.user_id = c.user_id) as version_count FROM conversations c WHERE c.user_id = ?';
  const params: SqlValue[] = [uid()];

  if (status) {
    sql += ' AND c.status = ?';
    params.push(status);
  }
  if (search) {
    sql += ' AND (c.guest_email LIKE ? OR c.subject LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }

  sql += ' ORDER BY c.updated_at DESC LIMIT ?';
  params.push(limit || 50);

  const convos = await ultralight.db.all(sql, params) as ConversationWithVersionCountRow[];

  // Get latest version for each conversation
  const result: Array<
    ConversationWithVersionCountRow & { latest_version: LatestVersionPreviewRow | null }
  > = [];
  for (const c of convos) {
    const latest = await ultralight.db.first(
      'SELECT type, body, actor, created_at FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num DESC LIMIT 1',
      [c.id, uid()],
    ) as LatestVersionPreviewRow | null;
    result.push({ ...c, latest_version: latest });
  }

  return { conversations: result, total: result.length };
}

// ============================================
// 6. CONVENTIONS (unchanged)
// ============================================

export async function conventions_get(args: { key?: string; category?: string }): Promise<unknown> {
  const { key, category } = args;
  if (key) {
    const row = await ultralight.db.first(
      'SELECT * FROM conventions WHERE user_id = ? AND key = ?',
      [uid(), key],
    ) as ConventionRow | null;
    return row || { message: 'Convention not found: ' + key };
  }
  let sql = 'SELECT * FROM conventions WHERE user_id = ?';
  const params: SqlValue[] = [uid()];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY category, key';
  return { conventions: await ultralight.db.all(sql, params) as ConventionRow[] };
}

export async function conventions_set(
  args: { key: string; value: string; category?: string },
): Promise<unknown> {
  const { key, value, category } = args;
  if (!key || !value) throw new Error('key and value are required');
  const ts = now();
  const existing = await ultralight.db.first(
    'SELECT id FROM conventions WHERE user_id = ? AND key = ?',
    [uid(), key],
  ) as Pick<ConventionRow, 'id'> | null;
  if (existing) {
    await ultralight.db.run(
      'UPDATE conventions SET value = ?, category = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [value, category || 'general', ts, existing.id, uid()],
    );
    return { success: true, action: 'updated', key };
  }
  const id = crypto.randomUUID();
  await ultralight.db.run(
    'INSERT INTO conventions (id, user_id, key, value, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, uid(), key, value, category || 'general', ts, ts],
  );
  return { success: true, action: 'created', key, id };
}

// ============================================
// 7. LEGACY BRIDGE — approvals_list + approvals_act
//    Maps old API to new conversation model for backward compat
// ============================================

export async function approvals_list(args: { status?: string; limit?: number }): Promise<unknown> {
  const convos = await ultralight.db.all(
    'SELECT * FROM conversations WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?',
    [uid(), 'active', args.limit || 20],
  ) as ConversationRow[];

  const approvals: ApprovalBridgeRow[] = [];
  for (const c of convos) {
    const latestDraft = await ultralight.db.first(
      "SELECT * FROM versions WHERE conversation_id = ? AND user_id = ? AND type IN ('auto_draft','regeneration','manual_edit','followup_draft') ORDER BY version_num DESC LIMIT 1",
      [c.id, uid()],
    ) as VersionRow | null;
    const inbound = await ultralight.db.first(
      "SELECT body FROM versions WHERE conversation_id = ? AND user_id = ? AND type = 'inbound' ORDER BY version_num DESC LIMIT 1",
      [c.id, uid()],
    ) as Pick<VersionRow, 'body'> | null;

    if (latestDraft) {
      const meta = parseVersionMetadata(latestDraft.metadata);
      approvals.push({
        id: c.id,
        type: 'email_reply',
        status: 'pending',
        priority: meta?.priority || 'normal',
        title: 'Reply to: ' + c.subject,
        summary: 'From ' + c.guest_email,
        payload: JSON.stringify({
          to: c.guest_email,
          subject: 'Re: ' + c.subject,
          draft_body: latestDraft.body,
          original_body: inbound?.body || '',
          language: c.language,
          classification: c.classification,
          knowledge_gaps: meta?.knowledge_gaps || [],
        }),
        created_at: c.created_at,
        from_address: c.guest_email,
        email_subject: c.subject,
        original_body: inbound?.body || '',
      });
    }
  }

  return { approvals, total: approvals.length, pending_count: approvals.length };
}

export async function approvals_act(
  args: { approval_id: string; action: string; revision?: string; admin_notes?: string },
): Promise<unknown> {
  // Map old approval_id (which is now conversation_id) to new actions
  const { approval_id: convoId, action, revision } = args;
  if (!convoId || !action) throw new Error('approval_id and action are required');

  if (action === 'approve') return conversation_act({ conversation_id: convoId, action: 'send' });
  if (action === 'reject') return conversation_act({ conversation_id: convoId, action: 'discard' });
  if (action === 'save_draft') {
    return conversation_act({ conversation_id: convoId, action: 'save_edit', body: revision });
  }
  if (action === 'revise' && revision) {
    return conversation_act({ conversation_id: convoId, action: 'save_edit', body: revision });
  }
  if (action === 'regenerate') {
    return conversation_act({
      conversation_id: convoId,
      action: 'regenerate',
      prompt: revision || 'Rewrite the draft',
    });
  }

  throw new Error('Unknown action: ' + action);
}

// ============================================
// 8. WIDGET APP — Full HTML Deck (Email Inbox)
// ============================================

export async function widget_email_inbox_ui(args: {}): Promise<unknown> {
  const countResult = await ultralight.db.first(
    "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'active'",
    [uid()],
  ) as CountRow | null;
  return {
    meta: { title: 'Email Approvals', icon: '📧', badge_count: countResult?.cnt || 0 },
    app_html: DECK_UI_HTML,
    version: '5.0',
  };
}

export async function widget_email_inbox_data(
  args: { view?: string; card_id?: string; data_view?: string },
): Promise<unknown> {
  const view = args.view || 'active';
  const cardView = args.data_view || args.card_id || '';

  if (cardView === 'inbox_volume') {
    const activeCnt = await ultralight.db.first(
      "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'active'",
      [uid()],
    ) as CountRow | null;
    const resolvedCnt = await ultralight.db.first(
      "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'resolved'",
      [uid()],
    ) as CountRow | null;
    const discardedCnt = await ultralight.db.first(
      "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'discarded'",
      [uid()],
    ) as CountRow | null;
    return {
      card_id: 'inbox_volume',
      meta: { title: 'Inbox Volume', icon: 'EO', badge_count: activeCnt?.cnt || 0, status: 'live' },
      body: {
        kind: 'metric',
        metric: activeCnt?.cnt || 0,
        label: 'drafts awaiting your review',
      },
      footer: `${resolvedCnt?.cnt || 0} resolved - ${discardedCnt?.cnt || 0} discarded`,
      updated_at: new Date().toISOString(),
    };
  }

  if (cardView === 'drafts_queue') {
    const activeCnt = await ultralight.db.first(
      "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'active'",
      [uid()],
    ) as CountRow | null;
    const convos = await ultralight.db.all(
      'SELECT guest_name, guest_email, subject, updated_at FROM conversations WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 4',
      [uid(), 'active'],
    ) as Pick<ConversationRow, 'guest_name' | 'guest_email' | 'subject' | 'updated_at'>[];
    return {
      card_id: 'drafts_queue',
      meta: { title: 'Drafts Queue', icon: 'EO', badge_count: activeCnt?.cnt || 0, status: 'live' },
      body: {
        kind: 'list',
        rows: convos.map((conversation) => [
          conversation.guest_name || conversation.guest_email,
          conversation.subject || 'No subject',
          conversation.updated_at,
        ]),
      },
      footer: `${activeCnt?.cnt || 0} active drafts`,
      updated_at: new Date().toISOString(),
    };
  }

  // Active conversations with their full version history
  const convos = await ultralight.db.all(
    'SELECT * FROM conversations WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 50',
    [uid(), view === 'archive' ? 'resolved' : view === 'discarded' ? 'discarded' : 'active'],
  ) as ConversationRow[];

  const items: EmailInboxItem[] = [];
  for (const c of convos) {
    const versions = await ultralight.db.all(
      'SELECT id, version_num, type, body, actor, actor_prompt, model, metadata, resend_id, created_at FROM versions WHERE conversation_id = ? AND user_id = ? ORDER BY version_num ASC',
      [c.id, uid()],
    ) as VersionRow[];

    const parsedVersions = parseConversationVersions(versions);

    // Latest draft for the card
    const latestDraft = [...parsedVersions].reverse().find((version) =>
      DRAFT_VERSION_TYPES.has(version.type)
    );
    // All inbound messages
    const inboundMessages = parsedVersions.filter((version) => version.type === 'inbound');
    // Knowledge gaps from latest draft metadata
    const gaps = latestDraft?.metadata?.knowledge_gaps || [];

    items.push({
      id: c.id,
      guest_email: c.guest_email,
      subject: c.subject,
      language: c.language,
      classification: c.classification,
      status: c.status,
      created_at: c.created_at,
      updated_at: c.updated_at,
      version_count: versions.length,
      latest_draft: latestDraft?.body || null,
      knowledge_gaps: gaps,
      inbound_messages: inboundMessages,
      versions: parsedVersions,
    });
  }

  // Counts per status
  const activeCnt = await ultralight.db.first(
    "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'active'",
    [uid()],
  ) as CountRow | null;
  const resolvedCnt = await ultralight.db.first(
    "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'resolved'",
    [uid()],
  ) as CountRow | null;
  const discardedCnt = await ultralight.db.first(
    "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND status = 'discarded'",
    [uid()],
  ) as CountRow | null;

  return {
    meta: { title: 'Email Approvals', icon: '📧', badge_count: activeCnt?.cnt || 0 },
    items,
    counts: {
      active: activeCnt?.cnt || 0,
      resolved: resolvedCnt?.cnt || 0,
      discarded: discardedCnt?.cnt || 0,
    },
  };
}

// Legacy widget alias for older desktop builds that still expect the single-function contract.
export async function widget_approval_queue(args: {}): Promise<unknown> {
  const data = await widget_email_inbox_data({}) as EmailInboxWidgetData;
  return { badge_count: data.counts?.active || 0, items: [] };
}

// ============================================
// 10. EMAIL FAQs WIDGET — Knowledge Base Editor
// ============================================

export async function widget_email_faqs_ui(args: {}): Promise<unknown> {
  const conventions = await ultralight.db.all(
    'SELECT * FROM conventions WHERE user_id = ? ORDER BY category, key',
    [uid()],
  ) as ConventionRow[];
  return {
    meta: { title: 'Email FAQs', icon: '📋', badge_count: conventions.length },
    app_html: FAQS_UI_HTML,
    version: '1.0',
  };
}

export async function widget_email_faqs_data(args: {}): Promise<unknown> {
  const conventions = await ultralight.db.all(
    "SELECT * FROM conventions WHERE user_id = ? AND category != '_deleted' ORDER BY category, key",
    [uid()],
  ) as ConventionRow[];

  // Aggregate knowledge gaps from recent versions
  const recentGaps = await ultralight.db.all(
    "SELECT metadata FROM versions WHERE user_id = ? AND metadata IS NOT NULL AND type IN ('auto_draft', 'regeneration') ORDER BY created_at DESC LIMIT 100",
    [uid()],
  ) as Array<Pick<VersionRow, 'metadata'>>;

  const gapCounts: Record<string, number> = {};
  for (const row of recentGaps) {
    const meta = parseVersionMetadata(row.metadata);
    for (const gap of meta?.knowledge_gaps || []) {
      const normalized = gap.toLowerCase().trim();
      gapCounts[normalized] = (gapCounts[normalized] || 0) + 1;
    }
  }

  // Sort gaps by frequency
  const gaps = Object.entries(gapCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([gap, count]) => ({ gap, count }));

  // Group conventions by category
  const categories: Record<string, ConventionRow[]> = {};
  for (const c of conventions) {
    const cat = c.category || 'general';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(c);
  }

  return {
    meta: { title: 'Email FAQs', icon: '📋', badge_count: conventions.length },
    categories,
    gaps,
    total: conventions.length,
  };
}

// ============================================
// 11. DECK UI HTML — Full Email Inbox App with Threads + Archive
// ============================================

const DECK_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #f8f9fa; display: flex; flex-direction: column; overflow: hidden; }

  .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #fff; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .header-title { font-size: 15px; font-weight: 600; }
  .header-right { display: flex; align-items: center; gap: 10px; }

  .tabs { display: flex; gap: 2px; background: #f3f4f6; border-radius: 6px; padding: 2px; }
  .tab { padding: 4px 12px; font-size: 12px; font-weight: 500; border-radius: 4px; cursor: pointer; color: #6b7280; border: none; background: none; }
  .tab.active { background: #fff; color: #111; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .tab .cnt { font-size: 10px; background: #e5e7eb; color: #6b7280; padding: 0 5px; border-radius: 8px; margin-left: 3px; }
  .tab.active .cnt { background: #3b82f6; color: #fff; }

  .filter-select { font-size: 12px; padding: 3px 8px; border: 1px solid #d1d5db; border-radius: 5px; background: #fff; color: #374151; cursor: pointer; }

  .deck { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 20px; min-height: 0; overflow-y: auto; }
  .card { width: 100%; max-width: 700px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04); }
  .card-inner { padding: 24px; }
  .card-header { display: flex; justify-content: space-between; align-items: start; }
  .card-from { font-weight: 600; font-size: 14px; }
  .card-badges { display: flex; gap: 6px; margin-top: 4px; }
  .badge { font-size: 11px; color: #6b7280; background: #f3f4f6; padding: 1px 8px; border-radius: 4px; }
  .card-subject { font-size: 16px; font-weight: 500; margin-top: 10px; }

  .btn-refresh { width: 28px; height: 28px; border-radius: 50%; border: 1px solid #d1d5db; background: #fff; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; color: #6b7280; transition: all 0.15s; }
  .btn-refresh:hover { background: #f3f4f6; color: #111; }
  .btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-refresh.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .nav-dots { display: flex; align-items: center; gap: 6px; }
  .nav-arrow { width: 28px; height: 28px; border-radius: 50%; border: 1px solid #d1d5db; background: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #6b7280; }
  .nav-arrow:hover { background: #f3f4f6; }
  .nav-arrow:disabled { opacity: 0.3; cursor: not-allowed; }

  .thread { margin-top: 16px; }
  .thread-toggle { font-size: 12px; color: #3b82f6; cursor: pointer; border: none; background: none; padding: 4px 0; font-weight: 500; }
  .thread-toggle:hover { text-decoration: underline; }
  .thread-msg { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; margin-top: 8px; }
  .thread-msg.guest { background: #fafafa; }
  .thread-msg.you { background: #f0fdf4; border-color: #bbf7d0; }
  .thread-msg-header { font-size: 11px; color: #9ca3af; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .thread-msg-header-right { display: flex; align-items: center; gap: 8px; }
  .thread-msg-body { font-size: 13px; white-space: pre-wrap; color: #374151; }

  /* Phase D: translate toggle */
  .translate-btn { font-size: 10px; padding: 2px 7px; border-radius: 4px; border: 1px solid #d1d5db; background: #fff; color: #6b7280; cursor: pointer; line-height: 1.4; font-family: inherit; }
  .translate-btn:hover { background: #f3f4f6; color: #111; }
  .translate-btn.loading { opacity: 0.6; cursor: wait; }
  .translation-overlay { display: none; margin-top: 6px; padding: 8px 12px; background: #fef3c7; border: 1px solid #fde68a; border-radius: 6px; font-size: 12px; color: #78350f; white-space: pre-wrap; }
  .translation-overlay.visible { display: block; }
  .translation-overlay-label { font-size: 10px; color: #b45309; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; font-weight: 600; }

  /* Phase D: recipient dropdown */
  .recipient-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; }
  .recipient-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; white-space: nowrap; }
  .recipient-select { flex: 1; min-width: 0; font-size: 13px; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 5px; background: #fff; color: #111; cursor: pointer; font-family: inherit; }
  .recipient-custom { flex: 1; font-size: 13px; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 5px; background: #fff; color: #111; display: none; font-family: inherit; }
  .recipient-custom.visible { display: block; }
  .recipient-toggle { font-size: 11px; padding: 4px 8px; border-radius: 5px; border: 1px solid #d1d5db; background: #fff; color: #6b7280; cursor: pointer; font-family: inherit; white-space: nowrap; }
  .recipient-toggle:hover { background: #f3f4f6; color: #111; }

  /* Phase D: no-auto-draft placeholder */
  .section-no-draft { border: 1px dashed #cbd5e1 !important; background: #f9fafb !important; }
  .section-no-draft .section-label { color: #94a3b8 !important; }
  .section-no-draft .section-body { color: #64748b !important; font-style: italic; }
  .no-draft-actions { display: flex; gap: 8px; padding: 4px 14px 12px; align-items: center; }
  .no-draft-prompt { flex: 1; font-size: 12px; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 5px; background: #fff; color: #374151; font-family: inherit; }

  .section { margin-top: 16px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .section-label { font-size: 11px; font-weight: 500; color: #9ca3af; padding: 8px 14px 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .section-body { padding: 4px 14px 12px; white-space: pre-wrap; font-size: 13px; color: #374151; }
  .section-draft { background: #eff6ff; border-color: #bfdbfe; }
  .section-draft .section-label { color: #3b82f6; }
  .section-draft .section-body { color: #1e3a5f; }

  .input-area { width: 100%; border: 1px solid #93c5fd; border-radius: 6px; padding: 8px 12px; font-size: 13px; font-family: inherit; outline: none; background: #fff; color: #1e3a5f; overflow: hidden; }
  .input-area:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(37,99,235,0.1); }

  .gaps { margin-top: 12px; border: 1px solid #fde68a; border-radius: 8px; background: #fffbeb; padding: 10px 14px; }
  .gaps-title { font-size: 11px; font-weight: 600; color: #b45309; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .gap-item { font-size: 12px; color: #92400e; padding: 3px 0; }

  .actions { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  .btn { padding: 8px 16px; font-size: 13px; font-weight: 500; border-radius: 6px; border: 1px solid transparent; cursor: pointer; transition: all 0.15s; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-send { background: #16a34a; color: #fff; }
  .btn-send:hover:not(:disabled) { background: #15803d; }
  .btn-secondary { background: #fff; color: #374151; border-color: #d1d5db; }
  .btn-secondary:hover:not(:disabled) { background: #f3f4f6; }
  .btn-discard { background: #fff; color: #ef4444; border-color: #fca5a5; }
  .btn-discard:hover:not(:disabled) { background: #fef2f2; }
  .btn-restore { background: #fff; color: #16a34a; border-color: #86efac; }
  .btn-restore:hover:not(:disabled) { background: #f0fdf4; }
  .btn-followup { background: #2563eb; color: #fff; }
  .btn-followup:hover:not(:disabled) { background: #1d4ed8; }

  .prompt-section { margin-top: 12px; }
  .prompt-label { font-size: 11px; font-weight: 500; color: #6b7280; text-transform: uppercase; margin-bottom: 4px; }
  .prompt-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }

  .history { margin-top: 16px; }
  .history-toggle { font-size: 12px; color: #6b7280; cursor: pointer; border: none; background: none; font-weight: 500; }
  .history-toggle:hover { color: #3b82f6; }
  .history-item { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f3f4f6; font-size: 12px; }
  .history-num { color: #9ca3af; min-width: 24px; }
  .history-type { font-weight: 500; min-width: 100px; }
  .history-actor { color: #6b7280; }
  .history-time { color: #9ca3af; margin-left: auto; white-space: nowrap; }

  .empty { text-align: center; color: #9ca3af; padding: 60px 20px; }
  .empty-icon { font-size: 48px; margin-bottom: 12px; }

  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; z-index: 100; animation: fadeUp 0.2s; }
  .toast-ok { background: #16a34a; color: #fff; }
  .toast-err { background: #ef4444; color: #fff; }
  @keyframes fadeUp { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <span class="header-title">Email Approvals</span>
    <span id="nav-info" style="font-size:13px;color:#6b7280;"></span>
  </div>
  <div class="header-right">
    <div class="tabs">
      <button class="tab active" data-view="active">Active <span class="cnt" id="cnt-active">0</span></button>
      <button class="tab" data-view="archive">Sent <span class="cnt" id="cnt-resolved">0</span></button>
      <button class="tab" data-view="discarded">Discarded <span class="cnt" id="cnt-discarded">0</span></button>
    </div>
    <select class="filter-select" id="lang-filter"><option value="">All</option></select>
    <button class="btn-refresh" id="refresh-btn" onclick="doRefresh()" title="Check for new emails">↻</button>
    <div class="nav-dots" id="nav-dots"></div>
  </div>
</div>
<div class="deck" id="deck"></div>
<div id="toast-container"></div>

<script>
var items = [], filteredItems = [], currentIdx = 0, currentView = 'active', inputMode = null, loading = true;
var agentActionsRegistered = false;

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ulAction is provided by the bridge SDK injected by the desktop container.
// If running standalone (no bridge), provide a fallback that warns.
if (!window.ulAction) {
  window.ulAction = function(fn, args) {
    console.warn('[DeckUI] No bridge SDK — ulAction(' + fn + ') not available');
    return Promise.reject(new Error('No bridge SDK'));
  };
}

function toast(msg, ok) {
  var el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(function() { el.remove(); }, 3000);
}

function timeAgo(iso) {
  if (!iso) return '';
  var d = new Date(iso), n = Date.now(), s = Math.floor((n - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function typeLabel(t) {
  var map = { inbound: 'Guest email', auto_draft: 'AI draft', regeneration: 'Regenerated', manual_edit: 'Edited', sent: 'Sent', followup_draft: 'Followup draft', followup_sent: 'Followup sent', discarded: 'Discarded' };
  return map[t] || t;
}

function selectedItem() {
  return filteredItems[currentIdx] || null;
}

function latestDraftFor(item) {
  if (!item || !item.versions) return null;
  for (var i = item.versions.length - 1; i >= 0; i--) {
    if (['auto_draft','regeneration','manual_edit','followup_draft'].indexOf(item.versions[i].type) >= 0) {
      return item.versions[i];
    }
  }
  return null;
}

function selectedRecipientFor(item) {
  var selectEl = document.getElementById('recipient-select');
  var customEl = document.getElementById('recipient-custom');
  if (customEl && customEl.classList.contains('visible') && customEl.value.trim()) {
    var recipient = customEl.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('Invalid email: ' + recipient);
    return recipient;
  }
  return selectEl && selectEl.value ? selectEl.value : item.guest_email;
}

function enabledWidgetActions(item) {
  var enabled = ['show_active_view', 'show_sent_view'];
  if (!item) return enabled;
  enabled.push('load_selected_history');
  var latestDraft = latestDraftFor(item);
  if ((item.versions || []).length > 2) enabled.push('open_version_history');
  if (currentView === 'active') {
    enabled.push('discard_selected_conversation');
    if (latestDraft) {
      enabled.push('show_draft_editor');
      enabled.push('show_regenerate_prompt');
      enabled.push('send_selected_draft');
    }
  }
  if (currentView === 'archive') {
    enabled.push('show_followup_prompt');
  }
  return enabled;
}

function buildWidgetAgentSnapshot() {
  var item = selectedItem();
  var latestDraft = latestDraftFor(item);
  var enabledActions = enabledWidgetActions(item);
  var visibleComponents = [
    {
      id: 'tabs',
      type: 'tabs',
      label: 'Conversation views',
      purpose: 'Switch between active, sent, and discarded conversations',
      state: { view: currentView }
    },
    {
      id: 'conversation_card',
      type: 'card',
      label: item ? item.subject : 'No conversation selected',
      purpose: 'Inspect the selected guest conversation',
      actions: enabledActions,
      state: { index: currentIdx, total: filteredItems.length, input_mode: inputMode }
    }
  ];
  if (latestDraft) {
    visibleComponents.push({
      id: 'draft_response',
      type: 'text',
      label: 'Draft response',
      purpose: 'Review the selected draft before sending',
      data_refs: [{ type: 'version', id: latestDraft.id, label: 'Latest draft' }],
      actions: ['show_draft_editor', 'show_regenerate_prompt', 'send_selected_draft'],
      state: { editing: inputMode === 'edit' }
    });
  }
  if ((item && item.versions || []).length > 2) {
    visibleComponents.push({
      id: 'version_history',
      type: 'timeline',
      label: 'Version history',
      purpose: 'Inspect draft and message revisions',
      actions: ['open_version_history'],
      state: { available: true }
    });
  }

  return {
    widget_id: 'email_inbox',
    title: 'Email Approvals',
    summary: item
      ? currentView + ' conversation ' + (currentIdx + 1) + ' of ' + filteredItems.length + ': ' + item.subject
      : currentView + ' view has no visible conversations',
    current_view: currentView,
    selected_entities: item
      ? [{
        type: 'conversation',
        id: item.id,
        label: item.subject,
        table: 'conversations',
        value: {
          guest_email: item.guest_email,
          language: item.language,
          classification: item.classification,
          status: item.status
        }
      }]
      : [],
    visible_components: visibleComponents,
    visible_data_refs: item
      ? [
        { type: 'conversation', id: item.id, label: item.subject, table: 'conversations' },
        latestDraft ? { type: 'version', id: latestDraft.id, label: 'Latest draft', table: 'versions' } : null
      ].filter(Boolean)
      : [],
    pending_edits: inputMode
      ? [{
        field: inputMode === 'edit' ? 'draft_body' : inputMode === 'regen' ? 'regeneration_prompt' : 'followup_prompt',
        label: inputMode === 'edit' ? 'Draft body' : inputMode === 'regen' ? 'Regeneration instructions' : 'Follow up',
        dirty: true,
        entity: item ? { type: 'conversation', id: item.id, label: item.subject } : undefined
      }]
      : [],
    enabled_actions: enabledActions,
    updated_at: new Date().toISOString()
  };
}

function syncWidgetAgentContext() {
  if (!window.ulWidget || typeof window.ulWidget.reportState !== 'function') return;
  window.ulWidget.reportState(buildWidgetAgentSnapshot);
}

async function runConversationActionForSelected(action) {
  var item = selectedItem();
  if (!item) throw new Error('No conversation selected');
  var result = await ulAction('conversation_act', { conversation_id: item.id, action: action });
  inputMode = null;
  await loadData();
  return result;
}

async function sendSelectedDraftAgentically() {
  var item = selectedItem();
  if (!item) throw new Error('No conversation selected');
  if (!latestDraftFor(item)) throw new Error('No draft to send');
  var recipient = selectedRecipientFor(item);
  var args = { conversation_id: item.id, action: 'send' };
  if (recipient && recipient !== item.guest_email) args.to = recipient;
  var result = await ulAction('conversation_act', args);
  inputMode = null;
  await loadData();
  return result;
}

function registerWidgetAction(action, handler) {
  if (!window.ulWidget) return;
  if (typeof window.ulWidget.registerViewAction === 'function' && action.mode === 'ui') {
    window.ulWidget.registerViewAction(action, handler);
    return;
  }
  window.ulWidget.registerAction(action, handler);
}

function setActiveTab(view) {
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.view === view);
  });
}

async function showConversationView(view) {
  currentView = view || 'active';
  currentIdx = 0;
  inputMode = null;
  setActiveTab(currentView);
  await loadData();
  return { view: currentView, selected_count: filteredItems.length };
}

function focusElement(id) {
  var el = document.getElementById(id);
  if (!el) return false;
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  if (typeof el.focus === 'function') el.focus();
  return true;
}

function showDraftEditorAgentically() {
  var item = selectedItem();
  if (!item) throw new Error('No conversation selected');
  if (!latestDraftFor(item)) throw new Error('No draft to edit');
  inputMode = 'edit';
  render();
  var focused = focusElement('edit-area');
  syncWidgetAgentContext();
  return { input_mode: inputMode, focused: focused };
}

function openVersionHistoryAgentically() {
  var item = selectedItem();
  if (!item) throw new Error('No conversation selected');
  render();
  var el = document.getElementById('history-list');
  if (!el) return { opened: false, reason: 'No version history for selected conversation' };
  el.style.display = 'block';
  focusElement('history-list');
  syncWidgetAgentContext();
  return { opened: true };
}

function showRegeneratePromptAgentically(args) {
  var item = selectedItem();
  if (!item) throw new Error('No conversation selected');
  if (!latestDraftFor(item)) throw new Error('No draft to regenerate');
  inputMode = 'regen';
  render();
  var el = document.getElementById('prompt-area');
  var text = args && (args.text || args.prompt || args.value);
  if (el && text) el.value = String(text);
  focusElement('prompt-area');
  syncWidgetAgentContext();
  return { input_mode: inputMode, prefilled: !!text };
}

function showFollowupPromptAgentically(args) {
  var item = selectedItem();
  if (!item) throw new Error('No conversation selected');
  inputMode = 'followup';
  render();
  var el = document.getElementById('followup-area');
  var text = args && (args.text || args.prompt || args.value);
  if (el && text) el.value = String(text);
  focusElement('followup-area');
  syncWidgetAgentContext();
  return { input_mode: inputMode, prefilled: !!text };
}

function registerWidgetAgentActions() {
  if (agentActionsRegistered || !window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  agentActionsRegistered = true;
  registerWidgetAction({
    id: 'load_selected_history',
    label: 'Load selected history',
    description: 'Load the full version history for the currently selected conversation.',
    mode: 'read',
    confirmation: 'none',
    mcp: { function: 'conversation_history' }
  }, async function() {
    var item = selectedItem();
    if (!item) throw new Error('No conversation selected');
    return await ulAction('conversation_history', { conversation_id: item.id });
  });
  registerWidgetAction({
    id: 'show_active_view',
    label: 'Show active conversations',
    description: 'Switch the widget to the active conversation queue.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'navigate', component_id: 'tabs', args_template: { view: 'active' } }
  }, async function(args) {
    return await showConversationView(args.view || 'active');
  });
  registerWidgetAction({
    id: 'show_sent_view',
    label: 'Show sent conversations',
    description: 'Switch the widget to the sent conversation archive.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'navigate', component_id: 'tabs', args_template: { view: 'archive' } }
  }, async function(args) {
    return await showConversationView(args.view || 'archive');
  });
  registerWidgetAction({
    id: 'open_version_history',
    label: 'Open version history',
    description: 'Expand the version history section for the selected conversation.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'open', component_id: 'version_history' }
  }, async function() {
    return openVersionHistoryAgentically();
  });
  registerWidgetAction({
    id: 'show_draft_editor',
    label: 'Show draft editor',
    description: 'Open and focus the editable draft reply field for the selected conversation.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'focus', component_id: 'draft_response' }
  }, async function() {
    return showDraftEditorAgentically();
  });
  registerWidgetAction({
    id: 'show_regenerate_prompt',
    label: 'Show regenerate prompt',
    description: 'Open the regeneration instructions field and optionally prefill quoted text from the request.',
    mode: 'ui',
    confirmation: 'none',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    ui: { command: 'prefill', component_id: 'regenerate_prompt' }
  }, async function(args) {
    return showRegeneratePromptAgentically(args || {});
  });
  registerWidgetAction({
    id: 'show_followup_prompt',
    label: 'Show follow up prompt',
    description: 'Open the follow-up prompt for the selected sent conversation and optionally prefill quoted text.',
    mode: 'ui',
    confirmation: 'none',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    ui: { command: 'prefill', component_id: 'followup_prompt' }
  }, async function(args) {
    return showFollowupPromptAgentically(args || {});
  });
  registerWidgetAction({
    id: 'send_selected_draft',
    label: 'Send selected draft',
    description: 'Send the currently selected draft reply to its selected recipient.',
    mode: 'write',
    confirmation: 'user',
    mcp: { function: 'conversation_act', args_template: { action: 'send' } }
  }, async function() {
    var result = await sendSelectedDraftAgentically();
    toast('Email sent!', true);
    return result;
  });
  registerWidgetAction({
    id: 'discard_selected_conversation',
    label: 'Discard selected conversation',
    description: 'Discard the currently selected conversation from the active queue.',
    mode: 'write',
    confirmation: 'user',
    mcp: { function: 'conversation_act', args_template: { action: 'discard' } }
  }, async function() {
    var result = await runConversationActionForSelected('discard');
    toast('Discarded', true);
    return result;
  });
  syncWidgetAgentContext();
}

async function loadData() {
  try {
    var result = await ulAction('widget_email_inbox_data', { view: currentView === 'archive' ? 'archive' : currentView === 'discarded' ? 'discarded' : 'active' });
    items = result.items || [];
    document.getElementById('cnt-active').textContent = result.counts.active;
    document.getElementById('cnt-resolved').textContent = result.counts.resolved;
    document.getElementById('cnt-discarded').textContent = result.counts.discarded;
    applyFilter();
    loading = false;
    render();
  } catch(e) {
    loading = false;
    document.getElementById('deck').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><div>Failed to load: ' + e.message + '</div></div>';
    syncWidgetAgentContext();
  }
}

async function doRefresh() {
  var btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    var result = await ulAction('check_inbox', {});
    var count = result.processed || 0;
    toast(count > 0 ? count + ' new email' + (count > 1 ? 's' : '') + ' found' : 'No new emails', count > 0);
    if (count > 0) await loadData();
  } catch(e) { toast('Check failed: ' + e.message, false); }
  btn.disabled = false;
  btn.classList.remove('spinning');
}

function applyFilter() {
  var lang = document.getElementById('lang-filter').value;
  filteredItems = lang ? items.filter(function(i) { return i.language === lang; }) : items;
  if (currentIdx >= filteredItems.length) currentIdx = Math.max(0, filteredItems.length - 1);
  updateLangOptions();
}

function updateLangOptions() {
  var sel = document.getElementById('lang-filter');
  var val = sel.value;
  var langs = {};
  items.forEach(function(i) { if (i.language) langs[i.language] = (langs[i.language]||0)+1; });
  var html = '<option value="">All (' + items.length + ')</option>';
  Object.keys(langs).sort().forEach(function(l) { html += '<option value="' + l + '"' + (l===val?' selected':'') + '>' + l + ' (' + langs[l] + ')</option>'; });
  sel.innerHTML = html;
}

function render() {
  if (loading) { document.getElementById('deck').innerHTML = '<div class="empty">Loading...</div>'; syncWidgetAgentContext(); return; }
  if (filteredItems.length === 0) {
    document.getElementById('deck').innerHTML = '<div class="empty"><div class="empty-icon">✅</div><div>' + (currentView === 'active' ? 'All caught up! No pending emails.' : currentView === 'archive' ? 'No sent emails yet.' : 'No discarded emails.') + '</div></div>';
    document.getElementById('nav-dots').innerHTML = '';
    document.getElementById('nav-info').textContent = '';
    syncWidgetAgentContext();
    return;
  }

  var item = filteredItems[currentIdx];
  var versions = item.versions || [];
  var inbounds = versions.filter(function(v) { return v.type === 'inbound'; });
  var latestDraft = null;
  for (var i = versions.length - 1; i >= 0; i--) {
    if (['auto_draft','regeneration','manual_edit','followup_draft'].indexOf(versions[i].type) >= 0) { latestDraft = versions[i]; break; }
  }
  var sentVersions = versions.filter(function(v) { return v.type === 'sent' || v.type === 'followup_sent'; });
  var gaps = latestDraft && latestDraft.metadata ? (latestDraft.metadata.knowledge_gaps || []) : [];

  // Phase D: gather unique recipient candidates from the conversation.
  // Sources (in priority order): guest_email → extracted_emails on inbound
  // metadata → inbound actor fields → sent metadata.sent_to. This powers the
  // recipient dropdown so admin can pick between the envelope From address
  // and any real guest emails the Phase B extractor found in the body.
  var recipientEmails = [];
  var seenRecipients = {};
  function addRecipient(e) {
    if (!e || typeof e !== 'string') return;
    var trimmed = e.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    var key = trimmed.toLowerCase();
    if (seenRecipients[key]) return;
    seenRecipients[key] = true;
    recipientEmails.push(trimmed);
  }
  addRecipient(item.guest_email);
  versions.forEach(function(v) {
    if (v.metadata) {
      if (v.metadata.extracted_emails && v.metadata.extracted_emails.forEach) {
        v.metadata.extracted_emails.forEach(addRecipient);
      }
      if (v.metadata.sent_to) addRecipient(v.metadata.sent_to);
    }
    if (v.type === 'inbound' && v.actor) addRecipient(v.actor);
  });

  var html = '<div class="card"><div class="card-inner">';

  // Header with nav
  html += '<div class="card-header"><div>';
  html += '<div class="card-from">' + esc(item.guest_email) + '</div>';
  html += '<div class="card-badges"><span class="badge">' + esc(item.language || 'en') + '</span><span class="badge">' + esc(item.classification || '') + '</span></div>';
  html += '</div><div class="nav-dots">';
  html += '<button class="nav-arrow" onclick="navigate(-1)" ' + (currentIdx === 0 ? 'disabled' : '') + '>◀</button>';
  html += '<button class="nav-arrow" onclick="navigate(1)" ' + (currentIdx >= filteredItems.length - 1 ? 'disabled' : '') + '>▶</button>';
  html += '</div></div>';
  html += '<div class="card-subject">' + esc(item.subject) + '</div>';

  // Thread view
  if (inbounds.length > 1 || sentVersions.length > 0) {
    var threadMsgs = versions.filter(function(v) { return v.type === 'inbound' || v.type === 'sent' || v.type === 'followup_sent'; });
    html += '<div class="thread"><button class="thread-toggle" onclick="toggleThread()">' + (expandThread ? '▼' : '▶') + ' Thread (' + threadMsgs.length + ' messages)</button>';
    var expandThread = threadMsgs.length > 1;
    html += '<div id="thread-messages" style="display:' + (expandThread ? 'block' : 'none') + ';">';
    threadMsgs.forEach(function(v) {
      var isGuest = v.type === 'inbound';
      var msgKey = 't-' + v.id;
      html += '<div class="thread-msg ' + (isGuest ? 'guest' : 'you') + '">';
      html += '<div class="thread-msg-header"><span>' + (isGuest ? 'Guest' : 'You (' + esc(v.actor) + ')') + '</span>';
      html += '<div class="thread-msg-header-right">';
      html += '<button class="translate-btn" data-msg="' + msgKey + '" onclick="translateMsg(&#39;' + msgKey + '&#39;, this)">🌐 Translate</button>';
      html += '<span>' + timeAgo(v.created_at) + '</span></div></div>';
      html += '<div class="thread-msg-body" id="body-' + msgKey + '">' + esc(v.body) + '</div>';
      html += '<div class="translation-overlay" id="overlay-' + msgKey + '"><div class="translation-overlay-label">Translation</div><div class="translation-overlay-text"></div></div>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Latest inbound (always shown)
  var latestInbound = inbounds[inbounds.length - 1];
  if (latestInbound) {
    html += '<div class="section"><div class="section-label">Original message</div><div class="section-body">' + esc(latestInbound.body) + '</div></div>';
  }

  // Draft section (for active view)
  if (currentView === 'active' && latestDraft) {
    var draftKey = 'draft-' + latestDraft.id;
    html += '<div class="section section-draft">';
    html += '<div class="section-label" style="display:flex;justify-content:space-between;align-items:center;padding-right:14px;">';
    html += '<span>Draft response</span>';
    if (inputMode !== 'edit') {
      html += '<button class="translate-btn" onclick="translateMsg(&#39;' + draftKey + '&#39;, this)">🌐 Translate</button>';
    }
    html += '</div>';
    html += '<div class="section-body" id="draft-display">';
    if (inputMode === 'edit') {
      html += '<textarea class="input-area" id="edit-area">' + esc(latestDraft.body) + '</textarea>';
    } else {
      html += '<div id="body-' + draftKey + '">' + esc(latestDraft.body) + '</div>';
      html += '<div class="translation-overlay" id="overlay-' + draftKey + '"><div class="translation-overlay-label">Translation</div><div class="translation-overlay-text"></div></div>';
    }
    html += '</div></div>';
  } else if (currentView === 'active' && !latestDraft) {
    // Phase D: no-auto-draft placeholder — classification like booking_confirmation,
    // internal, or spam skip auto-drafting. Admin can click "Draft Reply" to run
    // the same AI pipeline on demand via conversation_act('generate_draft').
    var classLabel = item.classification || 'other';
    html += '<div class="section section-draft section-no-draft">';
    html += '<div class="section-label">No auto-draft — ' + esc(classLabel) + '</div>';
    html += '<div class="section-body">This email was classified as "' + esc(classLabel) + '" and no automatic reply was generated. Click "Draft Reply" to generate one on demand.</div>';
    html += '<div class="no-draft-actions">';
    html += '<button class="btn btn-followup" onclick="generateDraft()">Draft Reply</button>';
    html += '<input type="text" class="no-draft-prompt" id="gen-prompt" placeholder="Optional: instructions for the AI (e.g. reply in English, keep it short)" />';
    html += '</div>';
    html += '</div>';
  }

  // Sent version (for archive view)
  if (currentView === 'archive' && sentVersions.length > 0) {
    var lastSent = sentVersions[sentVersions.length - 1];
    html += '<div class="section" style="background:#f0fdf4;border-color:#bbf7d0;"><div class="section-label" style="color:#16a34a;">Sent response</div><div class="section-body">' + esc(lastSent.body) + '</div></div>';
  }

  // Knowledge gaps (read-only — admin manages FAQs in the separate FAQs widget)
  if (gaps.length > 0) {
    html += '<div class="gaps"><div class="gaps-title">⚠ Knowledge gaps</div>';
    gaps.forEach(function(g) {
      html += '<div class="gap-item"><span>• ' + esc(g) + '</span></div>';
    });
    html += '</div>';
  }

  // Prompt input (for regeneration)
  if (inputMode === 'regen') {
    html += '<div class="prompt-section"><div class="prompt-label">Regeneration instructions</div>';
    html += '<textarea class="input-area" id="prompt-area" placeholder="e.g. Make it shorter, add parking info..." style="min-height:48px;border-color:#d1d5db;background:#fff;color:#374151;"></textarea>';
    html += '<div class="prompt-actions"><button class="btn btn-send" onclick="doRegenerate()">Regenerate</button><button class="btn btn-secondary" onclick="cancelInput()">Cancel</button></div></div>';
  }

  // Followup input
  if (inputMode === 'followup') {
    html += '<div class="prompt-section"><div class="prompt-label">Follow up</div>';
    html += '<textarea class="input-area" id="followup-area" placeholder="Write your followup or describe what to say..." style="min-height:80px;border-color:#d1d5db;background:#fff;color:#374151;"></textarea>';
    html += '<div class="prompt-actions"><button class="btn btn-followup" onclick="doFollowup()">Send Followup</button><button class="btn btn-secondary" onclick="doFollowupDraft()">Generate Draft</button><button class="btn btn-secondary" onclick="cancelInput()">Cancel</button></div></div>';
  }

  // Phase D: recipient dropdown (active view only, when we have a draft to send)
  if (currentView === 'active' && latestDraft && inputMode !== 'edit' && inputMode !== 'regen' && inputMode !== 'followup') {
    html += '<div class="recipient-row">';
    html += '<span class="recipient-label">To:</span>';
    html += '<select class="recipient-select" id="recipient-select">';
    recipientEmails.forEach(function(e) {
      var isDefault = e === item.guest_email;
      html += '<option value="' + esc(e) + '"' + (isDefault ? ' selected' : '') + '>' + esc(e) + (isDefault ? ' (default)' : '') + '</option>';
    });
    html += '</select>';
    html += '<input type="email" class="recipient-custom" id="recipient-custom" placeholder="email@example.com" />';
    html += '<button class="recipient-toggle" id="recipient-toggle" onclick="toggleCustomRecipient()">Custom</button>';
    html += '</div>';
  }

  // Actions
  if (!inputMode || inputMode === 'edit') {
    html += '<div class="actions">';
    if (currentView === 'active') {
      if (inputMode === 'edit') {
        html += '<button class="btn btn-send" onclick="doSaveEdit()">Save</button>';
        html += '<button class="btn btn-secondary" onclick="cancelInput()">Cancel</button>';
      } else if (latestDraft) {
        html += '<button class="btn btn-discard" onclick="doAction(&quot;discard&quot;)">Discard</button>';
        html += '<button class="btn btn-secondary" onclick="startEdit()">Edit</button>';
        html += '<button class="btn btn-secondary" onclick="startRegen()">Regenerate</button>';
        html += '<button class="btn btn-send" onclick="doSend()">Send</button>';
      } else {
        // No-draft card: only show Discard (Draft Reply is inside the placeholder)
        html += '<button class="btn btn-discard" onclick="doAction(&quot;discard&quot;)">Discard</button>';
      }
    } else if (currentView === 'archive') {
      html += '<button class="btn btn-followup" onclick="startFollowup()">Follow Up</button>';
    } else if (currentView === 'discarded') {
      html += '<button class="btn btn-restore" onclick="doAction(&quot;restore&quot;)">Restore</button>';
    }
    html += '</div>';
  }

  // Version history
  if (versions.length > 2) {
    html += '<div class="history"><button class="history-toggle" onclick="toggleHistory()">▶ Version history (' + versions.length + ')</button>';
    html += '<div id="history-list" style="display:none;">';
    versions.forEach(function(v) {
      html += '<div class="history-item"><span class="history-num">v' + v.version_num + '</span>';
      html += '<span class="history-type">' + typeLabel(v.type) + '</span>';
      html += '<span class="history-actor">' + esc(v.actor || '') + (v.actor_prompt ? ' — "' + esc(v.actor_prompt.substring(0,40)) + '"' : '') + '</span>';
      html += '<span class="history-time">' + timeAgo(v.created_at) + '</span></div>';
    });
    html += '</div></div>';
  }

  html += '</div></div>';
  document.getElementById('deck').innerHTML = html;
  document.getElementById('nav-info').textContent = (currentIdx + 1) + ' of ' + filteredItems.length;

  // Auto-size edit textarea
  if (inputMode === 'edit') {
    var el = document.getElementById('edit-area');
    if (el) { setTimeout(function() { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; el.focus(); }, 50); }
  }
  if (inputMode === 'regen') { var el = document.getElementById('prompt-area'); if (el) setTimeout(function() { el.focus(); }, 50); }
  if (inputMode === 'followup') { var el = document.getElementById('followup-area'); if (el) setTimeout(function() { el.focus(); }, 50); }
  syncWidgetAgentContext();
}

function navigate(dir) { currentIdx = Math.max(0, Math.min(filteredItems.length - 1, currentIdx + dir)); inputMode = null; render(); }
function toggleThread() { var el = document.getElementById('thread-messages'); if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
function toggleHistory() { var el = document.getElementById('history-list'); if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none'; }

function startEdit() { inputMode = 'edit'; render(); }
function startRegen() { inputMode = 'regen'; render(); }
function startFollowup() { inputMode = 'followup'; render(); }
function cancelInput() { inputMode = null; render(); }

async function doAction(action) {
  var item = filteredItems[currentIdx];
  if (!item) return;
  try {
    await ulAction('conversation_act', { conversation_id: item.id, action: action });
    toast(action === 'send' ? 'Email sent!' : action === 'discard' ? 'Discarded' : action === 'restore' ? 'Restored' : 'Done', true);
    inputMode = null;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

// Phase D: send with recipient selection. Reads from the dropdown or custom
// input and passes it as the "to" override to conversation_act('send').
async function doSend() {
  var item = filteredItems[currentIdx];
  if (!item) return;
  var selectEl = document.getElementById('recipient-select');
  var customEl = document.getElementById('recipient-custom');
  var recipient = null;
  if (customEl && customEl.classList.contains('visible') && customEl.value.trim()) {
    recipient = customEl.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      toast('Invalid email: ' + recipient, false);
      return;
    }
  } else if (selectEl) {
    recipient = selectEl.value;
  }
  try {
    var args = { conversation_id: item.id, action: 'send' };
    if (recipient && recipient !== item.guest_email) args.to = recipient;
    await ulAction('conversation_act', args);
    toast(recipient ? 'Sent to ' + recipient : 'Email sent!', true);
    inputMode = null;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

// Phase D: toggle custom recipient input vs dropdown
function toggleCustomRecipient() {
  var selectEl = document.getElementById('recipient-select');
  var customEl = document.getElementById('recipient-custom');
  var toggleBtn = document.getElementById('recipient-toggle');
  if (!selectEl || !customEl || !toggleBtn) return;
  if (customEl.classList.contains('visible')) {
    customEl.classList.remove('visible');
    selectEl.style.display = '';
    toggleBtn.textContent = 'Custom';
  } else {
    customEl.classList.add('visible');
    selectEl.style.display = 'none';
    toggleBtn.textContent = 'Use list';
    setTimeout(function() { customEl.focus(); }, 50);
  }
}

// Phase D: per-session translation cache (keyed by message id)
if (!window.__transCache) window.__transCache = {};

// Phase D: translate toggle for thread messages and draft body.
// Fetches via conversation_act('translate'), caches per session, toggles visibility.
async function translateMsg(msgKey, btn) {
  var item = filteredItems[currentIdx];
  if (!item) return;
  var overlay = document.getElementById('overlay-' + msgKey);
  var bodyEl = document.getElementById('body-' + msgKey);
  if (!overlay || !bodyEl) return;
  var textEl = overlay.querySelector('.translation-overlay-text');
  if (!textEl) return;

  // Already visible → hide
  if (overlay.classList.contains('visible')) {
    overlay.classList.remove('visible');
    btn.textContent = '🌐 Translate';
    return;
  }

  // Cached → show immediately
  if (window.__transCache[msgKey]) {
    textEl.textContent = window.__transCache[msgKey];
    overlay.classList.add('visible');
    btn.textContent = '🌐 Hide';
    return;
  }

  // Fetch from AI
  var original = bodyEl.textContent || bodyEl.innerText || '';
  if (!original.trim()) return;
  btn.classList.add('loading');
  btn.textContent = '🌐 Translating...';
  btn.disabled = true;
  try {
    var result = await ulAction('conversation_act', {
      conversation_id: item.id,
      action: 'translate',
      body: original,
    });
    var translation = (result && result.translation) ? result.translation : '';
    if (!translation) throw new Error('Empty translation');
    window.__transCache[msgKey] = translation;
    textEl.textContent = translation;
    overlay.classList.add('visible');
    btn.textContent = '🌐 Hide';
  } catch(e) {
    toast('Translation failed: ' + e.message, false);
    btn.textContent = '🌐 Retry';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// Phase D: manual draft generation for no-auto-draft cards.
// Calls conversation_act('generate_draft') with optional admin prompt, then
// refreshes the card — the new draft appears in the normal Draft section with
// all existing Send/Edit/Regenerate controls.
async function generateDraft() {
  var item = filteredItems[currentIdx];
  if (!item) return;
  var promptEl = document.getElementById('gen-prompt');
  var adminPrompt = (promptEl && promptEl.value.trim()) || null;
  var btn = document.querySelector('.section-no-draft .btn-followup');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
  try {
    var args = { conversation_id: item.id, action: 'generate_draft' };
    if (adminPrompt) args.prompt = adminPrompt;
    await ulAction('conversation_act', args);
    toast('Draft generated', true);
    await loadData();
  } catch(e) {
    toast('Draft generation failed: ' + e.message, false);
    if (btn) { btn.disabled = false; btn.textContent = 'Draft Reply'; }
  }
}

async function doSaveEdit() {
  var item = filteredItems[currentIdx];
  var el = document.getElementById('edit-area');
  if (!item || !el) return;
  try {
    await ulAction('conversation_act', { conversation_id: item.id, action: 'save_edit', body: el.value });
    toast('Draft saved', true);
    inputMode = null;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

async function doRegenerate() {
  var item = filteredItems[currentIdx];
  var el = document.getElementById('prompt-area');
  if (!item || !el || !el.value.trim()) return;
  try {
    await ulAction('conversation_act', { conversation_id: item.id, action: 'regenerate', prompt: el.value });
    toast('Regenerated', true);
    inputMode = null;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

async function doFollowup() {
  var item = filteredItems[currentIdx];
  var el = document.getElementById('followup-area');
  if (!item || !el || !el.value.trim()) return;
  try {
    // Direct send as followup
    await ulAction('conversation_act', { conversation_id: item.id, action: 'followup_draft', body: el.value });
    await ulAction('conversation_act', { conversation_id: item.id, action: 'send' });
    toast('Followup sent', true);
    inputMode = null;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

async function doFollowupDraft() {
  var item = filteredItems[currentIdx];
  var el = document.getElementById('followup-area');
  if (!item || !el || !el.value.trim()) return;
  try {
    await ulAction('conversation_act', { conversation_id: item.id, action: 'followup_draft', prompt: el.value });
    toast('Draft generated', true);
    inputMode = null;
    currentView = 'active';
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.view === 'active'); });
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}


// Tab switching
document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    currentView = this.dataset.view;
    currentIdx = 0;
    inputMode = null;
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    this.classList.add('active');
    loadData();
  });
});

// Language filter
document.getElementById('lang-filter').addEventListener('change', function() { currentIdx = 0; applyFilter(); render(); });

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') navigate(-1);
  if (e.key === 'ArrowRight') navigate(1);
});

// Initial load
registerWidgetAgentActions();
loadData();
</script>
</body>
</html>`;

// ============================================
// 12. FAQs UI HTML — Knowledge Base Editor
// ============================================

const FAQS_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #f8f9fa; display: flex; flex-direction: column; overflow-y: auto; }

  .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #fff; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; position: sticky; top: 0; z-index: 10; }
  .header-title { font-size: 15px; font-weight: 600; }
  .header-right { display: flex; align-items: center; gap: 8px; }
  .header-count { font-size: 12px; color: #6b7280; }

  .content { padding: 20px; max-width: 800px; margin: 0 auto; width: 100%; }

  .gaps-section { margin-bottom: 24px; border: 1px solid #fde68a; border-radius: 10px; background: #fffbeb; padding: 16px; }
  .gaps-header { font-size: 13px; font-weight: 600; color: #b45309; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .gap-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #fef3c7; }
  .gap-row:last-child { border-bottom: none; }
  .gap-text { font-size: 13px; color: #92400e; }
  .gap-count { font-size: 11px; color: #b45309; background: #fef3c7; padding: 1px 8px; border-radius: 10px; }

  .category { margin-bottom: 24px; }
  .category-header { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .category-count { font-size: 11px; font-weight: 400; color: #9ca3af; }

  .entry { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; background: #fff; transition: box-shadow 0.15s; }
  .entry:hover { box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .entry-key { font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .entry-value { font-size: 13px; color: #4b5563; white-space: pre-wrap; }
  .entry-actions { display: flex; gap: 6px; }

  .btn-sm { padding: 2px 8px; font-size: 11px; border-radius: 4px; border: 1px solid #d1d5db; background: #fff; color: #374151; cursor: pointer; }
  .btn-sm:hover { background: #f3f4f6; }
  .btn-sm-danger { color: #ef4444; border-color: #fca5a5; }
  .btn-sm-danger:hover { background: #fef2f2; }

  .edit-area { width: 100%; border: 1px solid #93c5fd; border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: inherit; outline: none; resize: vertical; min-height: 60px; }
  .edit-area:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(37,99,235,0.1); }
  .edit-actions { display: flex; gap: 6px; margin-top: 6px; }

  .add-form { border: 1px dashed #d1d5db; border-radius: 8px; padding: 14px; margin-bottom: 8px; background: #fafafa; }
  .add-row { display: flex; gap: 8px; margin-bottom: 6px; }
  .add-input { flex: 1; padding: 6px 10px; font-size: 13px; border: 1px solid #d1d5db; border-radius: 6px; outline: none; font-family: inherit; }
  .add-input:focus { border-color: #3b82f6; }
  .add-select { padding: 6px 10px; font-size: 13px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; }

  .btn { padding: 6px 14px; font-size: 13px; font-weight: 500; border-radius: 6px; border: none; cursor: pointer; }
  .btn-primary { background: #2563eb; color: #fff; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-secondary { background: #fff; color: #374151; border: 1px solid #d1d5db; }
  .btn-secondary:hover { background: #f3f4f6; }

  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; z-index: 100; animation: fadeUp 0.2s; }
  .toast-ok { background: #16a34a; color: #fff; }
  .toast-err { background: #ef4444; color: #fff; }
  @keyframes fadeUp { from { opacity:0; transform:translate(-50%,10px); } to { opacity:1; transform:translate(-50%,0); } }

  .empty { text-align: center; color: #9ca3af; padding: 40px; }
</style>
</head>
<body>
<div class="header">
  <div><span class="header-title">Email FAQs</span></div>
  <div class="header-right">
    <span class="header-count" id="total-count"></span>
    <button class="btn btn-primary" onclick="showAddForm()">+ Add Entry</button>
  </div>
</div>
<div class="content" id="content">
  <div class="empty">Loading...</div>
</div>
<div id="toast-container"></div>

<script>
var data = null, editingId = null, showAdd = false;

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ulAction fallback
if (!window.ulAction) {
  window.ulAction = function() { return Promise.reject(new Error('No bridge')); };
}

function toast(msg, ok) {
  var el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(function() { el.remove(); }, 3000);
}

async function loadData() {
  try {
    data = await ulAction('widget_email_faqs_data', {});
    render();
  } catch(e) {
    document.getElementById('content').innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>';
  }
}

function render() {
  if (!data) return;
  var html = '';
  var categories = data.categories || {};
  var gaps = data.gaps || [];
  var total = data.total || 0;

  document.getElementById('total-count').textContent = total + ' entries';

  // Knowledge gaps from recent emails
  if (gaps.length > 0) {
    html += '<div class="gaps-section"><div class="gaps-header">Suggested topics from recent emails</div>';
    gaps.forEach(function(g) {
      html += '<div class="gap-row"><span class="gap-text">' + esc(g.gap) + '</span><span class="gap-count">' + g.count + 'x mentioned</span></div>';
    });
    html += '</div>';
  }

  // Add form
  if (showAdd) {
    html += '<div class="add-form">';
    html += '<div class="add-row"><input class="add-input" id="add-key" placeholder="Key (e.g. parking_fees)"><select class="add-select" id="add-category">';
    var cats = Object.keys(categories).sort();
    if (cats.length === 0) cats = ['general'];
    cats.forEach(function(c) { html += '<option value="' + esc(c) + '">' + esc(c) + '</option>'; });
    html += '<option value="_new">+ New category</option></select></div>';
    html += '<textarea class="edit-area" id="add-value" placeholder="FAQ content..."></textarea>';
    html += '<div class="edit-actions"><button class="btn btn-primary" onclick="doAdd()">Save</button><button class="btn btn-secondary" onclick="hideAddForm()">Cancel</button></div>';
    html += '</div>';
  }

  // Categories
  var catKeys = Object.keys(categories).sort();
  if (catKeys.length === 0 && gaps.length === 0) {
    html += '<div class="empty">No FAQ entries yet. Click "+ Add Entry" to start building your knowledge base.</div>';
  }

  catKeys.forEach(function(cat) {
    var entries = categories[cat];
    html += '<div class="category"><div class="category-header"><span>' + esc(cat) + '</span><span class="category-count">' + entries.length + ' entries</span></div>';
    entries.forEach(function(entry) {
      if (editingId === entry.id) {
        html += '<div class="entry"><div class="entry-key">' + esc(entry.key) + '</div>';
        html += '<textarea class="edit-area" id="edit-value">' + esc(entry.value) + '</textarea>';
        html += '<div class="edit-actions"><button class="btn btn-primary" onclick="doSave(&quot;' + esc(entry.id) + '&quot;, &quot;' + esc(entry.key) + '&quot;, &quot;' + esc(cat) + '&quot;)">Save</button>';
        html += '<button class="btn btn-secondary" onclick="cancelEdit()">Cancel</button></div></div>';
      } else {
        html += '<div class="entry"><div class="entry-key"><span>' + esc(entry.key) + '</span>';
        html += '<div class="entry-actions"><button class="btn-sm" onclick="startEdit(&quot;' + esc(entry.id) + '&quot;)">Edit</button>';
        html += '<button class="btn-sm btn-sm-danger" onclick="doDelete(&quot;' + esc(entry.key) + '&quot;)">Delete</button></div></div>';
        html += '<div class="entry-value">' + esc(entry.value) + '</div></div>';
      }
    });
    html += '</div>';
  });

  document.getElementById('content').innerHTML = html;

  // Focus edit area if editing
  if (editingId) {
    var el = document.getElementById('edit-value');
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; el.focus(); }
  }
  if (showAdd) {
    var el = document.getElementById('add-key');
    if (el) el.focus();
  }
}

function startEdit(id) { editingId = id; render(); }
function cancelEdit() { editingId = null; render(); }
function showAddForm() { showAdd = true; render(); }
function hideAddForm() { showAdd = false; render(); }

async function doSave(id, key, category) {
  var el = document.getElementById('edit-value');
  if (!el) return;
  try {
    await ulAction('conventions_set', { key: key, value: el.value, category: category });
    toast('Saved', true);
    editingId = null;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

async function doAdd() {
  var key = document.getElementById('add-key').value.trim();
  var value = document.getElementById('add-value').value.trim();
  var catSelect = document.getElementById('add-category');
  var category = catSelect.value;
  if (category === '_new') {
    category = prompt('New category name:');
    if (!category) return;
  }
  if (!key || !value) { toast('Key and value are required', false); return; }
  try {
    await ulAction('conventions_set', { key: key, value: value, category: category });
    toast('Added: ' + key, true);
    showAdd = false;
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

async function doDelete(key) {
  if (!confirm('Delete "' + key + '"?')) return;
  try {
    // Delete by setting empty — conventions_set doesn't have a delete, so we'll need to use db directly
    // For now, just remove from UI by marking with a special value
    await ulAction('conventions_set', { key: key, value: '[DELETED]', category: '_deleted' });
    toast('Deleted: ' + key, true);
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, false); }
}

loadData();
</script>
</body>
</html>`;
