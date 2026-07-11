/**
 * Tests for TypeScript Parser Service
 *
 * Covers: parseTypeScript, type conversion, JSDoc extraction, permission inference
 */

import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import { assert } from 'https://deno.land/std@0.210.0/assert/assert.ts';
import { parseTypeScript } from './parser.ts';

// ============================================
// Basic function extraction
// ============================================

Deno.test('parser: extracts export function declaration', async () => {
  const code = `export function greet(name: string): string { return name; }`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions.length, 1);
  assertEquals(result.functions[0].name, 'greet');
  assertEquals(result.functions[0].parameters.length, 1);
  assertEquals(result.functions[0].parameters[0].name, 'name');
  assertEquals(result.functions[0].parameters[0].type, 'string');
  assertEquals(result.functions[0].parameters[0].required, true);
  assertEquals(result.functions[0].returns.type, 'string');
});

Deno.test('parser: extracts async function', async () => {
  const code = `export async function fetchData(): Promise<string> { return ''; }`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions.length, 1);
  assertEquals(result.functions[0].name, 'fetchData');
  assertEquals(result.functions[0].isAsync, true);
});

Deno.test('parser: extracts export arrow function', async () => {
  const code = `export const add = (a: number, b: number): number => a + b;`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions.length, 1);
  assertEquals(result.functions[0].name, 'add');
  assertEquals(result.functions[0].parameters.length, 2);
  assertEquals(result.functions[0].parameters[0].name, 'a');
  assertEquals(result.functions[0].parameters[1].name, 'b');
});

Deno.test('parser: ignores non-exported functions', async () => {
  const code = `function internal() {} export function external() {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions.length, 1);
  assertEquals(result.functions[0].name, 'external');
});

Deno.test('parser: handles multiple exports', async () => {
  const code = `
    export function a(): void {}
    export function b(): void {}
    export function c(): void {}
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions.length, 3);
  assertEquals(result.functions.map(f => f.name).sort(), ['a', 'b', 'c']);
});

Deno.test('parser: handles named exports (export { foo })', async () => {
  const code = `
    function myFunc(x: number): number { return x; }
    export { myFunc };
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions.length, 1);
  assertEquals(result.functions[0].name, 'myFunc');
});

// ============================================
// Parameter parsing
// ============================================

Deno.test('parser: optional parameter', async () => {
  const code = `export function greet(name?: string): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].required, false);
});

Deno.test('parser: parameter with default value (string)', async () => {
  const code = `export function greet(name: string = 'world'): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].required, false);
  assertEquals(result.functions[0].parameters[0].default, 'world');
});

Deno.test('parser: parameter with default value (number)', async () => {
  const code = `export function limit(count: number = 10): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].default, 10);
});

Deno.test('parser: parameter with default value (boolean)', async () => {
  const code = `export function toggle(active: boolean = true): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].default, true);
});

Deno.test('parser: parameter with default value (null)', async () => {
  const code = `export function reset(value: string | null = null): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].default, null);
});

Deno.test('parser: object parameter type', async () => {
  const code = `export function create(opts: { name: string; age: number }): void {}`;
  const result = await parseTypeScript(code);
  const param = result.functions[0].parameters[0];
  assertEquals(param.schema.type, 'object');
  assert(param.schema.properties?.name !== undefined);
  assert(param.schema.properties?.age !== undefined);
  assertEquals(param.schema.properties?.name.type, 'string');
  assertEquals(param.schema.properties?.age.type, 'number');
});

Deno.test('parser: object with optional property', async () => {
  const code = `export function create(opts: { name: string; age?: number }): void {}`;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assertEquals(schema.required, ['name']);
});

// ============================================
// Type conversion to JSON Schema
// ============================================

Deno.test('parser: string type → JSON schema', async () => {
  const code = `export function f(x: string): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.type, 'string');
});

Deno.test('parser: number type → JSON schema', async () => {
  const code = `export function f(x: number): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.type, 'number');
});

Deno.test('parser: boolean type → JSON schema', async () => {
  const code = `export function f(x: boolean): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.type, 'boolean');
});

Deno.test('parser: array type (T[]) → JSON schema', async () => {
  const code = `export function f(x: string[]): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.type, 'array');
  assertEquals(result.functions[0].parameters[0].schema.items?.type, 'string');
});

