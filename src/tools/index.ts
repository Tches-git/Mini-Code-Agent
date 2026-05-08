import type { ToolDefinition } from "../types/agent.js";
import { commandTools } from "./command.js";
import { diagnosticsTools } from "./diagnostics.js";
import { fileTools } from "./filesystem.js";
import { gitTools } from "./git.js";
import { loadMcpTools } from "./mcp.js";
import { memoryTools } from "./memory.js";
import { loadPluginTools } from "./plugins.js";
import { searchTools } from "./search.js";
import { subtaskTools } from "./subtask.js";
import { taskGraphTools } from "./task-graph.js";

export const builtinTools: ToolDefinition[] = [
  ...fileTools,
  ...searchTools,
  ...commandTools,
  ...gitTools,
  ...diagnosticsTools,
  ...memoryTools,
  ...subtaskTools,
  ...taskGraphTools,
];

export const tools: ToolDefinition[] = [...builtinTools];

function mergeTools(
  baseTools: ToolDefinition[],
  pluginTools: ToolDefinition[],
): ToolDefinition[] {
  const builtinNames = new Set(baseTools.map((tool) => tool.name));
  for (const tool of pluginTools) {
    if (builtinNames.has(tool.name)) {
      throw new Error(`插件工具不能覆盖内置工具: ${tool.name}`);
    }
  }
  return [...baseTools, ...pluginTools];
}

export function getToolMap(extraTools: ToolDefinition[] = []) {
  return new Map(
    mergeTools(tools, extraTools).map((tool) => [tool.name, tool]),
  );
}

export async function loadTools(): Promise<ToolDefinition[]> {
  return mergeTools(builtinTools, [
    ...(await loadPluginTools()),
    ...(await loadMcpTools()),
  ]);
}

export function getToolCapabilitySets(activeTools: ToolDefinition[]) {
  return {
    readOnly: new Set(
      activeTools
        .filter((tool) => tool.readOnly === true)
        .map((tool) => tool.name),
    ),
    modifying: new Set(
      activeTools
        .filter((tool) => tool.modifiesFiles === true)
        .map((tool) => tool.name),
    ),
    parallelizable: new Set(
      activeTools
        .filter((tool) => tool.parallelizable === true)
        .map((tool) => tool.name),
    ),
  };
}
