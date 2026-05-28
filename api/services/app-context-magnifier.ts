import { createD1DataService, type D1DataService } from './d1-data.ts';
import { getD1DatabaseId } from './d1-provisioning.ts';
import type { ContextSourceIndexEntry } from './codemode-tools.ts';
import type { WidgetContextRedaction } from '../../shared/contracts/widget.ts';

export interface ContextSourceMagnifyOptions {
  userId: string;
  query?: string;
  maxSources?: number;
  maxRowsPerSource?: number;
  maxChars?: number;
  fetchFn?: typeof fetch;
  databaseIdByApp?: (appId: string) => Promise<string | null>;
}

export interface ContextSourceMagnifyResult {
  context: string;
  sourceCount: number;
  rowCount: number;
  errors: string[];
}

export interface ContextSourceRowsOptions
  extends Pick<
    ContextSourceMagnifyOptions,
    "userId" | "query" | "maxRowsPerSource" | "fetchFn" | "databaseIdByApp"
  > {}

export interface ContextSourceRowsResult {
  source: ContextSourceIndexEntry;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  errors: string[];
}

interface PreparedContextQuery {
  sql: string;
  params: unknown[];
}

const DEFAULT_MAX_SOURCES = 8;
const DEFAULT_MAX_ROWS_PER_SOURCE = 12;
const DEFAULT_MAX_CHARS = 12000;
const MAX_TABLES_PER_SOURCE = 6;
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'from',
  'with',
  'about',
  'my',
  'their',
  'this',
  'that',
  'all',
  'please',
]);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim();
}

export function isSelectOnlyContextQuery(sql: string): boolean {
  const normalized = stripSqlComments(sql);
  if (!normalized) return false;
  if (normalized.includes(';')) return false;
  if (!/^(select|with)\b/i.test(normalized)) return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|pragma|reindex|merge|grant|revoke)\b/i
    .test(normalized);
}

function isSafeSqlIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeSqlIdentifier(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function extractSearchTerms(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(
    query
      .split(/[^A-Za-z0-9_@.-]+/)
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  )].slice(0, 5);
}

export function prepareDeclaredContextQuery(
  source: Pick<ContextSourceIndexEntry, 'id' | 'query'>,
  input: { userId: string; query?: string; limit: number },
): PreparedContextQuery {
  const rawSql = source.query?.trim() || '';
  if (!isSelectOnlyContextQuery(rawSql)) {
    throw new Error(`Context source "${source.id}" query must be SELECT-only`);
  }
  if (rawSql.includes('?')) {
    throw new Error(`Context source "${source.id}" must use named placeholders, not "?"`);
  }
  if (!/[:@$]user_id\b/i.test(rawSql)) {
    throw new Error(`Context source "${source.id}" query must include :user_id`);
  }

  const params: unknown[] = [];
  const sql = rawSql.replace(/[:@$](user_id|query|limit)\b/gi, (_match, name: string) => {
    switch (name.toLowerCase()) {
      case 'user_id':
        params.push(input.userId);
        break;
      case 'query':
        params.push(`%${input.query || ''}%`);
        break;
      case 'limit':
        params.push(input.limit);
        break;
    }
    return '?';
  });

  return { sql, params };
}

function applyRedactions(
  row: Record<string, unknown>,
  redactions: WidgetContextRedaction[] | undefined,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'user_id') continue;

    let nextValue = value;
    for (const redaction of redactions || []) {
      const replacement = redaction.replacement ?? '[redacted]';
      const fieldMatches = !redaction.field || redaction.field === key;
      if (!fieldMatches) continue;

      if (redaction.pattern && typeof nextValue === 'string') {
        try {
          nextValue = nextValue.replace(new RegExp(redaction.pattern, 'g'), replacement);
        } catch {
          // Invalid redaction patterns are ignored at runtime; manifest validation warns earlier.
        }
      } else if (redaction.field) {
        nextValue = replacement;
      }
    }

    output[key] = typeof nextValue === 'string' && nextValue.length > 300
      ? `${nextValue.slice(0, 300)}...`
      : nextValue;
  }
  return output;
}

