import type {
  AIRequest,
  AIMessage,
  AIContentPart,
  AITextPart,
  AIFilePart,
  AITool,
  AIResponse,
} from './generated/shared/contracts/ai';
import type {
  QueryOptions,
  QueryResult,
  UserContext,
} from './generated/shared/contracts/runtime';

export type * from './generated/shared/contracts/env';
export type * from './generated/shared/contracts/agentic-interface';
export type * from './generated/shared/contracts/jsonrpc';
export type * from './generated/shared/contracts/manifest';
export type * from './generated/shared/contracts/mcp';
export type * from './generated/shared/contracts/sdk';
export type * from './generated/shared/contracts/widget';

declare global {
  const ultralight: UltralightSDK;
  /** Galactic SDK namespace — alias of `ultralight`. Prefer `galactic.*` in new code. */
  const galactic: UltralightSDK;
  const _: LodashLike;
  const uuid: {
    v4(): string;
  };
  const base64: {
    encode(str: string): string;
    decode(str: string): string;
    encodeBytes(bytes: Uint8Array): string;
    decodeBytes(str: string): Uint8Array;
  };
  const hash: {
    sha256(data: string): Promise<string>;
    sha512(data: string): Promise<string>;
    md5(data: string): string;
  };
  const dateFns: DateFnsLike;
  const schema: SchemaBuilder;
  const markdown: MarkdownUtils;
  const str: StringUtils;
  const jwt: JwtUtils;
  const http: HttpUtils;
}




interface UltralightSDK {
  env: Readonly<Record<string, string>>;
  user: UserContext | null;
  isAuthenticated(): boolean;
  requireAuth(): UserContext;
  store(key: string, value: unknown): Promise<void>;
  load<T = unknown>(key: string): Promise<T | null>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  query(prefix: string, options?: QueryOptions): Promise<QueryResult[]>;
  batchStore(items: Array<{ key: string; value: unknown }>): Promise<void>;
  batchLoad(keys: string[]): Promise<Array<{ key: string; value: unknown }>>;
  batchRemove(keys: string[]): Promise<void>;
  remember(key: string, value: unknown): Promise<void>;
  recall<T = unknown>(key: string): Promise<T | null>;
  ai(request: AIRequest): Promise<AIResponse>;
}

interface LodashLike {
  chunk<T>(arr: T[], size: number): T[][];
  compact<T>(arr: (T | null | undefined | false | 0 | '')[]): T[];
  uniq<T>(arr: T[]): T[];
  flatten<T>(arr: (T | T[])[]): T[];
  flattenDeep(arr: unknown[]): unknown[];
  first<T>(arr: T[]): T | undefined;
  last<T>(arr: T[]): T | undefined;
  take<T>(arr: T[], n: number): T[];
  drop<T>(arr: T[], n: number): T[];
  shuffle<T>(arr: T[]): T[];
  sample<T>(arr: T[]): T | undefined;
  sampleSize<T>(arr: T[], n: number): T[];
  sortBy<T>(arr: T[], key: keyof T | ((item: T) => unknown)): T[];
  groupBy<T>(arr: T[], key: keyof T | ((item: T) => string)): Record<string, T[]>;
  keyBy<T>(arr: T[], key: keyof T | ((item: T) => string)): Record<string, T>;
  partition<T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]];
  pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K>;
  omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K>;
  get(obj: unknown, path: string, defaultValue?: unknown): unknown;
  set<T extends object>(obj: T, path: string, value: unknown): T;
  merge<T extends object>(...objects: Partial<T>[]): T;
  cloneDeep<T>(obj: T): T;
  isEmpty(value: unknown): boolean;
  camelCase(str: string): string;
  snakeCase(str: string): string;
  kebabCase(str: string): string;
  capitalize(str: string): string;
  truncate(str: string, length: number, end?: string): string;
  debounce<T extends (...args: unknown[]) => unknown>(fn: T, wait: number): T;
  throttle<T extends (...args: unknown[]) => unknown>(fn: T, wait: number): T;
  random(min: number, max: number): number;
  clamp(num: number, min: number, max: number): number;
  sum(arr: number[]): number;
  mean(arr: number[]): number;
  min(arr: number[]): number;
  max(arr: number[]): number;
  isString(value: unknown): value is string;
  isNumber(value: unknown): value is number;
  isBoolean(value: unknown): value is boolean;
  isArray(value: unknown): value is unknown[];
  isObject(value: unknown): value is object;
  isFunction(value: unknown): value is Function;
  isNil(value: unknown): value is null | undefined;
}

