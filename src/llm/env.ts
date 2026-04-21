import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getWorkspaceRoot } from "../utils/runtime.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL_NAME = "gpt-5.4";
export const DEFAULT_ENV_FILE_NAME = ".env";

export type RuntimeEnvInfo = {
  envFilePath: string;
  hasEnvFile: boolean;
  openaiApiKeyConfigured: boolean;
  openaiBaseUrl: string | null;
  modelName: string;
};

function isConfiguredValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim();
  return normalized.length > 0 && normalized !== "your-api-key-here";
}

export function getEnvFilePath(cwd = getWorkspaceRoot()): string {
  return path.resolve(cwd, DEFAULT_ENV_FILE_NAME);
}

export function loadWorkspaceEnv(cwd = getWorkspaceRoot()): void {
  dotenv.config({ path: getEnvFilePath(cwd), override: false });
}

export function buildEnvTemplate(): string {
  return [
    "OPENAI_API_KEY=your-api-key-here",
    "# 可选：兼容 OpenAI 协议的自定义端点",
    `OPENAI_BASE_URL=${DEFAULT_OPENAI_BASE_URL}`,
    "# 可选：默认模型名",
    `MODEL_NAME=${DEFAULT_MODEL_NAME}`,
    "",
    "# 额外允许的命令规则，支持精确匹配或前缀 *",
    "# RUN_COMMAND_ALLOWLIST=node *;npm run storybook",
    "# 强制要求确认的命令规则",
    "# RUN_COMMAND_GUARDLIST=pnpm install*;git push*",
    "# 额外阻止的命令规则",
    "# RUN_COMMAND_BLOCKLIST=npx *",
    "# 审批日志输出路径（默认 .mini-claude-code/command-approvals.ndjson）",
    "# RUN_COMMAND_AUDIT_LOG_PATH=.mini-claude-code/command-approvals.ndjson",
    "",
  ].join("\n");
}

export async function writeEnvTemplate(options?: {
  cwd?: string;
  force?: boolean;
}): Promise<{ path: string; overwritten: boolean }> {
  const envFilePath = getEnvFilePath(options?.cwd);
  await writeFile(envFilePath, buildEnvTemplate(), {
    flag: options?.force ? "w" : "wx",
  });
  return { path: envFilePath, overwritten: Boolean(options?.force) };
}

export function getRuntimeEnvInfo(): RuntimeEnvInfo {
  const envFilePath = getEnvFilePath(getWorkspaceRoot());
  return {
    envFilePath,
    hasEnvFile: existsSync(envFilePath),
    openaiApiKeyConfigured: isConfiguredValue(process.env.OPENAI_API_KEY),
    openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || null,
    modelName: process.env.MODEL_NAME?.trim() || DEFAULT_MODEL_NAME,
  };
}

function getMissingEnvMessage(name: string): string {
  const runtime = getRuntimeEnvInfo();
  if (name === "OPENAI_API_KEY") {
    if (runtime.hasEnvFile) {
      return `缺少环境变量: ${name}。已检测到 ${runtime.envFilePath}，请确认其中已配置 OPENAI_API_KEY，或先在 shell 中导出该变量。可先运行 \`mini-claude-code doctor\` 检查环境。`;
    }
    return `缺少环境变量: ${name}。当前目录未检测到 ${runtime.envFilePath}；可先运行 \`mini-claude-code init\` 生成模板，再填写 OPENAI_API_KEY，然后运行 \`mini-claude-code doctor\` 检查环境。`;
  }
  return `缺少环境变量: ${name}。请在 shell 或 ${runtime.envFilePath} 中设置后重试。`;
}

export function getEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!isConfiguredValue(value)) {
    throw new Error(getMissingEnvMessage(name));
  }
  return value as string;
}
