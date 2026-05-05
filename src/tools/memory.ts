import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/agent.js";
import { getWorkspaceStateDir } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

export type ProjectMemory = {
  overview: string;
  preferences: string[];
  commands: string[];
  updatedAt?: string;
};

const SENSITIVE_MEMORY_PATTERN =
  /(api[_-]?key|token|secret|password|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

const EMPTY_MEMORY: ProjectMemory = {
  overview: "",
  preferences: [],
  commands: [],
};

function getProjectMemoryPath(): string {
  return path.join(getWorkspaceStateDir(), "project-memory.json");
}

export function sanitizeMemoryText(value: string): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return SENSITIVE_MEMORY_PATTERN.test(compacted) ? "" : compacted;
}

function compactUnique(items: string[] = []): string[] {
  return Array.from(
    new Set(items.map(sanitizeMemoryText).filter(Boolean)),
  ).slice(0, 50);
}

export function normalizeProjectMemory(
  input: Partial<ProjectMemory> = {},
): ProjectMemory {
  return {
    overview:
      typeof input.overview === "string"
        ? sanitizeMemoryText(input.overview)
        : "",
    preferences: compactUnique(input.preferences),
    commands: compactUnique(input.commands),
    ...(typeof input.updatedAt === "string"
      ? { updatedAt: input.updatedAt }
      : {}),
  };
}

export async function readProjectMemory(): Promise<ProjectMemory> {
  try {
    const content = await readFile(getProjectMemoryPath(), "utf8");
    return normalizeProjectMemory(
      JSON.parse(content) as Partial<ProjectMemory>,
    );
  } catch {
    return { ...EMPTY_MEMORY };
  }
}

export async function updateProjectMemory(
  update: Partial<ProjectMemory>,
): Promise<ProjectMemory> {
  const current = await readProjectMemory();
  const next = normalizeProjectMemory({
    overview: update.overview ?? current.overview,
    preferences: [...current.preferences, ...(update.preferences || [])],
    commands: [...current.commands, ...(update.commands || [])],
    updatedAt: new Date().toISOString(),
  });
  await mkdir(path.dirname(getProjectMemoryPath()), { recursive: true });
  await writeFile(
    getProjectMemoryPath(),
    JSON.stringify(next, null, 2),
    "utf8",
  );
  return next;
}

export const memoryTools: ToolDefinition[] = [
  createTool({
    name: "project_memory",
    description:
      "读取或更新跨会话项目记忆，包括项目画像、用户偏好、常用验证命令和发布策略；不要保存密钥或隐私数据",
    schema: z.object({
      action: z.enum(["read", "update"]),
      overview: z.string().optional(),
      preferences: z.array(z.string()).optional(),
      commands: z.array(z.string()).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "update"] },
        overview: { type: "string", description: "项目画像或架构摘要" },
        preferences: {
          type: "array",
          items: { type: "string" },
          description: "用户偏好或协作约定",
        },
        commands: {
          type: "array",
          items: { type: "string" },
          description: "常用验证、发布或诊断命令",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      const memory =
        input.action === "update"
          ? await updateProjectMemory({
              overview: input.overview,
              preferences: input.preferences,
              commands: input.commands,
            })
          : await readProjectMemory();
      return JSON.stringify(memory, null, 2);
    },
  }),
];
