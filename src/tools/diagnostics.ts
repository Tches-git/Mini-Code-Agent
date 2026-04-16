import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { normalizeFilePath } from "../utils/path.js";
import { createTool } from "./create-tool.js";

const DIAGNOSTICS_TIMEOUT_MS = 60_000;
const DIAGNOSTIC_LIMIT = 200;

type DiagnosticSeverity = "error" | "warning";
type DiagnosticSource = "tsc" | "biome";

type Diagnostic = {
  file?: string;
  line?: number;
  column?: number;
  severity: DiagnosticSeverity;
  message: string;
  source: DiagnosticSource;
  code?: string;
};

type DiagnosticsResult = {
  command: string;
  diagnostics: Diagnostic[];
  truncated: boolean;
};

type BiomeReporterDiagnostic = {
  location?: {
    path?: {
      file?: string;
    };
    span?: [number, number];
  };
  description?: string;
  severity?: string;
  category?: string;
};

type BiomeReporterSummary = {
  diagnostics?: {
    diagnostics?: BiomeReporterDiagnostic[];
  };
};

function normalizeDiagnosticFile(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const relative = path.relative(process.cwd(), filePath);
  return normalizeFilePath(relative.startsWith("..") ? filePath : relative);
}

function limitDiagnostics(diagnostics: Diagnostic[]): {
  diagnostics: Diagnostic[];
  truncated: boolean;
} {
  return {
    diagnostics: diagnostics.slice(0, DIAGNOSTIC_LIMIT),
    truncated: diagnostics.length > DIAGNOSTIC_LIMIT,
  };
}

function parseTscDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);
  const pattern = /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    diagnostics.push({
      file: normalizeDiagnosticFile(match[1]),
      line: Number.parseInt(match[2], 10),
      column: Number.parseInt(match[3], 10),
      severity: match[4] as DiagnosticSeverity,
      code: match[5],
      message: match[6].trim(),
      source: "tsc",
    });
  }

  return diagnostics;
}

function parseBiomeJsonOutput(output: string): Diagnostic[] {
  try {
    const parsed = JSON.parse(output) as BiomeReporterSummary;
    const items = parsed.diagnostics?.diagnostics || [];
    return items.map((item) => ({
      file: normalizeDiagnosticFile(item.location?.path?.file),
      severity: item.severity === "warning" ? "warning" : "error",
      message: item.description?.trim() || "未知 Biome 诊断信息",
      source: "biome",
      code: item.category,
    }));
  } catch {
    return [];
  }
}

function parseBiomeTextOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);
  const locationPattern = /^\s*([^(\s].*?):(\d+):(\d+)\s+(error|warning)\s+/i;

  for (const line of lines) {
    const match = line.match(locationPattern);
    if (!match) {
      continue;
    }

    diagnostics.push({
      file: normalizeDiagnosticFile(match[1]),
      line: Number.parseInt(match[2], 10),
      column: Number.parseInt(match[3], 10),
      severity: match[4].toLowerCase() === "warning" ? "warning" : "error",
      message: line.trim(),
      source: "biome",
    });
  }

  return diagnostics;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const result = await execa(command, args, {
    cwd: process.cwd(),
    reject: false,
    timeout: DIAGNOSTICS_TIMEOUT_MS,
  });

  if (result.failed && result.code === "ENOENT") {
    throw new Error(`命令不存在或不可执行: ${command}`);
  }

  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function readTypeScriptDiagnostics(): Promise<DiagnosticsResult> {
  const command = "tsc -p tsconfig.json --pretty false --noEmit";
  const output = await runCommand("tsc", [
    "-p",
    "tsconfig.json",
    "--pretty",
    "false",
    "--noEmit",
  ]);
  const parsed = limitDiagnostics(parseTscDiagnostics(output));
  return {
    command,
    diagnostics: parsed.diagnostics,
    truncated: parsed.truncated,
  };
}

async function readLintDiagnostics(): Promise<DiagnosticsResult> {
  const command = "biome check src --reporter json";
  const output = await runCommand("biome", [
    "check",
    "src",
    "--reporter",
    "json",
  ]);
  const diagnostics = parseBiomeJsonOutput(output);
  const parsed =
    diagnostics.length > 0
      ? limitDiagnostics(diagnostics)
      : limitDiagnostics(parseBiomeTextOutput(output));

  return {
    command,
    diagnostics: parsed.diagnostics,
    truncated: parsed.truncated,
  };
}

export const diagnosticsTools: ToolDefinition[] = [
  createTool({
    name: "read_diagnostics",
    description:
      "读取当前项目的结构化诊断信息，支持 TypeScript 编译错误和 Biome lint 错误",
    schema: z.object({
      target: z.enum(["tsc", "lint"]).default("tsc"),
    }),
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["tsc", "lint"],
          description:
            "诊断目标：tsc 表示 TypeScript 编译错误，lint 表示 Biome lint 错误",
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const result =
        input.target === "lint"
          ? await readLintDiagnostics()
          : await readTypeScriptDiagnostics();

      return JSON.stringify(result, null, 2);
    },
  }),
];

export type { Diagnostic, DiagnosticsResult };
export {
  parseBiomeJsonOutput,
  parseBiomeTextOutput,
  parseTscDiagnostics,
  readLintDiagnostics,
  readTypeScriptDiagnostics,
};
