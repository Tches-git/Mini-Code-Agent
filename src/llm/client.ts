import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import type { ChatMessage, ToolDefinition } from "../types/agent.js";
import type { LlmResponse, StreamEvent, ToolCall } from "../types/llm.js";
import { DEFAULT_MODEL_NAME, getEnv } from "./env.js";

export type ConnectivityCheckResult = {
  ok: boolean;
  detail: string;
};

const CONNECTIVITY_PROBE_TOOLS: ToolDefinition[] = [
  {
    name: "ping",
    description: "Connectivity probe tool",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    async execute() {
      return "ok";
    },
  },
];

export function toChatParam(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content || "",
      tool_call_id: m.tool_call_id ?? "",
    };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.tool_calls && m.tool_calls.length > 0
        ? { tool_calls: m.tool_calls }
        : {}),
    };
  }
  return { role: m.role, content: m.content || "" };
}

export class LlmClient {
  private client = new OpenAI({
    apiKey: getEnv("OPENAI_API_KEY"),
    ...(process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : {}),
  });
  private model = process.env.MODEL_NAME || DEFAULT_MODEL_NAME;

  async checkConnectivity(): Promise<ConnectivityCheckResult> {
    let modelListError: string | null = null;
    let hasConfiguredModel = false;

    try {
      const response = await this.client.models.list();
      const models = response.data.map((model) => model.id);
      hasConfiguredModel = models.includes(this.model);
    } catch (error) {
      modelListError = error instanceof Error ? error.message : String(error);
    }

    try {
      const probe = await this.chatStream(
        [{ role: "user", content: "Return exactly CALL_PING." }],
        CONNECTIVITY_PROBE_TOOLS,
        () => {},
      );
      const toolCallSucceeded =
        probe.toolCalls.length > 0 && probe.toolCalls[0]?.name === "ping";
      if (!toolCallSucceeded) {
        return {
          ok: false,
          detail: hasConfiguredModel
            ? `API 连通并发现模型 ${this.model}，但 tool-calling 探测未通过`
            : modelListError
              ? `chat/tool-calling 可达性待验证失败，且 models.list 不可用: ${modelListError}`
              : `API 连通，但未在 models.list 中发现 ${this.model}，且 tool-calling 探测未通过`,
        };
      }
      return {
        ok: true,
        detail: hasConfiguredModel
          ? `API 连通，模型 ${this.model} 可完成 chat/tool-calling 探测`
          : modelListError
            ? `API 连通且可完成 chat/tool-calling 探测；models.list 不可用，可忽略于部分兼容提供方: ${modelListError}`
            : `API 连通并可完成 chat/tool-calling 探测，但未在 models.list 中发现 ${this.model}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private shouldFallbackToNonStream(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    return (
      message.includes("connection error") ||
      message.includes("stream") ||
      message.includes("sse") ||
      message.includes("epipe") ||
      message.includes("econnreset") ||
      message.includes("socket hang up")
    );
  }

  private buildToolsDef(tools: ToolDefinition[]) {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toChatParam),
      tools: this.buildToolsDef(tools),
    });

    const choice = response.choices[0]?.message;
    const toolCalls = (choice?.tool_calls || []).map((call) => ({
      id: call.id,
      name: call.function.name,
      argumentsText: call.function.arguments,
    }));

    return {
      text: choice?.content || "",
      toolCalls,
    };
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void,
  ): Promise<LlmResponse> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: messages.map(toChatParam),
        tools: this.buildToolsDef(tools),
        stream: true,
      });

      let text = "";
      const toolCallMap = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          onEvent({ type: "text_delta", text: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, {
                id: tc.id || "",
                name: tc.function?.name || "",
                args: "",
              });
              if (tc.id && tc.function?.name) {
                onEvent({
                  type: "tool_call_start",
                  id: tc.id,
                  name: tc.function.name,
                });
              }
            }
            const entry = toolCallMap.get(idx);
            if (!entry) continue;
            if (tc.id && !entry.id) entry.id = tc.id;
            if (tc.function?.name && !entry.name) entry.name = tc.function.name;
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments;
              onEvent({
                type: "tool_call_args_delta",
                id: entry.id,
                args: tc.function.arguments,
              });
            }
          }
        }
      }

      const toolCalls: ToolCall[] = Array.from(toolCallMap.values()).map(
        (entry) => ({
          id: entry.id,
          name: entry.name,
          argumentsText: entry.args,
        }),
      );

      const response: LlmResponse = { text, toolCalls };
      onEvent({ type: "done", response });
      return response;
    } catch (error) {
      if (!this.shouldFallbackToNonStream(error)) {
        throw error;
      }

      const response = await this.chat(messages, tools);
      if (response.text) {
        onEvent({ type: "text_delta", text: response.text });
      }
      for (const toolCall of response.toolCalls) {
        onEvent({
          type: "tool_call_start",
          id: toolCall.id,
          name: toolCall.name,
        });
        if (toolCall.argumentsText) {
          onEvent({
            type: "tool_call_args_delta",
            id: toolCall.id,
            args: toolCall.argumentsText,
          });
        }
      }
      onEvent({ type: "done", response });
      return response;
    }
  }
}
