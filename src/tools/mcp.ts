import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/agent.js";
import { isPathInsideWorkspace } from "../utils/path.js";
import { getWorkspaceRoot } from "../utils/runtime.js";
import { createTool } from "./create-tool.js";

const MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,40}$/i;
const MCP_SERVER_TIMEOUT_MS = 30_000;

type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McpConfig = {
  servers?: Record<string, McpServerConfig>;
};

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

function getMcpConfigPath(): string {
  return path.join(getWorkspaceRoot(), ".local-code-agent", "mcp.json");
}

function getLegacyMcpConfigPath(): string {
  return path.join(getWorkspaceRoot(), ".mini-claude-code", "mcp.json");
}

function sanitizeToolName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized)
    ? normalized.slice(0, 48)
    : `mcp_${normalized}`;
}

function validateServerName(name: string) {
  if (!MCP_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`MCP server name invalid: ${name}`);
  }
}

async function readMcpConfig(): Promise<McpConfig> {
  let configPath = getMcpConfigPath();
  if (!existsSync(configPath)) {
    configPath = getLegacyMcpConfigPath();
  }
  if (!existsSync(configPath)) return {};
  if (!isPathInsideWorkspace(configPath)) {
    throw new Error("MCP config must be inside workspace");
  }
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as McpConfig;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function encodeMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function extractMessages(buffer: Buffer): {
  messages: unknown[];
  rest: Buffer;
} {
  const messages: unknown[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) break;
    const length = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    messages.push(
      JSON.parse(remaining.subarray(bodyStart, bodyEnd).toString("utf8")),
    );
    remaining = remaining.subarray(bodyEnd);
  }
  return { messages, rest: remaining };
}

class McpStdioClient {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private pending = new Map<number, (response: JsonRpcResponse) => void>();
  private stderr = "";

  constructor(config: McpServerConfig) {
    this.process = spawn(config.command, config.args || [], {
      cwd: getWorkspaceRoot(),
      env: { ...process.env, ...(config.env || {}) },
      stdio: "pipe",
    });
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const extracted = extractMessages(this.buffer);
      this.buffer = extracted.rest;
      for (const message of extracted.messages) {
        const response = message as JsonRpcResponse;
        if (typeof response.id === "number") {
          this.pending.get(response.id)?.(response);
          this.pending.delete(response.id);
        }
      }
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, MCP_SERVER_TIMEOUT_MS);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.process.stdin.write(
        encodeMessage({ jsonrpc: "2.0", id, method, params }),
      );
    });
    if (response.error) {
      throw new Error(
        response.error.message ||
          `MCP error ${response.error.code ?? "unknown"}`,
      );
    }
    return response.result;
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.process.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "local-code-agent", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
  }

  async close() {
    if (!this.process.killed) this.process.kill();
    if (
      this.stderr.length > 0 &&
      this.process.exitCode &&
      this.process.exitCode !== 0
    ) {
      throw new Error(this.stderr.slice(0, 500));
    }
  }
}

async function withMcpClient<T>(
  config: McpServerConfig,
  callback: (client: McpStdioClient) => Promise<T>,
): Promise<T> {
  const client = new McpStdioClient(config);
  try {
    await client.initialize();
    return await callback(client);
  } finally {
    await client.close();
  }
}

async function listServerTools(config: McpServerConfig): Promise<McpTool[]> {
  return withMcpClient(config, async (client) => {
    const result = (await client.request("tools/list")) as {
      tools?: McpTool[];
    };
    return Array.isArray(result.tools) ? result.tools : [];
  });
}

function stringifyMcpContent(result: unknown): string | ToolResult {
  const payload = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map((item) =>
        item.type === "text" ? item.text || "" : JSON.stringify(item),
      )
      .filter(Boolean)
      .join("\n");
    return payload.isError ? `MCP tool returned error:\n${text}` : text;
  }
  return JSON.stringify(result, null, 2);
}

function createMcpTool(
  serverName: string,
  serverConfig: McpServerConfig,
  tool: McpTool,
): ToolDefinition {
  const exposedName = sanitizeToolName(`mcp_${serverName}_${tool.name}`);
  const readOnly =
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.destructiveHint !== true;
  const definition = createTool({
    name: exposedName,
    description: `[mcp:${serverName}] ${tool.description || tool.name}`,
    schema: z.record(z.unknown()),
    inputSchema: tool.inputSchema || {
      type: "object",
      additionalProperties: true,
    },
    async execute(input) {
      return withMcpClient(serverConfig, async (client) => {
        const result = await client.request("tools/call", {
          name: tool.name,
          arguments: input,
        });
        return stringifyMcpContent(result);
      });
    },
  });
  definition.readOnly = readOnly;
  definition.parallelizable = readOnly;
  definition.modifiesFiles = tool.annotations?.destructiveHint === true;
  return definition;
}

export async function loadMcpTools(): Promise<ToolDefinition[]> {
  const config = await readMcpConfig();
  const servers = config.servers || {};
  const tools: ToolDefinition[] = [];
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    validateServerName(serverName);
    if (!serverConfig.command?.trim()) continue;
    const serverTools = await listServerTools(serverConfig);
    for (const tool of serverTools) {
      tools.push(createMcpTool(serverName, serverConfig, tool));
    }
  }
  return tools;
}
