#!/usr/bin/env node
import { runPluginTool } from "./plugins.js";

const [, , toolName, inputJson = "{}"] = process.argv;

try {
  if (!toolName) {
    throw new Error("缺少插件工具名");
  }
  const input = JSON.parse(inputJson) as Record<string, unknown>;
  const result = await runPluginTool(toolName, input);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
