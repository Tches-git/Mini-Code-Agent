import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readLintDiagnostics,
  readTypeScriptDiagnostics,
} from "../tools/diagnostics.js";
import { normalizeFilePath } from "../utils/path.js";

const DEFAULT_VALIDATION_COMMAND = "npm run build";
const VALIDATION_SCRIPT_ORDER = ["lint", "test", "build"] as const;
const PLACEHOLDER_TEST_PATTERN = /no test specified|exit 1/i;

type PackageJson = { scripts?: Record<string, string> };
type ValidationScriptName = (typeof VALIDATION_SCRIPT_ORDER)[number];

type ValidationPlan = { commands: string[]; reason: string };

type ValidationDiagnostics = {
  command: string;
  diagnostics: Array<{
    file?: string;
    line?: number;
    column?: number;
    severity: "error" | "warning";
    message: string;
    source: "tsc" | "biome";
    code?: string;
  }>;
  truncated: boolean;
};

export type CommandResult = {
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
};

export function parseCommandResult(result: string): CommandResult | null {
  try {
    return JSON.parse(result) as CommandResult;
  } catch {
    return null;
  }
}

function formatDiagnosticsBlock(
  result: ValidationDiagnostics | null,
): string[] {
  if (!result || result.diagnostics.length === 0) {
    return [];
  }

  const lines = [
    "diagnostics:",
    ...result.diagnostics.slice(0, 8).map((diagnostic) => {
      const location = diagnostic.file
        ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
        : "unknown";
      const code = diagnostic.code ? ` ${diagnostic.code}` : "";
      return `- [${diagnostic.source}/${diagnostic.severity}${code}] ${location} ${diagnostic.message}`;
    }),
  ];

  if (result.truncated || result.diagnostics.length > 8) {
    lines.push("- ... more diagnostics omitted ...");
  }

  return lines;
}

export async function getDiagnosticsForValidationCommand(
  command: string,
): Promise<ValidationDiagnostics | null> {
  const normalized = command.toLowerCase();
  try {
    if (
      normalized.includes("lint") ||
      normalized.includes("biome") ||
      normalized.includes("eslint")
    ) {
      return await readLintDiagnostics();
    }
    if (
      normalized.includes("build") ||
      normalized.includes("typecheck") ||
      normalized.includes("tsc")
    ) {
      return await readTypeScriptDiagnostics();
    }
  } catch {
    return null;
  }

  return null;
}

export function buildFailurePrompt(
  commandResult: CommandResult,
  diagnostics?: ValidationDiagnostics | null,
): string {
  const stdout = (commandResult.stdout || "").slice(0, 2000);
  const stderr = (commandResult.stderr || "").slice(0, 2000);
  return [
    "自动验证失败，请不要只总结错误，而是继续使用工具修复代码。",
    `失败命令: ${commandResult.command || DEFAULT_VALIDATION_COMMAND}`,
    `退出码: ${commandResult.exitCode ?? "unknown"}`,
    "stdout:",
    stdout || "(empty)",
    "stderr:",
    stderr || "(empty)",
    ...formatDiagnosticsBlock(diagnostics || null),
    "请优先根据报错定位文件，做最小修改，然后再次验证。",
  ].join("\n");
}

export function isValidationCommand(command: string): boolean {
  const normalized = command.toLowerCase().trim();
  return [
    "lint",
    "test",
    "build",
    "check",
    "typecheck",
    "tsc",
    "vitest",
    "jest",
    "eslint",
  ].some(
    (keyword) =>
      normalized === keyword ||
      normalized.includes(` ${keyword}`) ||
      normalized.includes(`run ${keyword}`),
  );
}

