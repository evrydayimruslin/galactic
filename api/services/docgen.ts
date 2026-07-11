// Skills.md generation and validation helpers.

import type {
  ParsedSkills,
  PermissionDeclaration,
  SkillFunction,
} from "../../shared/types/index.ts";
import { formatLight } from "../../shared/types/index.ts";
import type {
  JsonSchema,
  ParsedFunction,
  ParsedParameter,
  ParseResult,
} from "./parser.ts";

export interface GenerationResult {
  success: boolean;
  partial: boolean;
  skills_md: string | null;
  skills_parsed: ParsedSkills | null;
  embedding_text: string | null;
  errors: GenerationError[];
  warnings: string[];
}

export interface GenerationError {
  phase: "parse" | "generate_skills" | "validate" | "embed";
  message: string;
  line?: number;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  skills_parsed: ParsedSkills | null;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  line?: number;
  message: string;
  suggestion?: string;
}

export interface DocgenHttpRoute {
  function_name: string;
  path: string;
  url?: string | null;
  auth: "public" | "user";
  methods: string[];
  allows_any_method?: boolean;
  billing: "owner" | "caller";
  data_scope: "app" | "user";
}

export interface GenerateSkillsMdOptions {
  includeExamples?: boolean;
  includePermissions?: boolean;
  pricingConfig?: {
    default_price_light?: number;
    functions?: Record<string, number>;
    products?: Array<
      { id: string; name: string; price_light: number; description?: string }
    >;
  };
  httpRoutes?: DocgenHttpRoute[];
}

/**
 * Generate Skills.md markdown from ParseResult
 */
