import type { ToolCall } from "../types/llm.js";

export type ExecutionState = {
  hasModifiedFiles: boolean;
  hasValidated: boolean;
  autoFixRounds: number;
};

export type ToolExecutionResult = ExecutionState & {
  message: string;
  pendingFixPrompt?: string;
};

export type AutoValidationResult = {
  failedPrompt?: string;
  skipped?: boolean;
  validated?: boolean;
};

export type AssistantToolCall = ToolCall;
