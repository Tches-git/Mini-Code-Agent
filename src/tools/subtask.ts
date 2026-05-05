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

const subtaskSchema = z.object({
  task: z.string().min(1),
  context: z.string().optional(),
  maxRounds: z.number().int().min(1).max(3).optional(),
});

const subtaskBatchSchema = z.object({
  tasks: z.array(subtaskSchema).min(1).max(4),
});

export function getSubtaskTools(): ToolDefinition[] {
  return [
    ...fileTools,
    ...searchTools,
    ...commandTools,
    ...diagnosticsTools,
  ].filter((tool) => READ_ONLY_TOOLS.has(tool.name) && tool.name !== "task");
}

export async function runReadOnlySubtask(input: z.infer<typeof subtaskSchema>) {
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
  let response: LlmResponse = { text: "", toolCalls: [] };
  for (let round = 0; round < maxRounds; round++) {
    response = await llm.chat(messages, subtaskTools);
    if (response.toolCalls.length === 0) {
      return response.text || "子任务完成，但没有返回文本。";
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
  return response.text || `子任务达到最大只读探索轮数（${maxRounds}）后结束。`;
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
          description: "最多只读探索轮数，1-3，默认 2",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input) {
      return runReadOnlySubtask(input);
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
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              context: { type: "string" },
              maxRounds: { type: "number" },
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
      const results = await Promise.all(
        input.tasks.map(async (task, index) => ({
          index: index + 1,
          task: task.task,
          result: await runReadOnlySubtask(task),
        })),
      );
      return [
        `已完成 ${results.length} 个并发只读子任务。`,
        ...results.map(
          (item) => `\n## 子任务 ${item.index}: ${item.task}\n${item.result}`,
        ),
      ].join("\n");
    },
  }),
];
