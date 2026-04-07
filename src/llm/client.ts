import OpenAI from "openai";
import { getEnv } from "./env.js";
import type { ChatMessage, ToolDefinition } from "../types/agent.js";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";

export type ToolCall = {
  id: string;
  name: string;
  argumentsText: string;
};

export type LlmResponse = {
  text: string;
  toolCalls: ToolCall[];
};

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args_delta"; id: string; args: string }
  | { type: "done"; response: LlmResponse };

export function toChatParam(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === "tool") {
    return { role: "tool", content: m.content || "", tool_call_id: m.tool_call_id! };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.tool_calls && m.tool_calls.length > 0 ? { tool_calls: m.tool_calls } : {})
    };
  }
  return { role: m.role, content: m.content || "" };
}

export class LlmClient {
  private client = new OpenAI({
    apiKey: getEnv("OPENAI_API_KEY"),
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {})
  });
  private model = process.env.MODEL_NAME || "gpt-5.4";

  private buildToolsDef(tools: ToolDefinition[]) {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toChatParam),
      tools: this.buildToolsDef(tools)
    });

    const choice = response.choices[0]?.message;
    const toolCalls = (choice?.tool_calls || []).map((call) => ({
      id: call.id,
      name: call.function.name,
      argumentsText: call.function.arguments
    }));

    return {
      text: choice?.content || "",
      toolCalls
    };
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void
  ): Promise<LlmResponse> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toChatParam),
      tools: this.buildToolsDef(tools),
      stream: true
    });

    let text = "";
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // 文本流
      if (delta.content) {
        text += delta.content;
        onEvent({ type: "text_delta", text: delta.content });
      }

      // 工具调用流
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, { id: tc.id || "", name: tc.function?.name || "", args: "" });
            if (tc.id && tc.function?.name) {
              onEvent({ type: "tool_call_start", id: tc.id, name: tc.function.name });
            }
          }
          const entry = toolCallMap.get(idx)!;
          if (tc.id && !entry.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments;
            onEvent({ type: "tool_call_args_delta", id: entry.id, args: tc.function.arguments });
          }
        }
      }
    }

    const toolCalls: ToolCall[] = Array.from(toolCallMap.values()).map((entry) => ({
      id: entry.id,
      name: entry.name,
      argumentsText: entry.args
    }));

    const response: LlmResponse = { text, toolCalls };
    onEvent({ type: "done", response });
    return response;
  }
}