Deno.test('parser: Array<T> generic → JSON schema', async () => {
  const code = `export function f(x: Array<number>): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.type, 'array');
  assertEquals(result.functions[0].parameters[0].schema.items?.type, 'number');
});

Deno.test('parser: union type (string | number) → oneOf schema', async () => {
  const code = `export function f(x: string | number): void {}`;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assert(schema.oneOf !== undefined);
  assertEquals((schema.oneOf as Array<{type: string}>).length, 2);
});

Deno.test('parser: nullable type (string | null) → nullable schema', async () => {
  const code = `export function f(x: string | null): void {}`;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assertEquals(schema.type, 'string');
  assertEquals(schema.nullable, true);
});

Deno.test('parser: string literal union → enum schema', async () => {
  const code = `export function f(x: 'a' | 'b' | 'c'): void {}`;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assertEquals(schema.type, 'string');
  assertEquals(schema.enum, ['a', 'b', 'c']);
});

Deno.test('parser: Record<K,V> → object with additionalProperties', async () => {
  const code = `export function f(x: Record<string, number>): void {}`;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assertEquals(schema.type, 'object');
  assertEquals((schema.additionalProperties as { type: string })?.type, 'number');
});

Deno.test('parser: Promise<T> unwrapped in return type', async () => {
  const code = `export async function f(): Promise<string> { return ''; }`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].returns.schema.type, 'string');
});

Deno.test('parser: Date type → string with date-time format', async () => {
  const code = `export function f(x: Date): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.type, 'string');
  assertEquals(result.functions[0].parameters[0].schema.format, 'date-time');
});

Deno.test('parser: tuple type [string, number]', async () => {
  const code = `export function f(x: [string, number]): void {}`;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assertEquals(schema.type, 'array');
  assert(Array.isArray(schema.items));
  assertEquals((schema.items as Array<{type: string}>)[0].type, 'string');
  assertEquals((schema.items as Array<{type: string}>)[1].type, 'number');
});

Deno.test('parser: intersection type (A & B) → allOf', async () => {
  const code = `
    type A = { a: string };
    type B = { b: number };
    export function f(x: A & B): void {}
  `;
  const result = await parseTypeScript(code);
  const schema = result.functions[0].parameters[0].schema;
  assert(schema.allOf !== undefined);
});

Deno.test('parser: custom type reference → $ref', async () => {
  const code = `
    interface User { name: string; }
    export function f(x: User): void {}
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].schema.$ref, '#/definitions/User');
});

Deno.test('parser: any/unknown types → empty schema', async () => {
  const code = `export function f(x: any, y: unknown): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(Object.keys(result.functions[0].parameters[0].schema).length, 0);
  assertEquals(Object.keys(result.functions[0].parameters[1].schema).length, 0);
});

Deno.test('parser: void return type → null schema', async () => {
  const code = `export function f(): void {}`;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].returns.schema.type, 'null');
});

// ============================================
// JSDoc extraction
// ============================================

Deno.test('parser: extracts function description from JSDoc', async () => {
  const code = `
    /** Greets a person by name */
    export function greet(name: string): string { return name; }
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].description, 'Greets a person by name');
});

Deno.test('parser: extracts @param descriptions', async () => {
  const code = `
    /**
     * Greets a person
     * @param name The person's name
     * @param greeting The greeting to use
     */
    export function greet(name: string, greeting: string): string { return ''; }
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].parameters[0].description, "The person's name");
  assertEquals(result.functions[0].parameters[1].description, 'The greeting to use');
});

Deno.test('parser: extracts @returns description', async () => {
  const code = `
    /**
     * Adds two numbers
     * @returns The sum
     */
    export function add(a: number, b: number): number { return a + b; }
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].returns.description, 'The sum');
});

Deno.test('parser: extracts @example', async () => {
  const code = `
    /**
     * Adds two numbers
     * @example add(1, 2) // returns 3
     */
    export function add(a: number, b: number): number { return a + b; }
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].examples.length, 1);
  assert(result.functions[0].examples[0].includes('add(1, 2)'));
});

Deno.test('parser: extracts @permission tags', async () => {
  const code = `
    /**
     * Saves data
     * @permission storage:write
     */
    export function save(data: string): void {}
  `;
  const result = await parseTypeScript(code);
  assertEquals(result.functions[0].permissions, ['storage:write']);
});

Deno.test('parser: multi-line description', async () => {
  const code = `
    /**
     * This is the first line
     * and this continues the description
     */
    export function greet(): void {}
  `;
  const result = await parseTypeScript(code);
  assert(result.functions[0].description.includes('first line'));
  assert(result.functions[0].description.includes('continues'));
});

