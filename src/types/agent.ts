export type Role = "system" | "user" | "assistant" | "tool";

export type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: Role;
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
};

export type CommandConfirmationRequest = {
  kind: "command";
  command: string;
  reason: string;
  policy: "guarded";
  source: "tool" | "auto_validate";
};

export type FileImportConfirmationRequest = {
  kind: "external_file";
  path: string;
  destinationPath: string;
  mode: "copy" | "extract_text";
  reason: string;
};

export type ExternalPathConfirmationRequest = {
  kind: "external_path";
  path: string;
  action: "list" | "read" | "search" | "write";
  reason: string;
};

export type ApprovalRequest =
  | CommandConfirmationRequest
  | FileImportConfirmationRequest
  | ExternalPathConfirmationRequest;

export type DiffEntry = {
  path: string;
  summary: string;
  diff: string;
};

export type AgentTaskStatus = "todo" | "doing" | "done" | "blocked";

export type AgentTaskItem = {
  id: number;
  title: string;
  status: AgentTaskStatus;
  note?: string;
};

export type AgentRunResult = {
  finalText: string;
  steps: string[];
  diffs: DiffEntry[];
  tasks?: AgentTaskItem[];
};

export type ToolResult = {
  message: string;
  diff?: DiffEntry;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string | ToolResult>;
};

export type AgentEvent =
  | { type: "thinking" }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "tool_error"; name: string; error: string }
  | { type: "file_modified"; diff?: DiffEntry }
  | { type: "auto_validate"; command: string }
  | { type: "auto_validate_skipped"; reason: string }
  | { type: "auto_fix"; round: number }
  | { type: "context_trimmed"; removed: number; totalTokens: number };
