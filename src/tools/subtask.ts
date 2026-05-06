import { z } from "zod";
import { READ_ONLY_TOOLS } from "../agent/orchestrator-config.js";
import { SYSTEM_PROMPT } from "../agent/prompts.js";
import { LlmClient } from "../llm/client.js";
import type { ChatMessage, ToolDefinition } from "../types/agent.js";
import type { LlmResponse } from "../types/llm.js";
import { commandTools } from "./command.js";
import { createTool } from "./create-tool.js";
import { diagnosticsTools } from "./diagnostics.js";
import { fileTools } from "./filesystem.js";
import { searchTools } from "./search.js";

const SUBTASK_MAX_CONCURRENCY = 2;
const SUBTASK_MAX_OUTPUT_LENGTH = 4000;
const SUBTASK_CACHE_TTL_MS = 10 * 60 * 1000;
const SUBTASK_TOKEN_BUDGET = 12000;
const SUBTASK_MAX_RETRIES = 1;
const subtaskResultCache = new Map<
  string,
  { report: SubtaskRunReport; expiresAt: number }
>();

const subtaskSchema = z.object({
  task: z.string().min(1),
  context: z.string().optional(),
  maxRounds: z.number().int().min(1).max(5).optional(),
  maxOutputLength: z.number().int().min(500).max(12000).optional(),
});

const subtaskBatchSchema = z.object({
  tasks: z.array(subtaskSchema).min(1).max(6),
  tokenBudget: z.number().int().min(1000).max(60000).optional(),
  maxConcurrency: z.number().int().min(1).max(4).optional(),
  cacheTtlMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1000)
    .optional(),
  maxRetries: z.number().int().min(0).max(2).optional(),
  cancelAfterTasks: z.number().int().min(0).max(6).optional(),
});

export function clearSubtaskResultCache() {
  subtaskResultCache.clear();
}

export type SubtaskRunReport = {
  status: "done" | "failed" | "truncated";
  task: string;
  result: string;
  roundsUsed: number;
  estimatedTokens: number;
  attempts?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  cached?: boolean;
  cacheExpiresAt?: string;
  retrySuggestion?: string;
  error?: string;
};

function estimateSubtaskTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getRetrySuggestion(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("busy") || lower.includes("timeout")) {
    return "提供方繁忙或超时，稍后重试或降低并发/轮数。";
  }
  if (lower.includes("json") || lower.includes("parse")) {
    return "工具参数解析失败，建议收窄任务并明确需要读取的文件。";
  }
  return "建议缩小子任务范围后重试。";
}

function getSubtaskCacheKey(input: z.infer<typeof subtaskSchema>): string {
  return JSON.stringify({
    task: input.task,
    context: input.context || "",
    maxRounds: input.maxRounds ?? 2,
    maxOutputLength: input.maxOutputLength ?? SUBTASK_MAX_OUTPUT_LENGTH,
  });
}

function cacheSubtaskReport(
  key: string,
  report: SubtaskRunReport,
  cacheTtlMs = SUBTASK_CACHE_TTL_MS,
) {
  if (cacheTtlMs <= 0) return;
  const expiresAt = Date.now() + cacheTtlMs;
  subtaskResultCache.set(key, {
    report: { ...report, cacheExpiresAt: new Date(expiresAt).toISOString() },
    expiresAt,
  });
}

function truncateSubtaskResult(
  result: string,
  maxOutputLength = SUBTASK_MAX_OUTPUT_LENGTH,
): Pick<SubtaskRunReport, "status" | "result"> {
  if (result.length <= maxOutputLength) {
    return { status: "done", result };
  }
  return {
    status: "truncated",
    result: `${result.slice(0, maxOutputLength)}\n... 子任务输出已截断`,
  };
}

export function getSubtaskTools(): ToolDefinition[] {
  return [
    ...fileTools,
    ...searchTools,
    ...commandTools,
    ...diagnosticsTools,
  ].filter((tool) => READ_ONLY_TOOLS.has(tool.name) && tool.name !== "task");
}

