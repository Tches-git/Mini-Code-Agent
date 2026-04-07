import type { ToolDefinition } from "../types/agent.js";
import { fileTools } from "./filesystem.js";
import { searchTools } from "./search.js";
import { commandTools } from "./command.js";

export const tools: ToolDefinition[] = [
  ...fileTools,
  ...searchTools,
  ...commandTools
];

export function getToolMap() {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

