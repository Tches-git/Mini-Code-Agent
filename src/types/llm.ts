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
