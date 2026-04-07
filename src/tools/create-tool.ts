import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/agent.js";

/**
 * 创建带 zod 运行时校验的工具定义
 * - schema: zod schema，用于运行时校验输入
 * - inputSchema: JSON Schema，传给 OpenAI Function Calling
 * - execute: 收到的 input 已通过 zod 校验
 */
export function createTool<T extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: T;
  inputSchema: Record<string, unknown>;
  execute: (input: z.infer<T>) => Promise<string | ToolResult>;
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    async execute(rawInput: Record<string, unknown>) {
      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        throw new Error(`参数校验失败: ${issues}`);
      }
      return config.execute(parsed.data);
    }
  };
}