export function generateSkillsMd(
  appName: string,
  parseResult: ParseResult,
  options: GenerateSkillsMdOptions = {},
): string {
  const { includeExamples = true, includePermissions = true } = options;
  const lines: string[] = [];

  lines.push(`# ${appName} Skills`);
  lines.push("");

  if (parseResult.description) {
    lines.push(`> ${parseResult.description}`);
    lines.push("");
  }

  lines.push(
    "<!-- Generated from the current app source. Keep manual edits aligned with code changes. -->",
  );
  lines.push("");

  if (includePermissions && parseResult.permissions.length > 0) {
    lines.push("## Required Permissions");
    lines.push("");
    for (const perm of parseResult.permissions) {
      lines.push(`- \`${perm}\``);
    }
    lines.push("");
  }

  if (parseResult.functions.length > 0) {
    lines.push("## Functions");
    lines.push("");

    for (const fn of parseResult.functions) {
      lines.push(
        generateFunctionDoc(fn, { includeExamples, includePermissions }),
      );
      lines.push("");
    }
  } else {
    lines.push("## Functions");
    lines.push("");
    lines.push(
      "No exported functions were detected in the entry file. Add at least one exported function to publish app capabilities.",
    );
    lines.push("");
  }

  if (Object.keys(parseResult.types).length > 0) {
    lines.push("## Type Definitions");
    lines.push("");

    for (const [typeName, schema] of Object.entries(parseResult.types)) {
      lines.push(`### \`${typeName}\``);
      lines.push("");
      lines.push("```typescript");
      lines.push(schemaToTypeDefinition(typeName, schema));
      lines.push("```");
      lines.push("");
    }
  }

  const pc = options.pricingConfig;
  if (
    pc &&
    (pc.default_price_light || pc.functions ||
      (pc.products && pc.products.length > 0))
  ) {
    lines.push("## Pricing");
    lines.push("");
    if (pc.default_price_light) {
      lines.push(
        `Default: **${formatLight(pc.default_price_light)}** per call`,
      );
    } else {
      lines.push("Default: **free**");
    }
    if (pc.functions && Object.keys(pc.functions).length > 0) {
      lines.push("");
      lines.push("| Function | Price |");
      lines.push("|----------|-------|");
      for (const [fn, cents] of Object.entries(pc.functions)) {
        lines.push(`| \`${fn}\` | ${formatLight(cents)} |`);
      }
    }
    if (pc.products && pc.products.length > 0) {
      lines.push("");
      lines.push("### Products (In-App Purchases)");
      lines.push("");
      lines.push(
        "Declared in-app products (legacy — there is no in-code charge API; purchases flow through platform per-call pricing):",
      );
      lines.push("");
      lines.push("| Product | Price | Description |");
      lines.push("|---------|-------|-------------|");
      for (const p of pc.products) {
        lines.push(
          `| \`${p.id}\` — ${p.name} | ${formatLight(p.price_light)} | ${
            p.description || ""
          } |`,
        );
      }
    }
    lines.push("");
    lines.push(
      "*All transfers are feeless internal ledger operations. Callers need enough Light to use paid functions.*",
    );
    lines.push("");
  }

  const httpRoutes = options.httpRoutes || [];
  if (httpRoutes.length > 0) {
    lines.push("## Direct HTTP Routes");
    lines.push("");
    for (const route of httpRoutes) {
      const methodLabel = route.allows_any_method
        ? "ANY"
        : route.methods.join("|");
      const target = route.url || route.path;
      const authLabel = route.auth === "public"
        ? "public"
        : "requires `Authorization: Bearer {TOKEN}`";
      const billingLabel = route.billing === "owner"
        ? "owner-billed"
        : "caller-billed";
      const dataScope = route.data_scope === "app" ? "app data" : "user data";
      lines.push(
        `- \`${methodLabel} ${target}\` — ${authLabel}, ${billingLabel}, ${dataScope} scope`,
      );
    }
    lines.push("");
  }

  lines.push("## Web Dashboard");
  lines.push("");
  lines.push("This app has a browser-accessible dashboard at:");
  lines.push("");
  lines.push("```");
  lines.push("GET /http/{appId}/_ui");
  lines.push("```");
  lines.push("");
  lines.push(
    "Direct users to this URL when they want to view or manage their data visually. Browser access should use an Galactic session, while agent/API access should use the MCP endpoint with an `Authorization` header.",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Collapse multi-line or large inline type annotations to a single line.
 */
function collapseType(typeStr: string): string {
  if (typeStr.includes("\n")) {
    const promiseMatch = typeStr.match(/^Promise<[\s\S]+>$/);
    if (promiseMatch) return "Promise<object>";
    return "object";
  }
  if (typeStr.length > 60 && typeStr.includes("{")) {
    const promiseMatch = typeStr.match(/^Promise<\{[\s\S]+\}>$/);
    if (promiseMatch) return "Promise<object>";
    if (typeStr.startsWith("{")) return "object";
  }
  return typeStr;
}

/**
 * Generate documentation for a single function
 */
function generateFunctionDoc(
  fn: ParsedFunction,
  options: { includeExamples?: boolean; includePermissions?: boolean },
): string {
  const lines: string[] = [];

  const params = fn.parameters.map((p) => {
    const optional = !p.required ? "?" : "";
    const compactType = collapseType(p.type);
    return `${p.name}${optional}: ${compactType}`;
  }).join(", ");

  const asyncPrefix = fn.isAsync ? "async " : "";
  const compactReturn = collapseType(fn.returns.type);
  lines.push(`### \`${asyncPrefix}${fn.name}(${params}): ${compactReturn}\``);
  lines.push("");

  if (fn.description) {
    lines.push(fn.description);
    lines.push("");
  }

  if (fn.parameters.length > 0) {
    lines.push("**Parameters:**");
    lines.push("");
    lines.push("| Name | Type | Required | Description |");
    lines.push("|------|------|----------|-------------|");

    for (const param of fn.parameters) {
      const req = param.required ? "Yes" : "No";
      const desc = param.description || "-";
      const defaultStr = param.default !== undefined
        ? ` (default: \`${JSON.stringify(param.default)}\`)`
        : "";
      lines.push(
        `| \`${param.name}\` | \`${escapeTableCell(param.type)}\` | ${req} | ${
          escapeTableCell(desc)
        }${defaultStr} |`,
      );
    }
    lines.push("");
  }

  if (fn.returns.type !== "void" && fn.returns.type !== "Promise<void>") {
    lines.push(
      `**Returns:** \`${fn.returns.type}\`${
        fn.returns.description ? ` - ${fn.returns.description}` : ""
      }`,
    );
    lines.push("");
  }

  if (options.includeExamples && fn.examples.length > 0) {
    lines.push("**Example:**");
    lines.push("");
    for (const example of fn.examples) {
      if (example.includes("```")) {
        lines.push(example);
      } else {
        lines.push("```typescript");
        lines.push(example);
        lines.push("```");
      }
      lines.push("");
    }
  }

  if (options.includePermissions && fn.permissions.length > 0) {
    lines.push("**Permissions Required:**");
    lines.push("");
    for (const perm of fn.permissions) {
      lines.push(`- \`${perm}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function schemaToTypeDefinition(name: string, schema: JsonSchema): string {
  if (schema.type === "object" && schema.properties) {
    const props = Object.entries(schema.properties).map(
      ([propName, propSchema]) => {
        const optional = !(schema.required?.includes(propName));
        const typeStr = schemaToTypeString(propSchema as JsonSchema);
        const desc = (propSchema as JsonSchema).description;
        const comment = desc ? `  // ${desc}\n` : "";
        return `${comment}  ${propName}${optional ? "?" : ""}: ${typeStr};`;
      },
    );
    return `interface ${name} {\n${props.join("\n")}\n}`;
  }

  return `type ${name} = ${schemaToTypeString(schema)};`;
}

function schemaToTypeString(schema: JsonSchema): string {
  if (!schema) return "unknown";

  if (schema.$ref) {
    return schema.$ref.replace("#/definitions/", "");
  }

  if (schema.oneOf) {
    return (schema.oneOf as JsonSchema[]).map((s) => schemaToTypeString(s))
      .join(" | ");
  }

  if (schema.allOf) {
    return (schema.allOf as JsonSchema[]).map((s) => schemaToTypeString(s))
      .join(" & ");
  }

  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  if (schema.type === "array") {
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map((i) => schemaToTypeString(i)).join(", ")}]`;
      }
      return `${schemaToTypeString(schema.items)}[]`;
    }
    return "unknown[]";
  }

  if (schema.type === "object") {
    if (schema.properties) {
      const props = Object.entries(schema.properties)
        .map(([k, v]) => {
          const optional = !(schema.required?.includes(k));
          return `${k}${optional ? "?" : ""}: ${
            schemaToTypeString(v as JsonSchema)
          }`;
        })
        .join("; ");
      return `{ ${props} }`;
    }
    if (schema.additionalProperties) {
      return `Record<string, ${
        schemaToTypeString(schema.additionalProperties as JsonSchema)
      }>`;
    }
    return "object";
  }

  if (schema.type === "string") return "string";
  if (schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";

  return "unknown";
}

/**
 * Validate and parse Skills.md markdown back to ParsedSkills
 * Used when user manually edits the markdown
 */
export function validateAndParseSkillsMd(markdown: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const functions: SkillFunction[] = [];
  const permissions: PermissionDeclaration[] = [];
  let description: string | undefined;

  try {
    const lines = markdown.split("\n");
    let lineNum = 0;

    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const line = lines[i];
      if (line.startsWith("> ")) {
        description = line.slice(2).trim();
        break;
      }
    }

    let inPermissionsSection = false;
    for (const line of lines) {
      lineNum++;
      if (line.match(/^##\s+Required Permissions/i)) {
        inPermissionsSection = true;
        continue;
      }
      if (line.startsWith("## ") && inPermissionsSection) {
        inPermissionsSection = false;
        continue;
      }
      if (inPermissionsSection && line.startsWith("- `")) {
        const permMatch = line.match(/^-\s+`([^`]+)`/);
        if (permMatch) {
          permissions.push({ permission: permMatch[1], required: true });
        }
      }
    }

    const functionRegex =
      /^###\s+`(async\s+)?(\w+)\(([^)]*)\)(?::\s*(.+?))?`\s*$/;

    lineNum = 0;
    let currentFunction: Partial<SkillFunction> | null = null;
    let currentSection:
      | "description"
      | "parameters"
      | "returns"
      | "example"
      | "permissions"
      | null = null;
    let parameterLines: string[] = [];
    let exampleLines: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      lineNum++;

      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (currentSection === "example") {
          exampleLines.push(line);
        }
        continue;
      }

      if (inCodeBlock) {
        if (currentSection === "example") {
          exampleLines.push(line);
        }
        continue;
      }

      const fnMatch = line.match(functionRegex);
      if (fnMatch) {
        if (currentFunction && currentFunction.name) {
          functions.push(
            finalizeParsedFunction(
              currentFunction,
              parameterLines,
              exampleLines,
              warnings,
            ),
          );
        }

        const [, asyncPrefix, name, paramsStr, returnType] = fnMatch;
        currentFunction = {
          name,
          description: "",
          parameters: {},
          returns: returnType ? parseReturnType(returnType) : { type: "null" },
          examples: [],
        };
        currentSection = "description";
        parameterLines = [];
        exampleLines = [];
        continue;
      }

      if (line.startsWith("**Parameters:**")) {
        currentSection = "parameters";
        continue;
      }
      if (line.startsWith("**Returns:**")) {
        currentSection = "returns";
        if (currentFunction) {
          const returnMatch = line.match(
            /\*\*Returns:\*\*\s*`([^`]+)`(?:\s*-\s*(.+))?/,
          );
          if (returnMatch) {
            currentFunction.returns = parseReturnType(returnMatch[1]);
          }
        }
        continue;
      }
      if (line.startsWith("**Example:**")) {
        currentSection = "example";
        continue;
      }
      if (line.startsWith("**Permissions Required:**")) {
        currentSection = "permissions";
        continue;
      }

      if (line.startsWith("## ")) {
        currentFunction = null;
        currentSection = null;
        continue;
      }

      if (currentFunction && currentSection) {
        switch (currentSection) {
          case "description":
            if (
              line.trim() && !line.startsWith("|") && !line.startsWith("**")
            ) {
              currentFunction.description =
                ((currentFunction.description || "") + " " + line).trim();
            }
            break;
          case "parameters":
            if (line.startsWith("|") && !line.includes("---")) {
              parameterLines.push(line);
            }
            break;
          case "example":
            exampleLines.push(line);
            break;
        }
      }
    }

    if (currentFunction && currentFunction.name) {
      functions.push(
        finalizeParsedFunction(
          currentFunction,
          parameterLines,
          exampleLines,
          warnings,
        ),
      );
    }

    if (functions.length === 0) {
      warnings.push(
        "No functions found in Skills.md. Make sure function headers use the format: ### `functionName(params): ReturnType`",
      );
    }

    for (const fn of functions) {
      if (!fn.description) {
        warnings.push(`Function "${fn.name}" has no description.`);
      }
    }

    return {
      valid: errors.length === 0,
      skills_parsed: {
        functions,
        permissions,
        description,
      },
      errors,
      warnings,
    };
  } catch (err) {
    errors.push({
      message: `Failed to parse Skills.md: ${
        err instanceof Error ? err.message : String(err)
      }`,
      suggestion:
        "Check the markdown syntax and ensure function headers are formatted correctly.",
    });
    return {
      valid: false,
      skills_parsed: null,
      errors,
      warnings,
    };
  }
}