export async function runReadOnlySubtask(
  input: z.infer<typeof subtaskSchema>,
  options?: { cacheTtlMs?: number },
): Promise<SubtaskRunReport> {
  const cacheKey = getSubtaskCacheKey(input);
  const cached = subtaskResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.report, cached: true };
  }
  if (cached) {
    subtaskResultCache.delete(cacheKey);
  }
  const startedAt = new Date();
  const llm = new LlmClient();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "你是只读子任务代理。只能分析、搜索、读取和总结，不能修改文件，不能执行命令。",
        input.context ? `背景: ${input.context}` : "",
        `子任务: ${input.task}`,
        "请返回简洁结论、关键文件路径和建议的下一步。",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  const subtaskTools = getSubtaskTools();
  const maxRounds = input.maxRounds ?? 2;
  const maxOutputLength = input.maxOutputLength ?? SUBTASK_MAX_OUTPUT_LENGTH;
  let response: LlmResponse = { text: "", toolCalls: [] };
  for (let round = 0; round < maxRounds; round++) {
    response = await llm.chat(messages, subtaskTools);
    if (response.toolCalls.length === 0) {
      const text = response.text || "子任务完成，但没有返回文本。";
      const truncated = truncateSubtaskResult(text, maxOutputLength);
      const finishedAt = new Date();
      const report: SubtaskRunReport = {
        task: input.task,
        roundsUsed: round + 1,
        estimatedTokens: estimateSubtaskTokens(text),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        ...truncated,
      };
      cacheSubtaskReport(cacheKey, report, options?.cacheTtlMs);
      return report;
    }
    messages.push({
      role: "assistant",
      content: response.text || null,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.argumentsText },
      })),
    });
    const toolMap = new Map(subtaskTools.map((tool) => [tool.name, tool]));
    for (const call of response.toolCalls) {
      const tool = toolMap.get(call.name);
      const args = JSON.parse(call.argumentsText || "{}");
      const toolResult = tool
        ? await tool.execute(args)
        : `未知只读子任务工具: ${call.name}`;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content:
          typeof toolResult === "string" ? toolResult : toolResult.message,
      });
    }
  }
  const text =
    response.text || `子任务达到最大只读探索轮数（${maxRounds}）后结束。`;
  const truncated = truncateSubtaskResult(text, maxOutputLength);
  const finishedAt = new Date();
  const report: SubtaskRunReport = {
    task: input.task,
    roundsUsed: maxRounds,
    estimatedTokens: estimateSubtaskTokens(text),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...truncated,
    status: truncated.status === "done" ? "truncated" : truncated.status,
    retrySuggestion: "已达到子任务最大轮数，建议缩小问题范围或提高 maxRounds。",
  };
  cacheSubtaskReport(cacheKey, report, options?.cacheTtlMs);
  return report;
}

