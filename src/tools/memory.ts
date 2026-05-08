import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LlmClient } from "../llm/client.js";
import { getRuntimeEnvInfo } from "../llm/env.js";
import type { ToolDefinition } from "../types/agent.js";
import { buildDiffPreview } from "../utils/diff.js";
import { getWorkspaceStateDir } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

export type ProjectMemoryFact = {
  id?: string;
  text: string;
  source: "manual" | "auto";
  confidence: number;
  updatedAt: string;
  expiresAt?: string;
};

export type ProjectMemoryReviewItem = {
  key: string;
  kind: "preference" | "command" | "fact";
  text: string;
  label: string;
  confidence?: number;
  expiresAt?: string;
  conflict?: string;
};

export type ProjectMemoryReview = {
  proposed: ProjectMemory;
  diff: string;
  candidates?: Partial<ProjectMemory>;
  items?: ProjectMemoryReviewItem[];
};

export type ProjectMemoryReviewDecision =
  | "accept"
  | "reject"
  | { update: Partial<ProjectMemory> };

export type ProjectMemoryReviewHandler = (
  review: ProjectMemoryReview,
) => Promise<ProjectMemoryReviewDecision>;

export type ProjectMemory = {
  overview: string;
  preferences: string[];
  commands: string[];
  facts?: ProjectMemoryFact[];
  updatedAt?: string;
};

const PROJECT_MEMORY_FACT_TTL_DAYS = 90;
export const PROJECT_MEMORY_CONTEXT_PREFIX = "项目长期记忆：";

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

function clampConfidence(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.max(0.1, Math.min(1, value || 0.6))
    : 0.6;
}

function getFactAgeDays(fact: ProjectMemoryFact, now: Date): number {
  const updatedAt = Date.parse(fact.updatedAt);
  if (!Number.isFinite(updatedAt)) return 0;
  return Math.max(0, (now.getTime() - updatedAt) / 86_400_000);
}

function getDecayedConfidence(fact: ProjectMemoryFact, now: Date): number {
  const ageDays = getFactAgeDays(fact, now);
  const decay = Math.max(0.45, 1 - ageDays / 360);
  return clampConfidence(fact.confidence * decay);
}

