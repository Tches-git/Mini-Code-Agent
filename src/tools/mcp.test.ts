import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getToolCapabilitySets, loadTools } from "./index.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-tools-test-"));
  process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT = workspace;
});

afterEach(async () => {
  delete process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("MCP tools", () => {
  it("loads stdio MCP server tools and calls them", async () => {
    const serverPath = path.join(workspace, "mcp-server.mjs");
    await writeFile(
      serverPath,
      `let buffer = Buffer.alloc(0);
function send(message) { const body = JSON.stringify(message); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body); }
function extract() { const messages = []; while (true) { const idx = buffer.indexOf('\\r\\n\\r\\n'); if (idx < 0) break; const header = buffer.subarray(0, idx).toString(); const match = /content-length:\\s*(\\d+)/i.exec(header); if (!match) break; const len = Number(match[1]); const start = idx + 4; const end = start + len; if (buffer.length < end) break; messages.push(JSON.parse(buffer.subarray(start, end).toString())); buffer = buffer.subarray(end); } return messages; }
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); for (const msg of extract()) { if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }); if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } }); if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + msg.params.arguments.text }] } }); } });`,
      "utf8",
    );
    const configDir = path.join(workspace, ".mini-claude-code");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "mcp.json"),
      JSON.stringify({
        servers: { local: { command: process.execPath, args: [serverPath] } },
      }),
      "utf8",
    );

    const tools = await loadTools();
    const tool = tools.find((item) => item.name === "mcp_local_echo");

    expect(tool?.description).toContain("[mcp:local]");
    expect(await tool?.execute({ text: "hello" })).toBe("echo:hello");
    const capabilities = getToolCapabilitySets(tools);
    expect(capabilities.readOnly.has("mcp_local_echo")).toBe(true);
    expect(capabilities.parallelizable.has("mcp_local_echo")).toBe(true);
  });
});
