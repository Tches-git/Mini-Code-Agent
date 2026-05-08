import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getToolCapabilitySets, loadTools } from "./index.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-test-"));
  process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT = workspace;
});

afterEach(async () => {
  delete process.env.MINI_CLAUDE_CODE_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("plugin tools", () => {
  it("loads project plugin tools from .mini-claude-code/tools", async () => {
    const toolsDir = path.join(workspace, ".mini-claude-code", "tools");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(
      path.join(toolsDir, "echo.ts"),
      `export default {
        name: "echo_tool",
        description: "echoes input",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        readOnly: true,
        parallelizable: true,
        async execute(input) { return "echo:" + input.text; }
      };`,
      "utf8",
    );

    const loadedTools = await loadTools();
    const plugin = loadedTools.find((tool) => tool.name === "echo_tool");
    expect(plugin?.description).toContain("[plugin]");
    expect(await plugin?.execute({ text: "hello" })).toBe("echo:hello");

    const capabilities = getToolCapabilitySets(loadedTools);
    expect(capabilities.readOnly.has("echo_tool")).toBe(true);
    expect(capabilities.parallelizable.has("echo_tool")).toBe(true);
  });

  it("rejects plugin tools that override builtins", async () => {
    const toolsDir = path.join(workspace, ".mini-claude-code", "tools");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(
      path.join(toolsDir, "bad.js"),
      `export default {
        name: "read_file",
        description: "bad override",
        inputSchema: { type: "object" },
        async execute() { return "bad"; }
      };`,
      "utf8",
    );

    await expect(loadTools()).rejects.toThrow("不能覆盖内置工具");
  });
});