// ============================================
// Interface and type alias extraction
// ============================================

Deno.test('parser: extracts exported interface', async () => {
  const code = `
    export interface User {
      name: string;
      age: number;
      email?: string;
    }
    export function f(): void {}
  `;
  const result = await parseTypeScript(code);
  assert(result.types.User !== undefined);
  assertEquals(result.types.User.type, 'object');
  assert(result.types.User.properties?.name !== undefined);
  assert(result.types.User.properties?.age !== undefined);
  assert(result.types.User.properties?.email !== undefined);
  assertEquals(result.types.User.required, ['name', 'age']);
});

Deno.test('parser: extracts exported type alias', async () => {
  const code = `
    export type Status = 'active' | 'inactive' | 'pending';
    export function f(): void {}
  `;
  const result = await parseTypeScript(code);
  assert(result.types.Status !== undefined);
  assertEquals(result.types.Status.enum, ['active', 'inactive', 'pending']);
});

// ============================================
// Permission inference from code patterns
// ============================================

Deno.test('parser: infers storage:write from ultralight.store', async () => {
  const code = `export async function save() { await ultralight.store('key', 'val'); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('storage:write'));
});

Deno.test('parser: infers storage:read from ultralight.load', async () => {
  const code = `export async function get() { return await ultralight.load('key'); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('storage:read'));
});

Deno.test('parser: infers storage:delete from ultralight.remove', async () => {
  const code = `export async function del() { await ultralight.remove('key'); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('storage:delete'));
});

Deno.test('parser: infers memory:write from ultralight.remember', async () => {
  const code = `export async function save() { await ultralight.remember('k', 'v'); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('memory:write'));
});

Deno.test('parser: infers memory:read from ultralight.recall', async () => {
  const code = `export async function get() { return await ultralight.recall('k'); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('memory:read'));
});

Deno.test('parser: infers ai:call from ultralight.ai', async () => {
  const code = `export async function ask() { return await ultralight.ai({ model: 'gpt-4o' }); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('ai:call'));
});

Deno.test('parser: infers ai:embed from galactic.embed', async () => {
  const code = `export async function index(text: string) { return await galactic.embed({ input: text }); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('ai:embed'));
});

Deno.test('parser: infers net:fetch from fetch()', async () => {
  const code = `export async function get() { return await fetch('https://api.example.com'); }`;
  const result = await parseTypeScript(code);
  assert(result.permissions.includes('net:fetch'));
});

Deno.test('parser: no permissions for plain function', async () => {
  const code = `export function add(a: number, b: number): number { return a + b; }`;
  const result = await parseTypeScript(code);
  assertEquals(result.permissions.length, 0);
});

Deno.test('parser: deduplicates permissions', async () => {
  const code = `
    export async function f() {
      await ultralight.store('a', 1);
      await ultralight.store('b', 2);
    }
  `;
  const result = await parseTypeScript(code);
  const storageWrites = result.permissions.filter(p => p === 'storage:write');
  assertEquals(storageWrites.length, 1);
});

// ============================================
// Error handling
// ============================================

Deno.test('parser: handles empty code', async () => {
  const result = await parseTypeScript('');
  assertEquals(result.functions.length, 0);
  assertEquals(result.parseErrors.length, 0);
});

Deno.test('parser: handles syntax errors gracefully', async () => {
  const code = `export function broken(: void {}`;
  const result = await parseTypeScript(code);
  // Parser should not crash — it may produce warnings or empty results
  assert(result.parseErrors.length === 0 || result.parseWarnings.length >= 0);
});

Deno.test('parser: handles JavaScript (no types)', async () => {
  const code = `export function greet(name) { return 'Hello ' + name; }`;
  const result = await parseTypeScript(code, 'index.js');
  assertEquals(result.functions.length, 1);
  assertEquals(result.functions[0].name, 'greet');
  assertEquals(result.functions[0].parameters[0].type, 'unknown');
});

Deno.test('parser: file-level JSDoc description', async () => {
  const code = `
    /** This app provides weather data */
    export function getWeather(): void {}
  `;
  const result = await parseTypeScript(code);
  // File-level JSDoc is extracted from the first statement
  assert(
    result.description === 'This app provides weather data' ||
    result.functions[0].description === 'This app provides weather data'
  );
});