function parseParameterTable(lines: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (const line of lines) {
    if (line.includes("Name") && line.includes("Type")) continue;

    const match = line.match(
      /\|\s*`(\w+)`\s*\|\s*`([^`]+)`\s*\|\s*(Yes|No)\s*\|\s*([^|]*)\|?/,
    );
    if (match) {
      const [, name, type, required, desc] = match;
      params[name] = {
        type: typeStringToSchema(type),
        description: desc.trim().replace(/\s*\(default:.*\)/, ""),
      };
    }
  }

  return params;
}

/**
 * Convert a type string to JSON Schema
 */
function typeStringToSchema(typeStr: string): JsonSchema {
  const type = typeStr.trim();

  if (type === "string") return { type: "string" };
  if (type === "number") return { type: "number" };
  if (type === "boolean") return { type: "boolean" };
  if (type === "null" || type === "void") return { type: "null" };

  if (type.endsWith("[]")) {
    const itemType = type.slice(0, -2);
    return { type: "array", items: typeStringToSchema(itemType) };
  }

  if (type.startsWith("Promise<") && type.endsWith(">")) {
    return typeStringToSchema(type.slice(8, -1));
  }

  return { $ref: `#/definitions/${type}` };
}

function parseReturnType(typeStr: string): unknown {
  return typeStringToSchema(typeStr);
}

