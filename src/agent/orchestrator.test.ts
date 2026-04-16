import { beforeEach, describe, expect, it, vi } from "vitest";
import * as validationModule from "./validation.js";

const mockChatStream = vi.hoisted(() => vi.fn());
const mockSaveSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const fakeTools = vi.hoisted(() => {
  const tools = [
    {
      name: "read_file",
      description: "读取文件",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      async execute(input: Record<string, unknown>) {
        return `内容: ${input.path}`;
      },
    },
    {
      name: "search_text",
      description: "搜索文本",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      async execute(input: Record<string, unknown>) {
        return `搜索结果: ${input.query}`;
      },
    },
    {
      name: "write_file",
      description: "写入文件",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      async execute() {
        return {
          message: "已写入",
          diff: { path: "test.ts", summary: "写入", diff: "+new content" },
        };
      },
    },
    {
      name: "run_command",
      description: "运行命令",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      async execute(input: Record<string, unknown>) {
        return JSON.stringify({
          command: input.command,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        });
      },
    },
    {
      name: "failing_tool",
      description: "总是失败的工具",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        throw new Error("模拟工具执行错误");
      },
    },
  ];
  return tools;
});

vi.mock("../llm/client.js", () => ({
  LlmClient: class {
    chatStream = mockChatStream;
  },
}));

vi.mock("./session.js", () => ({
  saveSession: mockSaveSession,
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tools/index.js", () => ({
  tools: fakeTools,
  getToolMap: () =>
    new Map(fakeTools.map((t: { name: string }) => [t.name, t])),
}));

import { AgentOrchestrator } from "./orchestrator.js";

describe("AgentOrchestrator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockChatStream.mockReset();
    mockSaveSession.mockReset().mockResolvedValue(undefined);
  });

  it("无 tool_calls 时直接返回文本", async () => {
    mockChatStream.mockImplementationOnce(
      async (
        _msgs: unknown,
        _tools: unknown,
        onEvent: (e: { type: string; text: string }) => void,
      ) => {
        onEvent({ type: "text_delta", text: "你好" });
        return { text: "你好，有什么可以帮忙的？", toolCalls: [] };
      },
    );

    const agent = new AgentOrchestrator();
    const result = await agent.run("打个招呼");
    expect(result.finalText).toContain("你好");
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("工具调用闭环：LLM 调用工具后返回最终文本", async () => {
    let callCount = 0;
    mockChatStream.mockImplementation(
      async (
        _msgs: unknown,
        _tools: unknown,
        onEvent: (e: { type: string; text?: string }) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          onEvent({ type: "text_delta" });
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "read_file",
                argumentsText: '{"path":"src/index.ts"}',
              },
            ],
          };
        }
        return { text: "文件内容如下...", toolCalls: [] };
      },
    );

    const agent = new AgentOrchestrator();
    const result = await agent.run("读取 src/index.ts");
    expect(result.finalText).toContain("文件内容");
    expect(result.steps.some((s) => s.includes("read_file"))).toBe(true);
  });

  it("工具执行失败后错误回传到消息中", async () => {
    let callCount = 0;
    mockChatStream.mockImplementation(
      async (
        _msgs: unknown,
        _tools: unknown,
        _onEvent: (e: { type: string }) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [
              { id: "call-1", name: "failing_tool", argumentsText: "{}" },
            ],
          };
        }
        return { text: "工具失败了，我换个方法。", toolCalls: [] };
      },
    );

    const events: string[] = [];
    const agent = new AgentOrchestrator({
      onEvent: (event) => {
        if (event.type === "tool_error") events.push(event.type);
      },
    });
    const result = await agent.run("测试失败工具");
    expect(events).toContain("tool_error");
    expect(result.steps.some((s) => s.includes("执行失败"))).toBe(true);
  });

  it("多个只读工具并行执行", async () => {
    let callCount = 0;
    mockChatStream.mockImplementation(
      async (
        _msgs: unknown,
        _tools: unknown,
        _onEvent: (e: { type: string }) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "read_file",
                argumentsText: '{"path":"a.ts"}',
              },
              {
                id: "call-2",
                name: "read_file",
                argumentsText: '{"path":"b.ts"}',
              },
            ],
          };
        }
        return { text: "两个文件都读完了。", toolCalls: [] };
      },
    );

    const agent = new AgentOrchestrator();
    const result = await agent.run("读取 a.ts 和 b.ts");
    expect(result.finalText).toContain("读完了");
    expect(result.steps.filter((s) => s.includes("read_file")).length).toBe(2);
  });

  it("达到最大执行轮数时返回预算提示", async () => {
    mockChatStream.mockImplementation(
      async (
        _msgs: unknown,
        _tools: unknown,
        _onEvent: (e: { type: string }) => void,
      ) => {
        return {
          text: "",
          toolCalls: [
            {
              id: `call-${Math.random()}`,
              name: "read_file",
              argumentsText: '{"path":"x.ts"}',
            },
          ],
        };
      },
    );

    process.env.MAX_EXECUTION_ROUNDS = "3";
    const agent = new AgentOrchestrator();
    const result = await agent.run("修改代码");
    delete process.env.MAX_EXECUTION_ROUNDS;

    expect(result.finalText).toContain("最大执行轮数");
  });

  it("每次 run 结束后保存会话", async () => {
    mockChatStream.mockImplementationOnce(
      async (
        _msgs: unknown,
        _tools: unknown,
        _onEvent: (e: { type: string }) => void,
      ) => {
        return { text: "完成。", toolCalls: [] };
      },
    );

    const agent = new AgentOrchestrator();
    await agent.run("测试保存");
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    const savedData = mockSaveSession.mock.calls[0][0];
    expect(savedData.messages.length).toBeGreaterThan(1);
    expect(savedData.summaryLines).toBeDefined();
    expect(savedData.summaryFocus).toBeDefined();
  });

  it("验证命令失败时会读取 diagnostics 并回灌修复", async () => {
    const diagnosticsSpy = vi
      .spyOn(validationModule, "getDiagnosticsForValidationCommand")
      .mockResolvedValue({
        command: "tsc -p tsconfig.json --pretty false --noEmit",
        truncated: false,
        diagnostics: [
          {
            file: "src/broken.ts",
            line: 1,
            column: 2,
            severity: "error",
            source: "tsc",
            code: "TS2322",
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ],
      });

    let callCount = 0;
    mockChatStream.mockImplementation(
      async (
        msgs: Array<{ role: string; content?: string }>,
        _tools: unknown,
        _onEvent: (e: { type: string }) => void,
      ) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "run_command",
                argumentsText: '{"command":"npm run build"}',
              },
            ],
          };
        }

        expect(msgs.at(-1)?.role).toBe("user");
        expect(msgs.at(-1)?.content).toContain("TS2322");
        return { text: "已根据 diagnostics 修复完成。", toolCalls: [] };
      },
    );

    const runCommandTool = fakeTools.find(
      (tool) => tool.name === "run_command",
    );
    if (!runCommandTool) {
      throw new Error("run_command tool not found");
    }
    vi.spyOn(runCommandTool, "execute").mockResolvedValueOnce(
      JSON.stringify({
        command: "npm run build",
        exitCode: 1,
        stdout: "",
        stderr: "build failed",
      }),
    );

    const agent = new AgentOrchestrator({
      onConfirmCommand: vi.fn().mockResolvedValue(true),
    });
    const result = await agent.run("先构建再修复错误");

    expect(diagnosticsSpy).toHaveBeenCalledWith("npm run build");
    expect(result.finalText).toContain("diagnostics 修复完成");
  });
});
