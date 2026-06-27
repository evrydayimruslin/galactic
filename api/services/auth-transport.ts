import { createServerLogger } from './logging.ts';

export type LegacyAuthTransportKind =
  | 'query_token_used'
  | 'query_token_rejected'
  | 'tokenized_url_generated'
  | 'body_token_bootstrap';

export type LegacyAuthTokenShape =
  | 'api_token'
  | 'jwt'
  | 'opaque'
  | 'missing';

export interface LegacyAuthTransportLogInput {
  kind: LegacyAuthTransportKind;
  surface: string;
  request?: Request;
  path?: string;
  method?: string;
  token?: string | null;
  isEmbed?: boolean;
  note?: string;
}

export function classifyLegacyAuthTokenShape(token: string | null | undefined): LegacyAuthTokenShape {
  if (!token) return 'missing';
  if (token.startsWith('gx_') || token.startsWith('ul_')) return 'api_token';
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return 'jwt';
  return 'opaque';
}

export function buildLegacyAuthTransportLogEntry(
  input: LegacyAuthTransportLogInput,
): Record<string, unknown> {
  const requestPath = input.request ? new URL(input.request.url).pathname : undefined;
  return {
    event: 'legacy_auth_transport',
    kind: input.kind,
    surface: input.surface,
    method: input.method || input.request?.method || 'GET',
    path: input.path || requestPath || '',
    token_shape: classifyLegacyAuthTokenShape(input.token),
    token_length: input.token?.length ?? 0,
    is_embed: input.isEmbed ?? false,
    note: input.note || undefined,
  };
}

export function logLegacyAuthTransport(input: LegacyAuthTransportLogInput): void {
  createServerLogger('AUTH-TRANSPORT').warn(
    'Legacy auth transport observed',
    buildLegacyAuthTransportLogEntry(input),
  );
}
