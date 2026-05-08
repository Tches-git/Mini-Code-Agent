import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/agent.js";
import { isPathInsideWorkspace } from "../utils/path.js";
import { getWorkspaceRoot } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

const PLUGIN_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,48}$/;
const PLUGIN_TOOL_TIMEOUT_MS = 30_000;
const PLUGIN_BUILD_DIR = ".mini-claude-code/.tools-build";

type PluginToolDefinition = ToolDefinition & {
  readOnly?: boolean;
  modifiesFiles?: boolean;
  parallelizable?: boolean;
};

type PluginToolModule = {
  tools?: PluginToolDefinition[];
  default?: PluginToolDefinition | PluginToolDefinition[];
};

function getPluginToolsDir(): string {
  return path.join(getWorkspaceRoot(), ".mini-claude-code", "tools");
}

function getPluginToolRunnerPath(): string {
  return path.join(getWorkspaceRoot(), "dist", "tools", "plugin-runner.js");
}

function assertPluginToolName(name: string) {
  if (!PLUGIN_TOOL_NAME_PATTERN.test(name) || name.startsWith("plugin_")) {
    throw new Error(
      `插件工具名无效: ${name}。请使用 3-49 位小写字母、数字或下划线，且不要以 plugin_ 开头。`,
    );
  }
}

function normalizePluginTool(tool: PluginToolDefinition): ToolDefinition {
  assertPluginToolName(tool.name);
  if (!tool.description?.trim()) {
    throw new Error(`插件工具 ${tool.name} 缺少 description`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
    throw new Error(`插件工具 ${tool.name} 缺少 inputSchema`);
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`插件工具 ${tool.name} 缺少 execute 函数`);
  }
  return {
    name: tool.name,
    description: `[plugin] ${tool.description}`,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly !== false && !tool.modifiesFiles,
    modifiesFiles: tool.modifiesFiles === true,
    parallelizable:
      tool.parallelizable !== false && tool.modifiesFiles !== true,
    execute: tool.execute,
  };
}

async function getCompiledPluginPath(filePath: string): Promise<string> {
  if (filePath.endsWith(".js")) return filePath;
  const source = await fs.readFile(filePath, "utf8");
  const hash = createHash("sha1").update(filePath).update(source).digest("hex");
  const outputDir = path.join(getWorkspaceRoot(), PLUGIN_BUILD_DIR);
  const outputPath = path.join(
    outputDir,
    `${path.basename(filePath, ".ts")}-${hash}.mjs`,
  );
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    outputPath,
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
      },
      fileName: filePath,
    }).outputText,
    "utf8",
  );
  return outputPath;
}

async function loadPluginModule(filePath: string): Promise<PluginToolModule> {
  const runnablePath = await getCompiledPluginPath(filePath);
  const url = pathToFileURL(runnablePath);
  url.searchParams.set("mtime", String((await fs.stat(runnablePath)).mtimeMs));
  return import(url.href) as Promise<PluginToolModule>;
}

async function discoverPluginTools(): Promise<ToolDefinition[]> {
  const dir = getPluginToolsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const pluginTools: ToolDefinition[] = [];
  const seenNames = new Set<string>();
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".js") && !entry.endsWith(".ts")) continue;
    const filePath = path.join(dir, entry);
    if (!isPathInsideWorkspace(filePath)) continue;
    const module = await loadPluginModule(filePath);
    const exportedTools = [
      ...(Array.isArray(module.default)
        ? module.default
        : module.default
          ? [module.default]
          : []),
      ...(module.tools || []),
    ];
    for (const tool of exportedTools) {
      const normalized = normalizePluginTool(tool);
      if (seenNames.has(normalized.name)) {
        throw new Error(`插件工具名重复: ${normalized.name}`);
      }
      seenNames.add(normalized.name);
      pluginTools.push(normalized);
    }
  }
  return pluginTools;
}

function createPluginToolProxy(
  toolName: string,
  directTool?: ToolDefinition,
): ToolDefinition {
  return createTool({
    name: toolName,
    description: `调用项目插件工具 ${toolName}。插件位于 .mini-claude-code/tools/*.js，并在独立 Node 进程中执行。`,
    schema: z.record(z.unknown()),
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "object",
          description: "传给插件工具的 JSON 参数。",
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const runnerPath = getPluginToolRunnerPath();
      if (!existsSync(runnerPath)) {
        if (directTool) {
          return directTool.execute(input);
        }
        throw new Error("插件运行器未构建，请先运行 npm run build");
      }
      const { execa } = await import("execa");
      const result = await execa(
        process.execPath,
        [runnerPath, toolName, JSON.stringify(input)],
        {
          cwd: getWorkspaceRoot(),
          timeout: PLUGIN_TOOL_TIMEOUT_MS,
          reject: false,
          env: { ...process.env, MINI_CLAUDE_CODE_PLUGIN_RUNNER: "1" },
        },
      );
      if ((result.exitCode ?? 1) !== 0) {
        throw new Error(
          result.stderr || result.stdout || `插件 ${toolName} 执行失败`,
        );
      }
      const parsed = JSON.parse(result.stdout || "null") as string | ToolResult;
      return parsed;
    },
  });
}

export async function loadPluginTools(): Promise<ToolDefinition[]> {
  const pluginTools = await discoverPluginTools();
  return pluginTools.map((tool) => ({
    ...createPluginToolProxy(tool.name, tool),
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly,
    modifiesFiles: tool.modifiesFiles,
    parallelizable: tool.parallelizable,
  }));
}

export async function runPluginTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | ToolResult> {
  const tool = (await discoverPluginTools()).find(
    (item) => item.name === toolName,
  );
  if (!tool) {
    throw new Error(`未找到插件工具: ${toolName}`);
  }
  return tool.execute(input);
}