function isDocumentationPath(filePath: string): boolean {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(filePath);
}
function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.]+$/i.test(
    filePath,
  );
}
function isSourcePath(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|yaml|yml|toml|css|scss|sass|less|html|vue|svelte)$/i.test(
    filePath,
  );
}
function isConfigPath(filePath: string): boolean {
  const baseName = path.basename(filePath).toLowerCase();
  return (
    [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ].includes(baseName) ||
    /(^|\/)(tsconfig.*\.json|eslint\.config\.[^.]+|\.eslintrc(\.[^.]+)?|prettier\.config\.[^.]+|\.prettierrc(\.[^.]+)?|vite\.config\.[^.]+|vitest\.config\.[^.]+|jest\.config\.[^.]+|babel\.config\.[^.]+|webpack\.config\.[^.]+)$/i.test(
      filePath,
    )
  );
}

function inferValidationScripts(changedPaths: string[]): {
  scripts: Set<ValidationScriptName>;
  reason: string;
} {
  if (changedPaths.length === 0)
    return {
      scripts: new Set(VALIDATION_SCRIPT_ORDER),
      reason: "无法识别本轮修改文件，执行默认完整验证",
    };
  let sawConfig = false,
    sawSource = false,
    sawTests = false,
    sawNonDocChange = false;
  for (const changedPath of changedPaths) {
    const normalized = normalizeFilePath(changedPath);
    if (isDocumentationPath(normalized)) continue;
    sawNonDocChange = true;
    if (isConfigPath(normalized)) {
      sawConfig = true;
      continue;
    }
    if (isTestPath(normalized)) {
      sawTests = true;
      continue;
    }
    if (isSourcePath(normalized)) {
      sawSource = true;
      continue;
    }
    sawSource = true;
  }
  if (!sawNonDocChange)
    return {
      scripts: new Set(),
      reason: "仅检测到文档或说明文件变更，跳过自动验证",
    };
  if (sawConfig)
    return {
      scripts: new Set(VALIDATION_SCRIPT_ORDER),
      reason: "检测到依赖或工具链配置变更，执行 lint/test/build 全量验证",
    };
  if (sawSource && sawTests)
    return {
      scripts: new Set<ValidationScriptName>(["lint", "test", "build"]),
      reason: "同时修改了源码和测试，执行完整验证",
    };
  if (sawSource)
    return {
      scripts: new Set<ValidationScriptName>(["lint", "build"]),
      reason: "检测到源码或配置文件变更，执行 lint/build 验证",
    };
  return {
    scripts: new Set<ValidationScriptName>(["lint", "test"]),
    reason: "仅检测到测试相关变更，执行 lint/test 验证",
  };
}

async function detectPackageManager(): Promise<
  "npm" | "pnpm" | "yarn" | "bun"
> {
  for (const check of [
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "bun.lockb", manager: "bun" },
    { file: "bun.lock", manager: "bun" },
    { file: "package-lock.json", manager: "npm" },
  ] as const) {
    try {
      await fs.access(path.join(process.cwd(), check.file));
      return check.manager;
    } catch {}
  }
  const userAgent = process.env.npm_config_user_agent || "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

export async function getValidationPlan(
  changedPaths: string[],
): Promise<ValidationPlan> {
  const inferred = inferValidationScripts(changedPaths);
  if (inferred.scripts.size === 0)
    return { commands: [], reason: inferred.reason };
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as PackageJson;
    const scripts = packageJson.scripts || {};
    const packageManager = await detectPackageManager();
    const available = VALIDATION_SCRIPT_ORDER.filter(
      (name) =>
        scripts[name] &&
        !(name === "test" && PLACEHOLDER_TEST_PATTERN.test(scripts[name])),
    );
    const selected = available.filter((name) => inferred.scripts.has(name));
    if (selected.length > 0)
      return {
        commands: selected.map((name) => `${packageManager} run ${name}`),
        reason: inferred.reason,
      };
    if (available.length > 0)
      return {
        commands: available.map((name) => `${packageManager} run ${name}`),
        reason: `${inferred.reason}；未找到完全匹配的脚本，回退到项目内可用验证命令`,
      };
  } catch {}
  return {
    commands: [DEFAULT_VALIDATION_COMMAND],
    reason: `${inferred.reason}；未找到项目脚本，回退到默认构建验证`,
  };
}
