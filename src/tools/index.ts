import type { ToolDefinition } from "../types/agent.js";
import { commandTools } from "./command.js";
import { diagnosticsTools } from "./diagnostics.js";
import { fileTools } from "./filesystem.js";
import { gitTools } from "./git.js";
import { memoryTools } from "./memory.js";
import { searchTools } from "./search.js";
import { subtaskTools } from "./subtask.js";
import { taskGraphTools } from "./task-graph.js";

export const tools: ToolDefinition[] = [
  ...fileTools,
  ...searchTools,
  ...commandTools,
  ...gitTools,
  ...diagnosticsTools,
  ...memoryTools,
  ...subtaskTools,
  ...taskGraphTools,
];

export function getToolMap() {
  return new Map(tools.map((tool) => [tool.name, tool]));
}
