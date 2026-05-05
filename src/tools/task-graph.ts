import { z } from "zod";
import { getActiveTaskGraph } from "../agent/task-context.js";
import { createTool } from "./create-tool.js";

const taskStatusSchema = z.enum(["todo", "doing", "done", "blocked"]);

export const taskGraphTools = [
  createTool({
    name: "update_tasks",
    description:
      "显式创建或更新当前任务树，适合复杂任务中跟踪 todo/doing/done/blocked 和阻塞原因",
    schema: z.object({
      tasks: z
        .array(
          z.object({
            id: z.number().int().positive().optional(),
            title: z.string().min(1).optional(),
            status: taskStatusSchema,
            note: z.string().optional(),
            dependsOn: z.array(z.number().int().positive()).optional(),
            blockedReason: z.string().optional(),
          }),
        )
        .min(1),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "number",
                description: "已有任务 ID；不传则创建新任务",
              },
              title: {
                type: "string",
                description: "新任务标题，或更新时的说明",
              },
              status: {
                type: "string",
                enum: ["todo", "doing", "done", "blocked"],
              },
              note: { type: "string", description: "补充说明" },
              dependsOn: {
                type: "array",
                items: { type: "number" },
                description: "该任务依赖的任务 ID 列表",
              },
              blockedReason: {
                type: "string",
                description: "结构化阻塞原因，仅 blocked 状态需要",
              },
            },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(input) {
      const graph = getActiveTaskGraph();
      if (!graph) {
        return "当前没有活动任务树。";
      }
      const updated = input.tasks
        .map((task) => graph.apply(task))
        .filter((task) => task !== null);
      return `已更新 ${updated.length} 个任务:\n${graph.format().join("\n")}`;
    },
  }),
];
