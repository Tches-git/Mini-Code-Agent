import { promises as fs } from "node:fs";
import path from "node:path";
import { getWorkspaceRoot } from "./runtime.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type SupportedTestRunner = "vitest" | "jest";
export type SupportedLintRunner = "biome" | "eslint";

type ToolingConfigInput = {
  validation?: {
    lintScripts?: string[];
    testScripts?: string[];
    buildScripts?: string[];
    testRunnerHints?: Partial<Record<SupportedTestRunner, string[]>>;
  };
  diagnostics?: {
    lintScripts?: string[];
    typecheckScripts?: string[];
    lintRunnerHints?: Partial<Record<SupportedLintRunner, string[]>>;
  };
  commandPolicy?: {
    safeScripts?: string[];
    guardedScripts?: string[];
  };
};

export type WorkspacePackageJson = {
  scripts?: Record<string, string>;
  miniClaudeCode?: ToolingConfigInput;
};

export type ProjectToolingConfig = {
  validation: {
    lintScripts: string[];
    testScripts: string[];
    buildScripts: string[];
    testRunnerHints: Record<SupportedTestRunner, string[]>;
  };
  diagnostics: {
    lintScripts: string[];
    typecheckScripts: string[];
    lintRunnerHints: Record<SupportedLintRunner, string[]>;
  };
  commandPolicy: {
    safeScripts: string[];
    guardedScripts: string[];
  };
};

const DEFAULT_TOOLING_CONFIG: ProjectToolingConfig = {
  validation: {
    lintScripts: ["lint", "check"],
    testScripts: ["test"],
    buildScripts: ["build"],
    testRunnerHints: {
      vitest: ["vitest"],
      jest: ["jest"],
    },
  },
  diagnostics: {
    lintScripts: ["lint", "check"],
    typecheckScripts: ["typecheck", "build"],
    lintRunnerHints: {
      biome: ["biome"],
      eslint: ["eslint"],
    },
  },
  commandPolicy: {
    safeScripts: ["build", "check", "lint", "test", "typecheck"],
    guardedScripts: ["chat", "dev", "install", "migrate", "seed", "start"],
  },
};

function normalizeNames(
  values: string[] | undefined,
  defaults: string[],
): string[] {
  const normalized = (values || [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  return Array.from(new Set(normalized.length > 0 ? normalized : defaults));
}

function normalizeHints<T extends string>(
  values: Partial<Record<T, string[]>> | undefined,
  defaults: Record<T, string[]>,
): Record<T, string[]> {
  return Object.fromEntries(
    Object.entries(defaults).map(([runner, defaultHints]) => [
      runner,
      normalizeNames(values?.[runner as T], defaultHints as string[]),
    ]),
  ) as Record<T, string[]>;
}

export function getProjectToolingConfig(
  packageJson?: WorkspacePackageJson | null,
): ProjectToolingConfig {
  const config = packageJson?.miniClaudeCode;
  return {
    validation: {
      lintScripts: normalizeNames(
        config?.validation?.lintScripts,
        DEFAULT_TOOLING_CONFIG.validation.lintScripts,
      ),
      testScripts: normalizeNames(
        config?.validation?.testScripts,
        DEFAULT_TOOLING_CONFIG.validation.testScripts,
      ),
      buildScripts: normalizeNames(
        config?.validation?.buildScripts,
        DEFAULT_TOOLING_CONFIG.validation.buildScripts,
      ),
      testRunnerHints: normalizeHints(
        config?.validation?.testRunnerHints,
        DEFAULT_TOOLING_CONFIG.validation.testRunnerHints,
      ),
    },
    diagnostics: {
      lintScripts: normalizeNames(
        config?.diagnostics?.lintScripts,
        DEFAULT_TOOLING_CONFIG.diagnostics.lintScripts,
      ),
      typecheckScripts: normalizeNames(
        config?.diagnostics?.typecheckScripts,
        DEFAULT_TOOLING_CONFIG.diagnostics.typecheckScripts,
      ),
      lintRunnerHints: normalizeHints(
        config?.diagnostics?.lintRunnerHints,
        DEFAULT_TOOLING_CONFIG.diagnostics.lintRunnerHints,
      ),
    },
    commandPolicy: {
      safeScripts: normalizeNames(
        config?.commandPolicy?.safeScripts,
        DEFAULT_TOOLING_CONFIG.commandPolicy.safeScripts,
      ),
      guardedScripts: normalizeNames(
        config?.commandPolicy?.guardedScripts,
        DEFAULT_TOOLING_CONFIG.commandPolicy.guardedScripts,
      ),
    },
  };
}

export async function readWorkspacePackageJson(): Promise<WorkspacePackageJson | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(getWorkspaceRoot(), "package.json"), "utf8"),
    ) as WorkspacePackageJson;
  } catch {
    return null;
  }
}

export async function detectPackageManager(): Promise<PackageManager> {
  for (const check of [
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "bun.lockb", manager: "bun" },
    { file: "bun.lock", manager: "bun" },
    { file: "package-lock.json", manager: "npm" },
  ] as const) {
    try {
      await fs.access(path.join(getWorkspaceRoot(), check.file));
      return check.manager;
    } catch {}
  }
  const userAgent = process.env.npm_config_user_agent || "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

export function pickScriptName(
  scripts: Record<string, string>,
  candidates: string[],
): string | undefined {
  return candidates.find((name) => scripts[name]?.trim());
}

export function detectRunnerByHints<T extends string>(
  command: string,
  hints: Record<T, string[]>,
): T | null {
  const normalized = command.trim().toLowerCase();
  for (const [runner, runnerHints] of Object.entries(hints) as Array<
    [T, string[]]
  >) {
    if (runnerHints.some((hint) => normalized.includes(hint.toLowerCase()))) {
      return runner;
    }
  }
  return null;
}