function formatRows(input: {
  source: ContextSourceIndexEntry;
  table?: string;
  rows: Array<Record<string, unknown>>;
}): string {
  const location = input.table ? ` / ${input.table}` : '';
  let section = `### ${input.source.label} (${input.source.appSlug}:${input.source.id}${location})\n`;
  if (input.source.description) section += `${input.source.description}\n`;
  for (const row of input.rows) {
    section += `${JSON.stringify(applyRedactions(row, input.source.redactions))}\n`;
  }
  return section;
}

async function getD1ForSource(
  source: ContextSourceIndexEntry,
  options: ContextSourceMagnifyOptions,
): Promise<D1DataService | null> {
  const dbId = await (options.databaseIdByApp || getD1DatabaseId)(source.appId);
  if (!dbId) return null;
  return createD1DataService(source.appId, dbId, {
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
}

async function magnifyTableSource(
  d1: D1DataService,
  source: ContextSourceIndexEntry,
  options: Required<Pick<ContextSourceMagnifyOptions, 'userId' | 'maxRowsPerSource'>> & {
    query?: string;
  },
): Promise<{ context: string; rows: number }> {
  const terms = source.searchable === false ? [] : extractSearchTerms(options.query);
  let rowCount = 0;
  let context = '';

  for (const table of (source.tables || []).slice(0, MAX_TABLES_PER_SOURCE)) {
    const tableIdent = quoteIdentifier(table);
    let rows: Array<Record<string, unknown>> = [];
    if (terms.length > 0) {
      const columns = await d1.all<{ name: string; type?: string }>(`PRAGMA table_info(${tableIdent})`);
      const searchableColumns = columns
        .map((column) => column.name)
        .filter((name) =>
          isSafeSqlIdentifier(name) &&
          name !== 'id' &&
          name !== 'user_id' &&
          !name.endsWith('_id') &&
          !name.endsWith('_at')
        )
        .slice(0, 8);

      if (searchableColumns.length > 0) {
        const likeClauses = terms.flatMap(() =>
          searchableColumns.map((column) => `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ?`)
        );
        const params = [
          options.userId,
          ...terms.flatMap((term) => searchableColumns.map(() => `%${term}%`)),
          options.maxRowsPerSource,
        ];
        rows = await d1.all<Record<string, unknown>>(
          `SELECT * FROM ${tableIdent} WHERE user_id = ? AND (${likeClauses.join(' OR ')}) ORDER BY rowid DESC LIMIT ?`,
          params,
        );
      }
    }

    if (rows.length === 0) {
      rows = await d1.all<Record<string, unknown>>(
        `SELECT * FROM ${tableIdent} WHERE user_id = ? ORDER BY rowid DESC LIMIT ?`,
        [options.userId, options.maxRowsPerSource],
      );
    }

    if (rows.length === 0) continue;
    rowCount += rows.length;
    context += formatRows({ source, table, rows }) + '\n';
  }

  return { context: context.trim(), rows: rowCount };
}

export async function readContextSourceRows(
  source: ContextSourceIndexEntry,
  options: ContextSourceRowsOptions,
): Promise<ContextSourceRowsResult> {
  const maxRowsPerSource = options.maxRowsPerSource ?? DEFAULT_MAX_ROWS_PER_SOURCE;
  const errors: string[] = [];
  const rows: Array<Record<string, unknown>> = [];

  if (source.access !== 'read') {
    return { source, rows, rowCount: 0, errors: [`${source.appSlug}:${source.id} is not readable`] };
  }
  if (source.type === 'function') {
    return { source, rows, rowCount: 0, errors: [`${source.appSlug}:${source.id} function sources are not supported for generated interface data`] };
  }

  try {
    const d1 = await getD1ForSource(source, options);
    if (!d1) {
      return { source, rows, rowCount: 0, errors: [`${source.appSlug}:${source.id} has no D1 database`] };
    }

    if (source.type === 'd1_table') {
      const terms = source.searchable === false ? [] : extractSearchTerms(options.query);
      for (const table of (source.tables || []).slice(0, MAX_TABLES_PER_SOURCE)) {
        if (rows.length >= maxRowsPerSource) break;
        const tableIdent = quoteIdentifier(table);
        let tableRows: Array<Record<string, unknown>> = [];
        const remaining = Math.max(1, maxRowsPerSource - rows.length);

        if (terms.length > 0) {
          const columns = await d1.all<{ name: string; type?: string }>(`PRAGMA table_info(${tableIdent})`);
          const searchableColumns = columns
            .map((column) => column.name)
            .filter((name) =>
              isSafeSqlIdentifier(name) &&
              name !== 'id' &&
              name !== 'user_id' &&
              !name.endsWith('_id') &&
              !name.endsWith('_at')
            )
            .slice(0, 8);

          if (searchableColumns.length > 0) {
            const likeClauses = terms.flatMap(() =>
              searchableColumns.map((column) => `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ?`)
            );
            const params = [
              options.userId,
              ...terms.flatMap((term) => searchableColumns.map(() => `%${term}%`)),
              remaining,
            ];
            tableRows = await d1.all<Record<string, unknown>>(
              `SELECT * FROM ${tableIdent} WHERE user_id = ? AND (${likeClauses.join(' OR ')}) ORDER BY rowid DESC LIMIT ?`,
              params,
            );
          }
        }

        if (tableRows.length === 0) {
          tableRows = await d1.all<Record<string, unknown>>(
            `SELECT * FROM ${tableIdent} WHERE user_id = ? ORDER BY rowid DESC LIMIT ?`,
            [options.userId, remaining],
          );
        }

        rows.push(
          ...tableRows.slice(0, remaining).map((row) => ({
            ...applyRedactions(row, source.redactions),
            __table: table,
          })),
        );
      }
    } else {
      const prepared = prepareDeclaredContextQuery(source, {
        userId: options.userId,
        query: options.query,
        limit: maxRowsPerSource,
      });
      const queryRows = await d1.all<Record<string, unknown>>(
        `SELECT * FROM (${prepared.sql}) AS declared_context_source LIMIT ?`,
        [...prepared.params, maxRowsPerSource],
      );
      rows.push(
        ...queryRows
          .slice(0, maxRowsPerSource)
          .map((row) => applyRedactions(row, source.redactions)),
      );
    }
  } catch (err) {
    errors.push(
      `${source.appSlug}:${source.id} ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { source, rows, rowCount: rows.length, errors };
}

async function magnifyQuerySource(
  d1: D1DataService,
  source: ContextSourceIndexEntry,
  options: Required<Pick<ContextSourceMagnifyOptions, 'userId' | 'maxRowsPerSource'>> & {
    query?: string;
  },
): Promise<{ context: string; rows: number }> {
  const prepared = prepareDeclaredContextQuery(source, {
    userId: options.userId,
    query: options.query,
    limit: options.maxRowsPerSource,
  });
  const rows = await d1.all<Record<string, unknown>>(
    `SELECT * FROM (${prepared.sql}) AS declared_context_source LIMIT ?`,
    [...prepared.params, options.maxRowsPerSource],
  );
  return {
    context: rows.length > 0 ? formatRows({ source, rows }) : '',
    rows: rows.length,
  };
}

export async function magnifyContextSources(
  sources: ContextSourceIndexEntry[],
  options: ContextSourceMagnifyOptions,
): Promise<ContextSourceMagnifyResult> {
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
  const maxRowsPerSource = options.maxRowsPerSource ?? DEFAULT_MAX_ROWS_PER_SOURCE;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const sections: string[] = [];
  const errors: string[] = [];
  let sourceCount = 0;
  let rowCount = 0;
  let charCount = 0;

  for (const source of sources.slice(0, maxSources)) {
    if (source.access !== 'read') continue;
    if (source.type === 'function') continue;

    try {
      const d1 = await getD1ForSource(source, options);
      if (!d1) {
        errors.push(`${source.appSlug}:${source.id} has no D1 database`);
        continue;
      }

      const result = source.type === 'd1_table'
        ? await magnifyTableSource(d1, source, {
          userId: options.userId,
          query: options.query,
          maxRowsPerSource,
        })
        : await magnifyQuerySource(d1, source, {
          userId: options.userId,
          query: options.query,
          maxRowsPerSource,
        });

      if (!result.context) continue;
      const next = result.context.slice(0, Math.max(0, maxChars - charCount));
      if (!next) break;
      sections.push(next);
      sourceCount++;
      rowCount += result.rows;
      charCount += next.length;
      if (charCount >= maxChars) break;
    } catch (err) {
      errors.push(
        `${source.appSlug}:${source.id} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    context: sections.join('\n\n'),
    sourceCount,
    rowCount,
    errors,
  };
}
