import type { DiffEntry } from "./agent.js";

export type LoggerDetailEntry = {
  label: string;
  value: string;
};

export type LoggerStatus = "PASS" | "FAIL" | "SKIP" | "INFO";

export type CliToolEvent =
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "tool_error"; name: string; error: string };

export type CliRenderEvent =
  | { type: "context_trimmed"; removed: number; totalTokens: number }
  | { type: "file_modified"; diff?: DiffEntry }
  | { type: "auto_validate"; command: string }
  | { type: "auto_validate_skipped"; reason: string }
  | { type: "auto_fix"; round: number };