function finalizeParsedFunction(
  fn: Partial<SkillFunction>,
  parameterLines: string[],
  exampleLines: string[],
  warnings: string[],
): SkillFunction {
  const params = parseParameterTable(parameterLines);

  const exampleText = exampleLines
    .filter((l) => l.trim())
    .join("\n")
    .trim();

  return {
    name: fn.name || "unknown",
    description: fn.description || "",
    parameters: params,
    returns: fn.returns || { type: "null" },
    examples: exampleText ? [exampleText] : [],
  };
}

/**
 * Generate text optimized for embedding/semantic search
 */
export function generateEmbeddingText(
  appName: string,
  appDescription: string | null,
  skills: ParsedSkills,
  searchHints?: string[],
): string {
  const parts: string[] = [];

  if (searchHints && searchHints.length > 0) {
    parts.push("Keywords: " + searchHints.join(", "));
    parts.push("");
  }

  parts.push(appName);
  if (appDescription) {
    parts.push(appDescription);
  }
  if (skills.description) {
    parts.push(skills.description);
  }

  parts.push("");
  parts.push("Functions:");

  for (const fn of skills.functions) {
    const params = fn.parameters as Record<string, Record<string, unknown>>;
    const paramParts = Object.entries(params).map(([name, schema]) => {
      const type = (schema?.type as string) || "any";
      const desc = schema?.description as string | undefined;
      return desc ? `${name}: ${type} (${desc})` : `${name}: ${type}`;
    });
    const paramStr = paramParts.length > 0
      ? `(${paramParts.join(", ")})`
      : "()";
    parts.push(`- ${fn.name}${paramStr}: ${fn.description}`);
  }

  if (skills.permissions.length > 0) {
    parts.push("");
    parts.push("Capabilities:");
    for (const perm of skills.permissions) {
      const capability = permissionToCapability(perm.permission);
      if (capability) {
        parts.push(`- ${capability}`);
      }
    }
  }

  return parts.join("\n");
}