function getFactId(text: string): string {
  const normalized = text
    .replace(/^(最近关注文件|常用验证命令|偏好|项目画像)[:：]\s*/i, "")
    .toLowerCase();
  return normalized
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function getFactExpiry(updatedAt: string): string {
  const expiresAt = new Date(updatedAt);
  expiresAt.setDate(expiresAt.getDate() + PROJECT_MEMORY_FACT_TTL_DAYS);
  return expiresAt.toISOString();
}

function normalizeMemoryFacts(
  facts: ProjectMemoryFact[] = [],
  now = new Date(),
): ProjectMemoryFact[] {
  const byId = new Map<string, ProjectMemoryFact>();
  for (const fact of facts) {
    const text = sanitizeMemoryText(fact.text || "");
    if (!text) continue;
    if (fact.expiresAt && Date.parse(fact.expiresAt) < now.getTime()) continue;
    const updatedAt = Number.isFinite(Date.parse(fact.updatedAt))
      ? fact.updatedAt
      : now.toISOString();
    const id = sanitizeMemoryText(fact.id || "") || getFactId(text);
    const next: ProjectMemoryFact = {
      id,
      text,
      source: fact.source === "auto" ? "auto" : "manual",
      confidence: getDecayedConfidence(
        { ...fact, confidence: clampConfidence(fact.confidence), updatedAt },
        now,
      ),
      updatedAt,
      expiresAt:
        typeof fact.expiresAt === "string"
          ? fact.expiresAt
          : getFactExpiry(updatedAt),
    };
    const previous = byId.get(id);
    if (
      !previous ||
      next.confidence > previous.confidence ||
      (next.confidence === previous.confidence &&
        next.updatedAt.localeCompare(previous.updatedAt) > 0)
    ) {
      byId.set(id, next);
    }
  }
  return Array.from(byId.values())
    .sort(
      (a, b) =>
        b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, 50);
}

export function normalizeProjectMemory(
  input: Partial<ProjectMemory> = {},
): ProjectMemory {
  const facts = normalizeMemoryFacts(input.facts);
  return {
    overview:
      typeof input.overview === "string"
        ? sanitizeMemoryText(input.overview)
        : "",
    preferences: compactUnique(input.preferences),
    commands: compactUnique(input.commands),
    ...(facts.length > 0 ? { facts } : {}),
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

function summarizeMemoryOverview(memory: ProjectMemory): string {
  if (memory.overview) return memory.overview;
  const facts = memory.facts?.map((fact) => fact.text).slice(0, 3) || [];
  const commands = memory.commands.slice(0, 3);
  return [...facts, ...commands].join("；").slice(0, 240);
}

function serializeProjectMemory(memory: ProjectMemory): string {
  return JSON.stringify(normalizeProjectMemory(memory), null, 2);
}

function createMemoryReviewItems(
  current: ProjectMemory,
  candidates: Partial<ProjectMemory>,
): ProjectMemoryReviewItem[] {
  const existingText = new Map<string, ProjectMemoryFact>();
  for (const fact of current.facts || []) {
    existingText.set(getFactId(fact.text), fact);
  }
  return [
    ...(candidates.preferences || []).map<ProjectMemoryReviewItem>((text) => ({
      key: `preference:${text}`,
      kind: "preference",
      text,
      label: `偏好: ${text}`,
    })),
    ...(candidates.commands || []).map<ProjectMemoryReviewItem>((text) => ({
      key: `command:${text}`,
      kind: "command",
      text,
      label: `命令: ${text}`,
    })),
    ...(candidates.facts || []).map<ProjectMemoryReviewItem>((fact) => {
      const conflict = existingText.get(getFactId(fact.text));
      return {
        key: `fact:${fact.id || getFactId(fact.text)}`,
        kind: "fact",
        text: fact.text,
        label: `事实: ${fact.text}`,
        confidence: fact.confidence,
        expiresAt: fact.expiresAt,
        ...(conflict ? { conflict: `可能更新已有事实: ${conflict.text}` } : {}),
      };
    }),
  ];
}

export function selectProjectMemoryCandidates(
  candidates: Partial<ProjectMemory> = {},
  selectedKeys: string[],
): Partial<ProjectMemory> {
  const selected = new Set(selectedKeys);
  return {
    preferences: (candidates.preferences || []).filter((text) =>
      selected.has(`preference:${text}`),
    ),
    commands: (candidates.commands || []).filter((text) =>
      selected.has(`command:${text}`),
    ),
    facts: (candidates.facts || []).filter((fact) =>
      selected.has(`fact:${fact.id || getFactId(fact.text)}`),
    ),
  };
}

export function editProjectMemoryCandidateText(
  candidates: Partial<ProjectMemory> = {},
  key: string,
  text: string,
): Partial<ProjectMemory> {
  const nextText = sanitizeMemoryText(text);
  if (!nextText) return candidates;
  return {
    ...candidates,
    preferences: (candidates.preferences || []).map((item) =>
      key === `preference:${item}` ? nextText : item,
    ),
    commands: (candidates.commands || []).map((item) =>
      key === `command:${item}` ? nextText : item,
    ),
    facts: (candidates.facts || []).map((fact) =>
      key === `fact:${fact.id || getFactId(fact.text)}`
        ? { ...fact, id: key.replace(/^fact:/, ""), text: nextText }
        : fact,
    ),
  };
}

function createMemoryReview(
  current: ProjectMemory,
  proposed: ProjectMemory,
  candidates?: Partial<ProjectMemory>,
): ProjectMemoryReview {
  return {
    proposed,
    ...(candidates ? { candidates } : {}),
    ...(candidates
      ? { items: createMemoryReviewItems(current, candidates) }
      : {}),
    diff: buildDiffPreview(
      serializeProjectMemory(current),
      serializeProjectMemory(proposed),
      "project-memory.json",
    ),
  };
}

function mergeProjectMemory(
  current: ProjectMemory,
  update: Partial<ProjectMemory>,
): ProjectMemory {
  const merged = normalizeProjectMemory({
    overview: update.overview ?? current.overview,
    preferences: [...current.preferences, ...(update.preferences || [])],
    commands: [...current.commands, ...(update.commands || [])],
    facts: [...(current.facts || []), ...(update.facts || [])],
    updatedAt: new Date().toISOString(),
  });
  return normalizeProjectMemory({
    ...merged,
    overview: summarizeMemoryOverview(merged),
  });
}

export async function reviewProjectMemoryUpdate(
  update: Partial<ProjectMemory>,
): Promise<ProjectMemoryReview> {
  const current = await readProjectMemory();
  return createMemoryReview(current, mergeProjectMemory(current, update));
}

export async function updateProjectMemory(
  update: Partial<ProjectMemory>,
): Promise<ProjectMemory> {
  const current = await readProjectMemory();
  const next = mergeProjectMemory(current, update);
  await mkdir(path.dirname(getProjectMemoryPath()), { recursive: true });
  await writeFile(getProjectMemoryPath(), serializeProjectMemory(next), "utf8");
  return next;
}

function extractCommandFacts(text: string): string[] {
  const commands = new Set<string>();
  const commandPattern =
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[a-z0-9:_-]+(?:\s+--\s+[^\n。；;]+)?/gi;
  for (const match of text.matchAll(commandPattern)) {
    commands.add(match[0].trim());
  }
  return Array.from(commands).slice(0, 8);
}

function extractPreferenceFacts(text: string): string[] {
  const preferences: string[] = [];
  if (/简洁|concise|short output/i.test(text)) {
    preferences.push("默认输出保持简洁，优先给出结果和验证状态");
  }
  if (
    /npm run lint/.test(text) &&
    /npm test/.test(text) &&
    /npm run build/.test(text)
  ) {
    preferences.push(
      "常规代码改动后运行 npm run lint、npm test、npm run build 验证",
    );
  }
  return preferences;
}

export async function summarizeProjectMemoryWithLlm(
  memory: ProjectMemory,
): Promise<string> {
  const fallback = summarizeMemoryOverview(memory);
  try {
    const response = await new LlmClient().chat(
      [
        {
          role: "user",
          content: [
            "请把下面的项目长期记忆压缩成不超过 120 字的项目画像。",
            "只保留稳定事实、技术栈、常用验证方式和协作偏好；不要包含密钥、邮箱或一次性任务流水。",
            JSON.stringify(memory, null, 2),
          ].join("\n"),
        },
      ],
      [],
    );
    return sanitizeMemoryText(response.text).slice(0, 240) || fallback;
  } catch {
    return fallback;
  }
}

export function extractProjectMemoryCandidates(input: {
  finalText?: string;
  steps?: string[];
  modifiedPaths?: string[];
  validationCommands?: string[];
  summaryLines?: string[];
}): Partial<ProjectMemory> {
  const text = [
    input.finalText,
    ...(input.steps || []),
    ...(input.summaryLines || []),
  ]
    .filter(Boolean)
    .join("\n");
  const commands = compactUnique([
    ...(input.validationCommands || []),
    ...extractCommandFacts(text),
  ]);
  const preferences = compactUnique(extractPreferenceFacts(text));
  const now = new Date().toISOString();
  const facts = compactUnique([
    ...(input.modifiedPaths?.length
      ? [`最近关注文件: ${input.modifiedPaths.slice(0, 8).join(", ")}`]
      : []),
    ...(commands.length ? [`常用验证命令: ${commands.join(" && ")}`] : []),
  ]).map<ProjectMemoryFact>((fact) => ({
    text: fact,
    source: "auto",
    confidence: 0.6,
    updatedAt: now,
    expiresAt: getFactExpiry(now),
  }));
  return { preferences, commands, facts };
}

function getEditedProjectMemory(
  current: ProjectMemory,
  options: {
    overview?: string;
    removeFactIds?: string[];
    removeFacts?: string[];
    clear?: boolean;
  },
): ProjectMemory {
  if (options.clear) {
    return { ...EMPTY_MEMORY, updatedAt: new Date().toISOString() };
  }
  const removeIds = new Set(options.removeFactIds || []);
  const removeTexts = new Set(
    (options.removeFacts || []).map(sanitizeMemoryText),
  );
  const facts = (current.facts || []).filter(
    (fact) => !removeIds.has(fact.id || "") && !removeTexts.has(fact.text),
  );
  return normalizeProjectMemory({
    ...current,
    overview: options.overview ?? current.overview,
    facts,
    updatedAt: new Date().toISOString(),
  });
}

export async function reviewProjectMemoryEdit(options: {
  overview?: string;
  removeFactIds?: string[];
  removeFacts?: string[];
  clear?: boolean;
}): Promise<ProjectMemoryReview> {
  const current = await readProjectMemory();
  return createMemoryReview(current, getEditedProjectMemory(current, options));
}

export async function editProjectMemory(options: {
  overview?: string;
  removeFactIds?: string[];
  removeFacts?: string[];
  clear?: boolean;
}): Promise<ProjectMemory> {
  const current = await readProjectMemory();
  const next = getEditedProjectMemory(current, options);
  await mkdir(path.dirname(getProjectMemoryPath()), { recursive: true });
  await writeFile(getProjectMemoryPath(), serializeProjectMemory(next), "utf8");
  return next;
}

export async function rememberProjectMemoryFromRun(input: {
  finalText?: string;
  steps?: string[];
  modifiedPaths?: string[];
  validationCommands?: string[];
  summaryLines?: string[];
}): Promise<ProjectMemory | null> {
  const candidates = extractProjectMemoryCandidates(input);
  if (
    !candidates.preferences?.length &&
    !candidates.commands?.length &&
    !candidates.facts?.length
  ) {
    return null;
  }
  const current = await readProjectMemory();
  const proposed = mergeProjectMemory(current, candidates);
  if (getRuntimeEnvInfo().openaiApiKeyConfigured) {
    proposed.overview = await summarizeProjectMemoryWithLlm(proposed);
  }
  await mkdir(path.dirname(getProjectMemoryPath()), { recursive: true });
  await writeFile(
    getProjectMemoryPath(),
    serializeProjectMemory(proposed),
    "utf8",
  );
  return proposed;
}

export async function rememberProjectMemoryFromRunWithReview(
  input: {
    finalText?: string;
    steps?: string[];
    modifiedPaths?: string[];
    validationCommands?: string[];
    summaryLines?: string[];
  },
  reviewHandler: ProjectMemoryReviewHandler,
): Promise<ProjectMemory | null> {
  const candidates = extractProjectMemoryCandidates(input);
  if (
    !candidates.preferences?.length &&
    !candidates.commands?.length &&
    !candidates.facts?.length
  ) {
    return null;
  }
  const current = await readProjectMemory();
  const proposed = mergeProjectMemory(current, candidates);
  if (getRuntimeEnvInfo().openaiApiKeyConfigured) {
    proposed.overview = await summarizeProjectMemoryWithLlm(proposed);
  }
  const decision = await reviewHandler(
    createMemoryReview(current, proposed, candidates),
  );
  if (decision === "reject") return null;
  const accepted =
    decision === "accept"
      ? proposed
      : mergeProjectMemory(current, decision.update);
  await mkdir(path.dirname(getProjectMemoryPath()), { recursive: true });
  await writeFile(
    getProjectMemoryPath(),
    serializeProjectMemory(accepted),
    "utf8",
  );
  return accepted;
}

export async function getProjectMemoryContext(): Promise<string | null> {
  const memory = await readProjectMemory();
  const lines = [
    memory.overview ? `项目画像: ${memory.overview}` : "",
    memory.preferences.length
      ? `偏好: ${memory.preferences.slice(0, 5).join("; ")}`
      : "",
    memory.commands.length
      ? `常用命令: ${memory.commands.slice(0, 5).join("; ")}`
      : "",
    memory.facts?.length
      ? `事实: ${memory.facts
          .slice(0, 5)
          .map((fact) => fact.text)
          .join("; ")}`
      : "",
  ].filter(Boolean);
  return lines.length
    ? `${PROJECT_MEMORY_CONTEXT_PREFIX}\n${lines.join("\n")}`
    : null;
}

export const memoryTools: ToolDefinition[] = [
  createTool({
    name: "project_memory",
    description:
      "读取或更新跨会话项目记忆，包括项目画像、用户偏好、常用验证命令和发布策略；不要保存密钥或隐私数据",
    schema: z.object({
      action: z.enum(["read", "update", "edit", "clear", "review"]),
      overview: z.string().optional(),
      removeFactIds: z.array(z.string()).optional(),
      removeFacts: z.array(z.string()).optional(),
      preferences: z.array(z.string()).optional(),
      commands: z.array(z.string()).optional(),
      facts: z
        .array(
          z.object({
            id: z.string().optional(),
            text: z.string(),
            source: z.enum(["manual", "auto"]).optional(),
            confidence: z.number().optional(),
            updatedAt: z.string().optional(),
            expiresAt: z.string().optional(),
          }),
        )
        .optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "update", "edit", "clear", "review"],
          description:
            "read 读取；update 写入；edit 删除或改画像；clear 清空；review 只返回拟议改动 diff，不写入",
        },
        overview: { type: "string", description: "项目画像或架构摘要" },
        removeFactIds: {
          type: "array",
          items: { type: "string" },
          description: "edit 时按事实 id 删除记忆",
        },
        removeFacts: {
          type: "array",
          items: { type: "string" },
          description: "edit 时按事实文本删除记忆",
        },
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
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              source: { type: "string", enum: ["manual", "auto"] },
              confidence: { type: "number" },
              updatedAt: { type: "string" },
              expiresAt: { type: "string" },
            },
            required: ["text"],
            additionalProperties: false,
          },
          description: "带来源、置信度和过期时间的项目事实",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      if (input.action === "clear") {
        return JSON.stringify(
          await editProjectMemory({ clear: true }),
          null,
          2,
        );
      }
      if (input.action === "edit") {
        return JSON.stringify(
          await editProjectMemory({
            overview: input.overview,
            removeFactIds: input.removeFactIds,
            removeFacts: input.removeFacts,
          }),
          null,
          2,
        );
      }
      if (input.action === "review") {
        return JSON.stringify(
          input.removeFactIds?.length || input.removeFacts?.length
            ? await reviewProjectMemoryEdit({
                overview: input.overview,
                removeFactIds: input.removeFactIds,
                removeFacts: input.removeFacts,
              })
            : await reviewProjectMemoryUpdate({
                overview: input.overview,
                preferences: input.preferences,
                commands: input.commands,
                facts: input.facts?.map((fact) => ({
                  id: fact.id,
                  text: fact.text,
                  source: fact.source || "manual",
                  confidence: fact.confidence ?? 0.6,
                  updatedAt: fact.updatedAt || new Date().toISOString(),
                  expiresAt: fact.expiresAt,
                })),
              }),
          null,
          2,
        );
      }
      const memory =
        input.action === "update"
          ? await updateProjectMemory({
              overview: input.overview,
              preferences: input.preferences,
              commands: input.commands,
              facts: input.facts?.map((fact) => ({
                id: fact.id,
                text: fact.text,
                source: fact.source || "manual",
                confidence: fact.confidence ?? 0.6,
                updatedAt: fact.updatedAt || new Date().toISOString(),
                expiresAt: fact.expiresAt,
              })),
            })
          : await readProjectMemory();
      return JSON.stringify(memory, null, 2);
    },
  }),
];