export const subtaskTools: ToolDefinition[] = [
  createTool({
    name: "task",
    description:
      "启动一个只读子任务代理，用独立上下文分析目录、定位问题或汇总信息；子任务不能修改文件或运行命令",
    schema: subtaskSchema,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "要委派给子任务代理的具体只读任务",
        },
        context: { type: "string", description: "主任务已知背景，可选" },
        maxRounds: {
          type: "number",
          description: "最多只读探索轮数，1-5，默认 2",
        },
        maxOutputLength: {
          type: "number",
          description: "单个子任务最大输出字符数，默认 4000",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input) {
      return JSON.stringify(await runReadOnlySubtask(input), null, 2);
    },
  }),
  createTool({
    name: "task_batch",
    description:
      "并发启动多个只读子任务代理，适合并行分析多个目录、模块或候选问题；每批最多 4 个子任务",
    schema: subtaskBatchSchema,
    inputSchema: {
      type: "object",
      properties: {
        tokenBudget: {
          type: "number",
          description: "可选，整批子任务估算 token 预算，默认 12000",
        },
        maxConcurrency: {
          type: "number",
          description: "可选，整批最大并发数，1-4，默认 2",
        },
        cacheTtlMs: {
          type: "number",
          description: "可选，缓存 TTL 毫秒；传 0 禁用写入缓存",
        },
        maxRetries: {
          type: "number",
          description: "可选，失败子任务自动重试次数，0-2，默认 1",
        },
        cancelAfterTasks: {
          type: "number",
          description:
            "可选，完成指定数量子任务后取消剩余任务，用于预算或人工中止模拟",
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              context: { type: "string" },
              maxRounds: { type: "number" },
              maxOutputLength: { type: "number" },
            },
            required: ["task"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(input) {
      const results: Array<SubtaskRunReport & { index: number }> = [];
      const tokenBudget = input.tokenBudget || SUBTASK_TOKEN_BUDGET;
      const maxConcurrency = input.maxConcurrency || SUBTASK_MAX_CONCURRENCY;
      const maxRetries = input.maxRetries ?? SUBTASK_MAX_RETRIES;
      const cacheTtlMs = input.cacheTtlMs ?? SUBTASK_CACHE_TTL_MS;
      const cancelAfterTasks = input.cancelAfterTasks;
      let usedTokens = 0;
      let retryCount = 0;
      const startedAt = new Date();
      for (let index = 0; index < input.tasks.length; index += maxConcurrency) {
        if (
          cancelAfterTasks !== undefined &&
          results.length >= cancelAfterTasks
        ) {
          results.push(
            ...input.tasks.slice(index).map((task, offset) => ({
              index: index + offset + 1,
              task: task.task,
              status: "truncated" as const,
              result: "",
              roundsUsed: 0,
              estimatedTokens: 0,
              retrySuggestion: "子任务批次已取消，剩余任务未启动。",
            })),
          );
          break;
        }
        if (usedTokens >= tokenBudget) {
          results.push(
            ...input.tasks.slice(index).map((task, offset) => ({
              index: index + offset + 1,
              task: task.task,
              status: "truncated" as const,
              result: "",
              roundsUsed: 0,
              estimatedTokens: 0,
              retrySuggestion: "整批子任务 token 预算已耗尽，建议拆分批次。",
            })),
          );
          break;
        }
        const chunk = input.tasks.slice(index, index + maxConcurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (task, chunkIndex) => {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              try {
                return {
                  index: index + chunkIndex + 1,
                  progress: `${Math.min(index + chunkIndex + 1, input.tasks.length)}/${input.tasks.length}`,
                  attempts: attempt + 1,
                  ...(await runReadOnlySubtask(task, { cacheTtlMs })),
                };
              } catch (error) {
                if (attempt < maxRetries) {
                  retryCount += 1;
                  continue;
                }
                const errorText =
                  error instanceof Error ? error.message : String(error);
                return {
                  index: index + chunkIndex + 1,
                  task: task.task,
                  status: "failed" as const,
                  result: "",
                  roundsUsed: 0,
                  estimatedTokens: 0,
                  attempts: attempt + 1,
                  error: errorText,
                  retrySuggestion: getRetrySuggestion(errorText),
                };
              }
            }
            return {
              index: index + chunkIndex + 1,
              task: task.task,
              status: "failed" as const,
              result: "",
              roundsUsed: 0,
              estimatedTokens: 0,
              attempts: maxRetries + 1,
              retrySuggestion: "重试调度异常，建议拆分该子任务后重试。",
            };
          }),
        );
        results.push(...chunkResults);
        usedTokens += chunkResults.reduce(
          (sum, item) => sum + item.estimatedTokens,
          0,
        );
      }
      return JSON.stringify(
        {
          status: results.some((item) => item.status === "failed")
            ? "failed"
            : results.some((item) => item.status === "truncated")
              ? "truncated"
              : "done",
          maxConcurrency,
          maxRetries,
          retryCount,
          tokenBudget,
          usedTokens,
          cacheTtlMs,
          canceled: results.some((item) =>
            item.retrySuggestion?.includes("已取消"),
          ),
          durationMs: Date.now() - startedAt.getTime(),
          results,
        },
        null,
        2,
      );
    },
  }),
];