function permissionToCapability(permission: string): string | null {
  const map: Record<string, string> = {
    "storage:read": "can read stored data",
    "storage:write": "can write and store data",
    "storage:delete": "can delete stored data",
    "memory:read": "can access user memory",
    "memory:write": "can save to user memory",
    "ai:call": "can call AI models",
    "ai:embed": "can generate semantic embeddings",
    "net:fetch": "can make HTTP requests",
  };
  return map[permission] || null;
}

/**
 * Enhance parsed skills with AI-generated descriptions using the provided text-generation function.
 */
export async function enhanceWithAI(
  skills: ParsedSkills,
  code: string,
  aiService: (prompt: string) => Promise<string>,
): Promise<ParsedSkills> {
  const enhanced: ParsedSkills = JSON.parse(JSON.stringify(skills));

  const needsDescription = enhanced.functions.filter((fn) =>
    !fn.description || fn.description.length < 10
  );

  if (needsDescription.length === 0) {
    return enhanced;
  }

  const prompt =
    `Given this TypeScript code, provide brief descriptions for these functions:

${needsDescription.map((fn) => `- ${fn.name}`).join("\n")}

Code context:
\`\`\`typescript
${code.slice(0, 3000)}${code.length > 3000 ? "\n// ... truncated" : ""}
\`\`\`

Respond with JSON array of {name, description} objects. Keep descriptions under 100 characters.`;

  try {
    const response = await aiService(prompt);

    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      const descriptions = JSON.parse(match[0]) as Array<
        { name: string; description: string }
      >;

      for (const { name, description } of descriptions) {
        const fn = enhanced.functions.find((f) => f.name === name);
        if (fn && description) {
          fn.description = description;
        }
      }
    }
  } catch (err) {
    console.error("AI enhancement failed:", err);
  }

  return enhanced;
}