interface DateFnsLike {
  format(date: Date | string | number, formatStr: string): string;
  formatDistance(date: Date | string | number, baseDate?: Date | string | number): string;
  addDays(date: Date | string | number, days: number): Date;
  addHours(date: Date | string | number, hours: number): Date;
  addMinutes(date: Date | string | number, minutes: number): Date;
  startOfDay(date: Date | string | number): Date;
  endOfDay(date: Date | string | number): Date;
  isAfter(date: Date | string | number, dateToCompare: Date | string | number): boolean;
  isBefore(date: Date | string | number, dateToCompare: Date | string | number): boolean;
  isToday(date: Date | string | number): boolean;
  parseISO(dateString: string): Date;
}

interface SchemaBuilder {
  string(): StringSchema;
  number(): NumberSchema;
  boolean(): BooleanSchema;
  array<T>(itemSchema: Schema<T>): ArraySchema<T>;
  object<T extends Record<string, Schema<unknown>>>(shape: T): ObjectSchema<T>;
  optional<T>(innerSchema: Schema<T>): Schema<T | undefined>;
  union<T extends Schema<unknown>[]>(...schemas: T): Schema<T[number] extends Schema<infer U> ? U : never>;
  literal<T extends string | number | boolean>(value: T): Schema<T>;
  enum<T extends string[]>(...values: T): Schema<T[number]>;
  any(): Schema<unknown>;
}

interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: string };
  optional(): Schema<T | undefined>;
  default(defaultValue: T): Schema<T>;
}

interface StringSchema extends Schema<string> {
  min(length: number): StringSchema;
  max(length: number): StringSchema;
  length(length: number): StringSchema;
  regex(pattern: RegExp): StringSchema;
  email(): StringSchema;
  url(): StringSchema;
}

interface NumberSchema extends Schema<number> {
  min(value: number): NumberSchema;
  max(value: number): NumberSchema;
  int(): NumberSchema;
  positive(): NumberSchema;
  negative(): NumberSchema;
}

interface BooleanSchema extends Schema<boolean> {}

interface ArraySchema<T> extends Schema<T[]> {
  min(length: number): ArraySchema<T>;
  max(length: number): ArraySchema<T>;
  nonempty(): ArraySchema<T>;
}

interface ObjectSchema<T extends Record<string, Schema<unknown>>> extends Schema<{
  [K in keyof T]: T[K] extends Schema<infer U> ? U : never;
}> {}

interface MarkdownUtils {
  toHtml(md: string): string;
  toText(md: string): string;
}

interface StringUtils {
  slugify(text: string): string;
  pluralize(word: string, count: number, plural?: string): string;
  titleCase(text: string): string;
  escapeHtml(text: string): string;
  unescapeHtml(text: string): string;
  wordCount(text: string): number;
  truncateWords(text: string, count: number, suffix?: string): string;
  random(length: number, charset?: 'alphanumeric' | 'alpha' | 'numeric' | 'hex' | string): string;
}

interface JwtUtils {
  decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null;
  isExpired(token: string): boolean;
  getExpiration(token: string): Date | null;
}

interface HttpUtils {
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
  text(data: string, status?: number, headers?: Record<string, string>): Response;
  html(data: string, status?: number, headers?: Record<string, string>): Response;
  redirect(url: string, status?: number): Response;
  error(message: string, status?: number, details?: unknown): Response;
}

interface UltralightRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  json(): Promise<unknown>;
  text(): Promise<string>;
  formData(): Promise<Record<string, unknown>>;
}

type UltralightApp = (
  container: HTMLElement,
  sdk: UltralightSDK
) => void | Promise<void> | (() => void);

interface UltralightProps {
  sdk: UltralightSDK;
}

export {
  UltralightSDK,
  UserContext,
  AIRequest,
  AIMessage,
  AIContentPart,
  AITextPart,
  AIFilePart,
  AITool,
  AIResponse,
  QueryOptions,
  QueryResult,
  LodashLike,
  DateFnsLike,
  SchemaBuilder,
  Schema,
  StringSchema,
  NumberSchema,
  BooleanSchema,
  ArraySchema,
  ObjectSchema,
  MarkdownUtils,
  StringUtils,
  JwtUtils,
  HttpUtils,
  UltralightRequest,
  UltralightApp,
  UltralightProps,
};

export {};
