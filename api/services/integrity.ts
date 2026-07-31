// Code Integrity Service — Layer 1: Safety Scanner
// Runs on every upload BEFORE files are stored to R2.
// Detects hardcoded secrets, dangerous code patterns, and suspicious constructs.
// Returns lint-style diagnostics; errors block the upload.

// ============================================
// TYPES
// ============================================

export interface IntegrityIssue {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  line?: number;
  file?: string;
  /**
   * Non-sensitive lexical evidence only. Secret rules never populate this
   * field: even a short prefix can identify or help reconstruct a credential.
   */
  match?: string;
}

export interface SafetyScanResult {
  passed: boolean; // false if any error-severity issue found
  issues: IntegrityIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}

// ============================================
// RULE DEFINITIONS
// ============================================

interface ScanRule {
  id: string;
  severity: "error" | "warning" | "info";
  description: string;
  pattern: RegExp;
  /** File extensions to check. If empty, checks all text files. */
  fileTypes?: string[];
  /** If true, redact the matched value in issue output */
  redact?: boolean;
}

const SECRET_RULES: ScanRule[] = [
  // OpenAI-style API keys (sk-...)
  {
    id: "secret-api-key",
    severity: "error",
    description: "Hardcoded API key detected",
    pattern: /(?:['"`])sk-[a-zA-Z0-9]{20,}(?:['"`])/g,
    redact: true,
  },
  // Generic API key assignments: api_key = "value", apiKey: "value"
  {
    id: "secret-api-key",
    severity: "error",
    description: "Hardcoded API key assignment detected",
    pattern: /[Aa]pi[_-]?[Kk]ey\s*[:=]\s*['"][a-zA-Z0-9._\-]{16,}['"]/g,
    redact: true,
  },
  // Hardcoded Bearer tokens in string literals
  {
    id: "secret-api-key",
    severity: "error",
    description: "Hardcoded Bearer token detected",
    pattern: /['"]Bearer\s+[a-zA-Z0-9._\-]{30,}['"]/g,
    redact: true,
  },
  // Well-known env var names with literal values
  {
    id: "secret-api-key",
    severity: "error",
    description: "Hardcoded secret environment variable detected",
    pattern:
      /(?:OPENAI_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|AWS_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|DATABASE_URL)\s*=\s*['"][^'"]{10,}['"]/g,
    redact: true,
  },
  // PEM private keys
  {
    id: "secret-private-key",
    severity: "error",
    description: "Private key detected",
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/g,
    redact: false,
  },
  // Literal password assignments
  {
    id: "secret-credential",
    severity: "error",
    description: "Hardcoded password detected",
    pattern: /password\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    redact: true,
  },
  // Literal secret assignments
  {
    id: "secret-credential",
    severity: "error",
    description: "Hardcoded secret value detected",
    pattern: /(?:client_?secret|app_?secret)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    redact: true,
  },
  // Structured config/object literals quote their keys, which intentionally
  // falls outside the assignment rule above. Match only credential-shaped
  // keys with long token-like values, while leaving explicit examples and
  // placeholders usable in scaffolds.
  {
    id: "secret-structured-credential",
    severity: "error",
    description: "Hardcoded structured credential detected",
    pattern:
      /["'](?:api[_-]?key|client[_-]?secret|private[_-]?key)["']\s*:\s*["'](?!(?:[^"'\\\r\n])*(?:placeholder|replace[-_ ]?me|change[-_ ]?me|example|dummy|your[-_ ]?(?:api[-_ ]?key|client[-_ ]?secret|private[-_ ]?key))(?:[^"'\\\r\n])*["'])[A-Za-z0-9_./+=-]{16,}["']/gi,
    redact: true,
  },
  // Database connection strings with credentials
  {
    id: "secret-db-connection",
    severity: "error",
    description: "Database connection string with credentials detected",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^'"@\s]+:[^'"@\s]+@/g,
    redact: true,
  },
  // AWS access-key identifiers. The paired secret is usually nearby, but the
  // identifier alone is sufficiently distinctive that source retention should
  // fail closed.
  {
    id: "secret-aws-access-key",
    severity: "error",
    description: "AWS access key detected",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    redact: true,
  },
  // Google API keys use a stable high-entropy prefix and fixed-ish length.
  {
    id: "secret-google-api-key",
    severity: "error",
    description: "Google API key detected",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    redact: true,
  },
  // GitHub's modern token families have unambiguous prefixes.
  {
    id: "secret-github-token",
    severity: "error",
    description: "GitHub token detected",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
    redact: true,
  },
  {
    id: "secret-stripe-key",
    severity: "error",
    description: "Stripe secret key detected",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    redact: true,
  },
  {
    id: "secret-slack-token",
    severity: "error",
    description: "Slack token detected",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    redact: true,
  },
];

const DANGEROUS_RULES: ScanRule[] = [
  // eval() and Function constructor
  {
    id: "dangerous-eval",
    severity: "error",
    description:
      "eval() or Function constructor detected — use safe alternatives",
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\(|(?<!\.)Function\s*\()/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
  // process.exit
  {
    id: "dangerous-process-exit",
    severity: "error",
    description: "process.exit() detected — this terminates the worker process",
    pattern: /process\.exit\s*\(/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
  // Direct filesystem access
  {
    id: "dangerous-file-system",
    severity: "error",
    description:
      "Direct filesystem access detected — use ultralight.store/load instead",
    pattern:
      /(?:Deno\.(?:readFile|writeFile|readTextFile|writeTextFile|open|remove|mkdir|stat|lstat|readDir))\s*\(/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
  // Node.js fs module
  {
    id: "dangerous-file-system",
    severity: "error",
    description:
      "Node.js filesystem access detected — use ultralight.store/load instead",
    pattern:
      /(?:fs\.(?:readFile|writeFile|readFileSync|writeFileSync|unlink|rmdir|mkdir))\s*\(/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
  // Subprocess execution
  {
    id: "dangerous-subprocess",
    severity: "error",
    description:
      "Subprocess execution detected — not allowed in sandboxed apps",
    pattern:
      /(?:Deno\.(?:Command|run)\s*\(|child_process\.(?:exec|spawn|execSync|spawnSync)\s*\()/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
  // SSRF — fetch to localhost/internal
  {
    id: "dangerous-fetch-localhost",
    severity: "error",
    description:
      "Fetch to localhost/internal address detected — potential SSRF",
    pattern:
      /fetch\s*\(\s*['"`]https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
];

const WARNING_RULES: ScanRule[] = [
  // Direct env access (should use Galactic env vars system)
  {
    id: "warn-env-direct-access",
    severity: "warning",
    description:
      "Direct environment variable access — consider using the env_vars system instead",
    pattern: /(?:Deno\.env\.get\s*\(|process\.env\.\w+)/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
  // Outbound WebSocket connections
  {
    id: "warn-network-backdoor",
    severity: "warning",
    description:
      "Outbound WebSocket connection detected — persistent connections are flagged for review",
    pattern: /new\s+WebSocket\s*\(/g,
    fileTypes: [".ts", ".tsx", ".js", ".jsx"],
  },
];

// ============================================
// HELPERS
// ============================================

/**
 * Find line number for a match index in content
 */
function findLineNumber(content: string, matchIndex: number): number {
  let line = 1;
  for (let i = 0; i < matchIndex && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Check if content appears to be binary (contains null bytes)
 */
function isBinary(content: string): boolean {
  for (let i = 0; i < Math.min(content.length, 512); i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Check if a file matches the allowed file types for a rule
 */
function matchesFileType(fileName: string, fileTypes?: string[]): boolean {
  if (!fileTypes || fileTypes.length === 0) return true;
  const lower = fileName.toLowerCase();
  return fileTypes.some((ext) => lower.endsWith(ext));
}

/**
 * Check if a match occurs inside a comment (rough heuristic)
 * Looks backwards from match for // on the same line, or checks if inside block comment
 */
function isInsideComment(content: string, matchIndex: number): boolean {
  // Check single-line comment: look backwards to start of line
  let lineStart = matchIndex;
  while (lineStart > 0 && content[lineStart - 1] !== "\n") {
    lineStart--;
  }
  const linePrefix = content.slice(lineStart, matchIndex);
  if (/\/\//.test(linePrefix)) return true;

  // Check block comment: count /* and */ before this position
  const before = content.slice(0, matchIndex);
  const opens = (before.match(/\/\*/g) || []).length;
  const closes = (before.match(/\*\//g) || []).length;
  return opens > closes;
}

// ============================================
// MAIN SCANNER
// ============================================

/**
 * Run safety scan on uploaded files.
 * Returns immediately (synchronous, pure regex matching).
 * Issues with severity 'error' cause passed=false.
 */
export function runSafetyScan(
  files: Array<{ name: string; content: string; bytes?: Uint8Array }>,
): SafetyScanResult {
  const issues: IntegrityIssue[] = [];

  for (const file of files) {
    // Skip binary files
    if (file.bytes || isBinary(file.content)) continue;

    // Skip manifest.json and other config files from dangerous pattern checks
    // but still check them for secrets
    const isConfig = file.name.endsWith(".json");

    // Run all rule categories
    const allRules = [
      ...SECRET_RULES,
      ...(isConfig ? [] : DANGEROUS_RULES),
      ...(isConfig ? [] : WARNING_RULES),
    ];

    for (const rule of allRules) {
      if (!matchesFileType(file.name, rule.fileTypes)) continue;

      // Reset regex lastIndex for global patterns
      rule.pattern.lastIndex = 0;

      let match;
      while ((match = rule.pattern.exec(file.content)) !== null) {
        // Skip matches inside comments (reduce false positives)
        if (isInsideComment(file.content, match.index)) continue;

        const issue: IntegrityIssue = {
          severity: rule.severity,
          rule: rule.id,
          message: `${rule.description} in ${file.name}`,
          line: findLineNumber(file.content, match.index),
          file: file.name,
        };

        if (!rule.id.startsWith("secret-") && !rule.redact) {
          issue.match = match[0].slice(0, 40);
        }

        issues.push(issue);
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;

  return {
    passed: errors === 0,
    issues,
    summary: { errors, warnings, info },
  };
}
