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
      name: "glob_files",
      description: "查找文件",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      async execute(input: Record<string, unknown>) {
        return `文件列表: ${input.pattern}`;
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
      name: "project_map",
      description: "项目结构地图",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      async execute(input: Record<string, unknown>) {
        return `项目地图: ${input.path || "."}`;
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
      async execute(input: Record<string, unknown>) {
        return {
          message: "已写入",
          diff: {
            path: String(input.path || "test.ts"),
            summary: "写入",
            diff: "+new content",
          },
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

import { AgentOrchestrator, mergeParallelToolResults } from "./orchestrator.js";

describe("mergeParallelToolResults", () => {
  it("聚合并行结果时保留修改状态并提升自动修复轮数", () => {
    const merged = mergeParallelToolResults(
      {
        hasModifiedFiles: false,
        hasValidated: false,
        autoFixRounds: 0,
      },
      [
        {
          status: "fulfilled",
          value: {
            message: "已写入",
            hasModifiedFiles: true,
            hasValidated: false,
            autoFixRounds: 0,
          },
        },
        {
          status: "fulfilled",
          value: {
            message: "读取完成",
            hasModifiedFiles: false,
            hasValidated: false,
            autoFixRounds: 0,
          },
        },
        {
          status: "fulfilled",
          value: {
            message: "验证失败",
            hasModifiedFiles: false,
            hasValidated: false,
            autoFixRounds: 2,
            pendingFixPrompt: "请修复",
          },
        },
      ],
    );

    expect(merged.hasModifiedFiles).toBe(true);
    expect(merged.hasValidated).toBe(false);
    expect(merged.autoFixRounds).toBe(2);
    expect(merged.pendingFixPrompt).toBe("请修复");
  });

  it("聚合纯验证型并行结果时保留已验证状态", () => {
    const merged = mergeParallelToolResults(
      {
        hasModifiedFiles: false,
        hasValidated: false,
        autoFixRounds: 0,
      },
      [
        {
          status: "fulfilled",
          value: {
            message: "验证通过",
            hasModifiedFiles: false,
            hasValidated: true,
            autoFixRounds: 0,
          },
        },
        {
          status: "fulfilled",
          value: {
            message: "读取完成",
            hasModifiedFiles: false,
            hasValidated: false,
            autoFixRounds: 0,
          },
        },
      ],
    );

    expect(merged.hasModifiedFiles).toBe(false);
    expect(merged.hasValidated).toBe(true);
    expect(merged.autoFixRounds).toBe(0);
    expect(merged.pendingFixPrompt).toBeUndefined();
  });
});

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

  it("plan 模式只提供只读工具并返回计划", async () => {
    mockChatStream.mockImplementationOnce(async (_msgs, providedTools) => {
      const toolNames = (providedTools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("glob_files");
      expect(toolNames).toContain("search_text");
      expect(toolNames).not.toContain("write_file");
      expect(toolNames).not.toContain("run_command");
      return { text: "计划：先读文件，再修改。", toolCalls: [] };
    });

    const agent = new AgentOrchestrator();
    const result = await agent.plan("修复问题");

    expect(result.finalText).toContain("计划");
    expect(result.diffs).toEqual([]);
    expect(result.steps[0]).toContain("计划模式");
  });

  it("分析项目结构任务时会注入 project_map 提示", async () => {
    mockChatStream.mockImplementationOnce(
      async (msgs: Array<{ role: string; content?: string | null }>) => {
        expect(
          msgs.some((msg) =>
            msg.content?.includes("优先考虑先调用 project_map"),
          ),
        ).toBe(true);
        return {
          text: "",
          toolCalls: [
            {
              id: "call-1",
              name: "project_map",
              argumentsText: '{"path":"src"}',
            },
          ],
        };
      },
    );
    mockChatStream.mockResolvedValueOnce({
      text: "项目结构如下。",
      toolCalls: [],
    });

    const agent = new AgentOrchestrator();
    const result = await agent.run("分析这个项目的结构和入口");
    expect(result.steps).toContain(
      "已提示模型优先使用 project_map 理解项目结构",
    );
    expect(result.steps.some((step) => step.includes("project_map"))).toBe(
      true,
    );
    expect(result.finalText).toContain("项目结构如下");
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
                name: "glob_files",
                argumentsText: '{"pattern":"**/*.ts"}',
              },
            ],
          };
        }
        return { text: "两个文件都读完了。", toolCalls: [] };
      },
    );

    const agent = new AgentOrchestrator();
    const result = await agent.run("读取 a.ts 并查找 TS 文件");
    expect(result.finalText).toContain("读完了");
    expect(result.steps.some((s) => s.includes("read_file"))).toBe(true);
    expect(result.steps.some((s) => s.includes("glob_files"))).toBe(true);
  });

  it("并行工具调用后不会丢失文件已修改状态", async () => {
    let callCount = 0;
    mockChatStream.mockImplementation(async () => {
      callCount += 1;
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
      if (callCount === 2) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-3",
              name: "write_file",
              argumentsText: '{"path":"src/foo.ts","content":"updated"}',
            },
            {
              id: "call-4",
              name: "read_file",
              argumentsText: '{"path":"src/foo.ts"}',
            },
          ],
        };
      }
      if (callCount === 3) {
        return { text: "", toolCalls: [] };
      }
      return { text: "修改后已完成验证。", toolCalls: [] };
    });

    const runAutoValidationSpy = vi
      .spyOn(validationModule, "getValidationPlan")
      .mockResolvedValue({
        commands: ["npm run build"],
        reason: "检测到源码变更，执行 build 验证",
        steps: [
          {
            kind: "build",
            command: "npm run build",
            targeted: false,
          },
        ],
      });

    const agent = new AgentOrchestrator({
      onConfirmCommand: vi.fn().mockResolvedValue(true),
    });
    const result = await agent.run("先读文件，再并行修改并验证");

    expect(runAutoValidationSpy).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain("修改后已完成验证");
  });

  it("支持连续撤销多轮修改", async () => {
    let callCount = 0;
    mockChatStream.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1 || callCount === 4) {
        return {
          text: "",
          toolCalls: [
            {
              id: `call-${callCount}`,
              name: "write_file",
              argumentsText: `{"path":"src/file${callCount}.ts","content":"updated"}`,
            },
          ],
        };
      }
      return { text: "完成。", toolCalls: [] };
    });

    vi.spyOn(validationModule, "getValidationPlan").mockResolvedValue({
      commands: ["npm run build"],
      reason: "测试中验证",
      steps: [
        {
          kind: "build",
          command: "npm run build",
          targeted: false,
        },
      ],
    });

    const agent = new AgentOrchestrator();
    await agent.run("第一次修改");
    await agent.run("第二次修改");

    expect(agent.undoStackDepth).toBe(2);
    expect(agent.canUndoLastRun).toBe(true);

    const firstUndo = await agent.undoLastRun();
    expect(firstUndo.finalText).toContain("src/file4.ts");
    expect(agent.undoStackDepth).toBe(1);

    const secondUndo = await agent.undoLastRun();
    expect(secondUndo.finalText).toContain("src/file1.ts");
    expect(agent.undoStackDepth).toBe(0);
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

  it("定向测试参数不受支持时会回退到完整测试", async () => {
    vi.spyOn(validationModule, "getValidationPlan").mockResolvedValue({
      commands: ["npm run test -- src/foo.test.ts"],
      reason:
        "仅检测到测试相关变更，执行 lint/test 验证；检测到测试文件改动，优先运行受影响测试文件",
      steps: [
        {
          kind: "test",
          command: "npm run test -- src/foo.test.ts",
          fallbackCommand: "npm run test",
          targeted: true,
        },
      ],
    });

    let callCount = 0;
    mockChatStream.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-1",
              name: "write_file",
              argumentsText: '{"path":"src/foo.test.ts","content":"updated"}',
            },
          ],
        };
      }
      if (callCount === 2) {
        return { text: "", toolCalls: [] };
      }
      return { text: "完成。", toolCalls: [] };
    });

    const runCommandTool = fakeTools.find(
      (tool) => tool.name === "run_command",
    );
    if (!runCommandTool) {
      throw new Error("run_command tool not found");
    }
    const runCommandSpy = vi
      .spyOn(runCommandTool, "execute")
      .mockResolvedValueOnce(
        JSON.stringify({
          command: "npm run test -- src/foo.test.ts",
          exitCode: 1,
          stdout: "",
          stderr: "Unknown option '--runTestsByPath'",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          command: "npm run test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
      );

    const agent = new AgentOrchestrator({
      onConfirmCommand: vi.fn().mockResolvedValue(true),
    });
    const result = await agent.run("修复测试后自动验证");

    expect(runCommandSpy).toHaveBeenNthCalledWith(1, {
      command: "npm run test -- src/foo.test.ts",
      confirmed: true,
    });
    expect(runCommandSpy).toHaveBeenNthCalledWith(2, {
      command: "npm run test",
      confirmed: true,
    });
    expect(result.steps.some((step) => step.includes("回退到完整测试"))).toBe(
      true,
    );
    expect(result.finalText).toContain("完成");
  });

  it("失败测试时会根据输出重放受影响测试", async () => {
    vi.spyOn(validationModule, "getValidationPlan").mockResolvedValue({
      commands: ["npm run test"],
      reason: "仅检测到测试相关变更，执行 lint/test 验证",
      steps: [
        {
          kind: "test",
          command: "npm run test",
          targeted: false,
          testRunner: "vitest",
        },
      ],
    });

    let callCount = 0;
    mockChatStream.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-1",
              name: "write_file",
              argumentsText: '{"path":"src/foo.ts","content":"updated"}',
            },
          ],
        };
      }
      if (callCount === 2) {
        return { text: "", toolCalls: [] };
      }
      return { text: "完成。", toolCalls: [] };
    });

    const runCommandTool = fakeTools.find(
      (tool) => tool.name === "run_command",
    );
    if (!runCommandTool) {
      throw new Error("run_command tool not found");
    }
    const runCommandSpy = vi
      .spyOn(runCommandTool, "execute")
      .mockResolvedValueOnce(
        JSON.stringify({
          command: "npm run test",
          exitCode: 1,
          stdout: " FAIL  src/utils/token.test.ts",
          stderr: "AssertionError",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          command: "npm run test -- src/utils/token.test.ts",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
      );

    const agent = new AgentOrchestrator({
      onConfirmCommand: vi.fn().mockResolvedValue(true),
    });
    const result = await agent.run("修复测试后自动验证");

    expect(runCommandSpy).toHaveBeenNthCalledWith(1, {
      command: "npm run test",
      confirmed: true,
    });
    expect(runCommandSpy).toHaveBeenNthCalledWith(2, {
      command: "npm run test -- src/utils/token.test.ts",
      confirmed: true,
    });
    expect(
      result.steps.some((step) => step.includes("根据失败输出重放受影响测试")),
    ).toBe(true);
    expect(result.finalText).toContain("完成");
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
