import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExeca = vi.hoisted(() => vi.fn());
const mockLoadWorkspaceEnv = vi.hoisted(() => vi.fn());
const mockGetRuntimeEnvInfo = vi.hoisted(() => vi.fn());
const mockQuestion = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockListSessions = vi.hoisted(() => vi.fn());
const mockRestoreSession = vi.hoisted(() => vi.fn());
const mockRun = vi.hoisted(() => vi.fn());
const mockPlan = vi.hoisted(() => vi.fn());
const mockUndoLastRun = vi.hoisted(() => vi.fn());
const mockExecuteTask = vi.hoisted(() => vi.fn());
const mockRetryNextBlockedTask = vi.hoisted(() => vi.fn());
const mockClearHistory = vi.hoisted(() => vi.fn());
const mockReadProjectMemory = vi.hoisted(() => vi.fn());
const mockEditProjectMemory = vi.hoisted(() => vi.fn());
const mockLogAssistant = vi.hoisted(() => vi.fn());
const mockLogBanner = vi.hoisted(() => vi.fn());
const mockLogCard = vi.hoisted(() => vi.fn());
const mockLogCardList = vi.hoisted(() => vi.fn());
const mockLogDetailEntries = vi.hoisted(() => vi.fn());
const mockLogEmptyState = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());
const mockLogHint = vi.hoisted(() => vi.fn());
const mockLogLine = vi.hoisted(() => vi.fn());
const mockLogSection = vi.hoisted(() => vi.fn());
const mockLogSuccess = vi.hoisted(() => vi.fn());
const mockSpinnerStart = vi.hoisted(() => vi.fn());
const mockSpinnerStop = vi.hoisted(() => vi.fn());
const mockSetWorkspaceRoot = vi.hoisted(() => vi.fn());
const mockGetWorkspaceRoot = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const mockGetAppDataDir = vi.hoisted(() =>
  vi.fn(() => "/tmp/home/.mini-claude-code"),
);
const mockReadWorkspacePackageJson = vi.hoisted(() => vi.fn());
const mockDetectPackageManager = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: mockExeca,
}));

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
  default: {
    createInterface: vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })),
  },
}));

vi.mock("../agent/session.js", () => ({
  listSessions: mockListSessions,
}));

vi.mock("../llm/env.js", () => ({
  loadWorkspaceEnv: mockLoadWorkspaceEnv,
  getRuntimeEnvInfo: mockGetRuntimeEnvInfo,
}));

let capturedConfirmCommand:
  | ((request: import("../types/agent.js").ApprovalRequest) => Promise<unknown>)
  | null = null;
let capturedReviewMemory:
  | ((review: { diff: string }) => Promise<unknown>)
  | null = null;
const mockReviewProjectMemoryEdit = vi.hoisted(() => vi.fn());

vi.mock("../tools/memory.js", async () => {
  const actual =
    await vi.importActual<typeof import("../tools/memory.js")>(
      "../tools/memory.js",
    );
  return {
    ...actual,
    readProjectMemory: mockReadProjectMemory,
    editProjectMemory: mockEditProjectMemory,
    reviewProjectMemoryEdit: mockReviewProjectMemoryEdit,
  };
});

vi.mock("../utils/project-tooling.js", async () => {
  const actual = await vi.importActual<
    typeof import("../utils/project-tooling.js")
  >("../utils/project-tooling.js");
  return {
    ...actual,
    readWorkspacePackageJson: mockReadWorkspacePackageJson,
    detectPackageManager: mockDetectPackageManager,
  };
});

vi.mock("../agent/orchestrator.js", () => ({
  AgentOrchestrator: class {
    turnCount = 3;
    canUndoLastRun = false;
    undoStackDepth = 0;
    constructor(options?: {
      onConfirmCommand?: typeof capturedConfirmCommand;
      onReviewMemory?: typeof capturedReviewMemory;
    }) {
      capturedConfirmCommand = options?.onConfirmCommand || null;
      capturedReviewMemory = options?.onReviewMemory || null;
    }
    restoreSession = mockRestoreSession;
    run = mockRun;
    plan = mockPlan;
    undoLastRun = mockUndoLastRun;
    executeTask = mockExecuteTask;
    retryNextBlockedTask = mockRetryNextBlockedTask;
    clearHistory = mockClearHistory;
  },
}));

vi.mock("../utils/runtime.js", () => ({
  setWorkspaceRoot: mockSetWorkspaceRoot,
  getWorkspaceRoot: mockGetWorkspaceRoot,
  getAppDataDir: mockGetAppDataDir,
  getWorkspaceStateDir: () => "/tmp/home/.mini-claude-code/workspaces/demo",
}));

vi.mock("../utils/logger.js", () => ({
  logAssistant: mockLogAssistant,
  logAutoFix: vi.fn(),
  logAutoValidate: vi.fn(),
  logAutoValidateSkipped: vi.fn(),
  logBanner: mockLogBanner,
  logCard: mockLogCard,
  logCardList: mockLogCardList,
  logContextTrimmed: vi.fn(),
  logDetailEntries: mockLogDetailEntries,
  logDiffHeader: vi.fn(),
  logDiffLine: vi.fn(),
  logEmptyState: mockLogEmptyState,
  logError: mockLogError,
  logFileModified: vi.fn(),
  logHint: mockLogHint,
  logKeyValue: vi.fn(),
  logLine: mockLogLine,
  logSection: mockLogSection,
  logSuccess: mockLogSuccess,
  logToolCall: vi.fn(),
  logToolError: vi.fn(),
  logToolResult: vi.fn(),
  Spinner: class {
    start = mockSpinnerStart;
    stop = mockSpinnerStop;
  },
}));

import {
  collectMultilineInput,
  completeSlashCommand,
  describeApprovalRequest,
  getSlashCommandSuggestions,
  getWorkspaceDiffSummary,
  parseDiffCommandArgs,
  printInteractiveConfig,
  printInteractiveStatus,
  printProjectMemory,
  printTaskSteps,
  printWorkspaceDiff,
  startInteractive,
} from "./interactive.js";

describe("startInteractive", () => {
  it("shows workspace and app data hints on startup", async () => {
    mockQuestion.mockRejectedValueOnce(new Error("stop"));

    await startInteractive({ cwd: "/tmp/demo" });

    expect(mockSetWorkspaceRoot).toHaveBeenCalledWith("/tmp/demo");
    expect(mockLoadWorkspaceEnv).toHaveBeenCalledWith("/tmp/demo");
    expect(mockLogHint).toHaveBeenCalledWith(
      expect.stringContaining("当前工作区"),
    );
    expect(mockLogHint).toHaveBeenCalledWith(
      expect.stringContaining("用户数据目录"),
    );
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mockExeca.mockReset();
    mockQuestion.mockReset();
    mockClose.mockReset();
    mockListSessions.mockReset().mockResolvedValue([]);
    mockRestoreSession.mockReset().mockResolvedValue(false);
    mockRun.mockReset();
    mockPlan.mockReset();
    mockUndoLastRun.mockReset();
    mockExecuteTask.mockReset();
    mockRetryNextBlockedTask.mockReset();
    mockClearHistory.mockReset();
    mockReadProjectMemory.mockReset().mockResolvedValue({
      overview: "",
      preferences: [],
      commands: [],
      facts: [],
    });
    mockEditProjectMemory.mockReset().mockResolvedValue({
      overview: "",
      preferences: [],
      commands: [],
      facts: [],
    });
    mockReviewProjectMemoryEdit.mockReset().mockResolvedValue({
      proposed: { overview: "", preferences: [], commands: [], facts: [] },
      diff: "--- a/project-memory.json\n+++ b/project-memory.json",
    });
    mockLogAssistant.mockReset();
    mockLogBanner.mockReset();
    mockLogCard.mockReset();
    mockLogCardList.mockReset();
    mockLogDetailEntries.mockReset();
    mockLogEmptyState.mockReset();
    mockLogError.mockReset();
    mockLogHint.mockReset();
    mockLogLine.mockReset();
    mockLogSection.mockReset();
    mockLogSuccess.mockReset();
    mockSpinnerStart.mockReset();
    mockSpinnerStop.mockReset();
    mockLoadWorkspaceEnv.mockReset();
    mockGetRuntimeEnvInfo.mockReset().mockReturnValue({
      envFilePath: "/tmp/workspace/.env",
      hasEnvFile: true,
      openaiApiKeyConfigured: true,
      openaiBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-5.4",
    });
    mockReadWorkspacePackageJson.mockReset().mockResolvedValue(null);
    mockDetectPackageManager.mockReset().mockResolvedValue("npm");
    mockSetWorkspaceRoot.mockReset();
    mockGetWorkspaceRoot.mockReset().mockReturnValue("/tmp/workspace");
    mockGetAppDataDir
      .mockReset()
      .mockReturnValue("/tmp/home/.mini-claude-code");
    capturedConfirmCommand = null;
    capturedReviewMemory = null;
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("approval prompt can allow one action or same kind for current task", async () => {
    mockQuestion
      .mockRejectedValueOnce(new Error("stop"))
      .mockResolvedValueOnce("a");

    await startInteractive({ cwd: "/tmp/demo" });

    const response = await capturedConfirmCommand?.({
      kind: "command",
      command: "cat package.json",
      reason: "测试命令需要确认",
      policy: "guarded",
      source: "tool",
    });

    expect(response).toEqual({ approved: true, scope: "task_kind" });
    expect(mockLogSuccess).toHaveBeenCalledWith(
      expect.stringContaining("本任务同类操作不再询问"),
    );
  });

  it("collectMultilineInput reads fenced multiline input", async () => {
    const rl = {
      question: vi
        .fn()
        .mockResolvedValueOnce("第一行")
        .mockResolvedValueOnce("第二行")
        .mockResolvedValueOnce("```"),
    } as never;

    const result = await collectMultilineInput(rl, "```", () => "> ");

    expect(result).toBe("第一行\n第二行");
  });

  it("collectMultilineInput joins backslash-continued input", async () => {
    const rl = {
      question: vi.fn().mockResolvedValueOnce("第二行"),
    } as never;

    const result = await collectMultilineInput(rl, "第一行\\", () => "> ");

    expect(result).toBe("第一行\n第二行");
  });

  it("suggests slash commands for slash input", async () => {
    expect(getSlashCommandSuggestions("/sta")).toEqual([
      expect.stringContaining("/status"),
    ]);
    expect(completeSlashCommand("/sta")[0]).toContain("/status ");

    mockQuestion
      .mockResolvedValueOnce("/")
      .mockRejectedValueOnce(new Error("stop"));
    await startInteractive();

    expect(mockLogCardList).toHaveBeenCalledWith(
      "所有 slash 命令",
      expect.arrayContaining([
        expect.stringContaining("/exit"),
        expect.stringContaining("/help"),
        expect.stringContaining("/plan"),
        expect.stringContaining("/execute"),
        expect.stringContaining("/diff"),
        expect.stringContaining("/status"),
        expect.stringContaining("/memory"),
        expect.stringContaining("/reports"),
        expect.stringContaining("/sessions"),
        expect.stringContaining("/doctor"),
      ]),
    );
  });

  it("/sessions prints recent sessions", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "session-1",
        title: "修复构建",
        summary: "读了 src/index.ts",
        latestUserMessage: "修复错误",
        createdAt: "2026-04-14",
        updatedAt: "2026-04-14",
        turnCount: 2,
      },
    ]);
    mockQuestion
      .mockResolvedValueOnce("/sessions 修复")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockListSessions).toHaveBeenCalledTimes(1);
    expect(mockLogSection).toHaveBeenCalledWith("会话列表");
    expect(mockLogCardList).toHaveBeenCalledWith(
      "会话项",
      expect.arrayContaining([expect.stringContaining("session-1")]),
    );
  });

  it("/resume restores the requested session id", async () => {
    mockRestoreSession.mockResolvedValue(true);
    mockQuestion
      .mockResolvedValueOnce("/resume abc123")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockRestoreSession).toHaveBeenCalledWith("abc123");
    expect(mockLogSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已恢复会话 abc123"),
    );
  });

  it("resume option restores session on startup", async () => {
    mockRestoreSession.mockResolvedValue(true);
    mockQuestion.mockRejectedValueOnce(new Error("stop"));

    await startInteractive({ resumeSessionId: "saved-1" });

    expect(mockRestoreSession).toHaveBeenCalledWith("saved-1");
    expect(mockLogSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已恢复会话 saved-1"),
    );
  });

  it("/plan runs plan mode without normal execution", async () => {
    mockPlan.mockResolvedValue({
      diffs: [],
      finalText: "执行计划：先读文件，再验证。",
      steps: [],
    });
    mockQuestion
      .mockResolvedValueOnce("/plan 修复登录问题")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockPlan).toHaveBeenCalledWith("修复登录问题");
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockLogCard).toHaveBeenCalledWith("计划完成");
    expect(mockLogAssistant).toHaveBeenCalledWith(
      "执行计划：先读文件，再验证。",
    );
  });

  it("/plan without task shows usage", async () => {
    mockQuestion
      .mockResolvedValueOnce("/plan")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith("用法: /plan <task>");
  });

  it("/execute runs the last planned task", async () => {
    mockPlan.mockResolvedValue({
      diffs: [],
      finalText: "计划：修改并验证。",
      steps: ["计划步骤"],
    });
    mockRun.mockResolvedValue({
      diffs: [],
      finalText: "执行完成。",
      steps: ["执行步骤"],
    });
    mockQuestion
      .mockResolvedValueOnce("/plan 修复问题")
      .mockResolvedValueOnce("/execute")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockPlan).toHaveBeenCalledWith("修复问题");
    expect(mockRun).toHaveBeenCalledWith("修复问题");
    expect(mockLogCard).toHaveBeenCalledWith("执行最近计划");
    expect(mockLogAssistant).toHaveBeenCalledWith("执行完成。");
  });

  it("/execute without plan shows guidance", async () => {
    mockQuestion
      .mockResolvedValueOnce("/execute")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockRun).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      "没有可执行的计划，请先运行 /plan <task>，或使用 /execute <task>",
    );
  });

  it("/execute with explicit task runs that task", async () => {
    mockRun.mockResolvedValue({
      diffs: [],
      finalText: "显式执行完成。",
      steps: [],
    });
    mockQuestion
      .mockResolvedValueOnce("/execute 修复构建")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockRun).toHaveBeenCalledWith("修复构建");
    expect(mockLogAssistant).toHaveBeenCalledWith("显式执行完成。");
  });

  it("/execute-task continues a persisted task item", async () => {
    mockExecuteTask.mockResolvedValue({
      diffs: [],
      finalText: "任务继续完成。",
      steps: ["继续执行任务"],
      tasks: [{ id: 2, title: "验证", status: "done" }],
    });
    mockQuestion
      .mockResolvedValueOnce("/execute-task 2")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockExecuteTask).toHaveBeenCalledWith(2);
    expect(mockLogCard).toHaveBeenCalledWith("任务 2 执行完成");
    expect(mockLogAssistant).toHaveBeenCalledWith("任务继续完成。");
  });

  it("/execute-task validates task id", async () => {
    mockQuestion
      .mockResolvedValueOnce("/execute-task nope")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith("用法: /execute-task <id>");
  });

  it("parseDiffCommandArgs parses staged and path", () => {
    expect(parseDiffCommandArgs("/diff --staged src/a.ts")).toEqual({
      staged: true,
      path: "src/a.ts",
    });
    expect(parseDiffCommandArgs("/diff src/a.ts")).toEqual({
      staged: false,
      path: "src/a.ts",
    });
  });

  it("/diff prints current git diff", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: "diff --git a/src/a.ts b/src/a.ts\n+changed",
      stderr: "",
    });
    mockQuestion
      .mockResolvedValueOnce("/diff")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockExeca).toHaveBeenCalledWith("git", ["diff", "--", "."], {
      cwd: "/tmp/workspace",
      reject: false,
    });
    expect(mockLogSection).toHaveBeenCalledWith("当前工作区 Diff");
  });

  it("printWorkspaceDiff shows empty state when there is no diff", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await printWorkspaceDiff();

    expect(mockLogEmptyState).toHaveBeenCalledWith("当前没有未暂存差异。");
  });

  it("printWorkspaceDiff supports staged path diff", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: "diff --git a/src/a.ts b/src/a.ts\n+staged",
      stderr: "",
    });

    await printWorkspaceDiff({ staged: true, path: "src/a.ts" });

    expect(mockExeca).toHaveBeenCalledWith(
      "git",
      ["diff", "--staged", "--", "src/a.ts"],
      {
        cwd: "/tmp/workspace",
        reject: false,
      },
    );
    expect(mockLogSection).toHaveBeenCalledWith("当前暂存区 Diff");
  });

  it("getWorkspaceDiffSummary reports changed file count", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: " M src/a.ts\n?? src/b.ts",
      stderr: "",
    });

    await expect(getWorkspaceDiffSummary()).resolves.toBe("2 个变更文件");
  });

  it("printInteractiveStatus shows workspace session and git status", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: " M src/a.ts",
      stderr: "",
    });

    await printInteractiveStatus({
      turnCount: 3,
      taskStepCount: 2,
      canUndo: true,
    });

    expect(mockLogCard).toHaveBeenCalledWith("当前状态");
    expect(mockLogDetailEntries).toHaveBeenCalledWith(
      expect.arrayContaining([
        { label: "会话轮数", value: "3" },
        { label: "上一轮步骤数", value: "2" },
        { label: "可撤销上一轮", value: "是" },
        { label: "可撤销轮数", value: "1" },
        { label: "Git", value: "1 个变更文件" },
      ]),
    );
  });

  it("/status prints current interactive status", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mockQuestion
      .mockResolvedValueOnce("/status")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogCard).toHaveBeenCalledWith("当前状态");
    expect(mockLogDetailEntries).toHaveBeenCalledWith(
      expect.arrayContaining([
        { label: "会话轮数", value: "3" },
        { label: "可撤销轮数", value: "0" },
        { label: "Git", value: "干净（无未提交变更）" },
      ]),
    );
  });

  it("printInteractiveConfig shows sanitized runtime and tooling config", async () => {
    mockReadWorkspacePackageJson.mockResolvedValue({
      scripts: { test: "vitest run" },
      miniClaudeCode: {
        commandPolicy: { safeScripts: ["verify"], guardedScripts: ["serve"] },
      },
    });
    mockDetectPackageManager.mockResolvedValue("pnpm");

    await printInteractiveConfig();

    expect(mockLogCard).toHaveBeenCalledWith("当前配置");
    expect(mockLogDetailEntries).toHaveBeenCalledWith(
      expect.arrayContaining([
        { label: "OPENAI_API_KEY", value: "已配置" },
        { label: "MODEL_NAME", value: "gpt-5.4" },
        { label: "包管理器", value: "pnpm" },
        { label: "命令安全脚本", value: "verify" },
        { label: "命令需确认脚本", value: "serve" },
      ]),
    );
  });

  it("/config prints current configuration", async () => {
    mockQuestion
      .mockResolvedValueOnce("/config")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogCard).toHaveBeenCalledWith("当前配置");
    expect(mockLogDetailEntries).toHaveBeenCalledWith(
      expect.arrayContaining([{ label: "OPENAI_API_KEY", value: "已配置" }]),
    );
  });

  it("prints and edits project memory", async () => {
    mockReadProjectMemory.mockResolvedValueOnce({
      overview: "local agent",
      preferences: ["short"],
      commands: ["npm test"],
      facts: [
        {
          id: "uses-ts",
          text: "uses TypeScript",
          source: "manual",
          confidence: 0.8,
        },
      ],
    });

    await printProjectMemory();
    await printProjectMemory("review remove uses-ts");
    await printProjectMemory("remove uses-ts");
    await printProjectMemory("review overview next overview");
    await printProjectMemory("overview updated overview");
    await printProjectMemory("clear");

    expect(mockLogCard).toHaveBeenCalledWith("项目长期记忆");
    expect(mockEditProjectMemory).toHaveBeenCalledWith({
      removeFactIds: ["uses-ts"],
    });
    expect(mockReviewProjectMemoryEdit).toHaveBeenCalledWith({
      removeFactIds: ["uses-ts"],
    });
    expect(mockReviewProjectMemoryEdit).toHaveBeenCalledWith({
      overview: "next overview",
    });
    expect(mockEditProjectMemory).toHaveBeenCalledWith({
      overview: "updated overview",
    });
    expect(mockEditProjectMemory).toHaveBeenCalledWith({ clear: true });
  });

  it("prompts for automatic memory review decisions", async () => {
    mockQuestion.mockRejectedValueOnce(new Error("stop"));
    await startInteractive();

    mockQuestion.mockResolvedValueOnce("y");
    await expect(capturedReviewMemory?.({ diff: "memory diff" })).resolves.toBe(
      "accept",
    );

    mockQuestion.mockResolvedValueOnce("n");
    await expect(capturedReviewMemory?.({ diff: "memory diff" })).resolves.toBe(
      "reject",
    );

    mockQuestion.mockResolvedValueOnce("e").mockResolvedValueOnce("edited");
    await expect(
      capturedReviewMemory?.({ diff: "memory diff" }),
    ).resolves.toEqual({ update: { overview: "edited" } });

    mockQuestion
      .mockResolvedValueOnce("s")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("2:npm run test:focused");
    await expect(
      capturedReviewMemory?.({
        diff: "memory diff",
        candidates: {
          commands: ["npm test"],
          facts: [
            {
              text: "常用验证命令: npm test",
              source: "auto",
              confidence: 0.6,
              updatedAt: "2026-05-06T00:00:00.000Z",
            },
          ],
        },
        items: [
          {
            key: "command:npm test",
            kind: "command",
            text: "npm test",
            label: "命令: npm test",
          },
          {
            key: "fact:npm-test",
            kind: "fact",
            text: "常用验证命令: npm test",
            label: "事实: 常用验证命令: npm test",
          },
        ],
      }),
    ).resolves.toEqual({
      update: {
        preferences: [],
        commands: [],
        facts: [expect.objectContaining({ text: "npm run test:focused" })],
      },
    });
  });

  it("/memory command opens project memory view", async () => {
    mockQuestion
      .mockResolvedValueOnce("/memory")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockReadProjectMemory).toHaveBeenCalled();
    expect(mockLogCard).toHaveBeenCalledWith("项目长期记忆");
  });

  it("/undo restores last agent changes", async () => {
    mockUndoLastRun.mockResolvedValue({
      finalText: "已撤销上一轮修改: src/a.ts",
      steps: [],
      diffs: [
        {
          path: "src/a.ts",
          summary: "撤销修改",
          diff: "--- a/src/a.ts\n+++ b/src/a.ts",
        },
      ],
    });
    mockQuestion
      .mockResolvedValueOnce("/undo")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockUndoLastRun).toHaveBeenCalledTimes(1);
    expect(mockLogCard).toHaveBeenCalledWith("撤销完成");
    expect(mockLogSection).toHaveBeenCalledWith("撤销预览");
    expect(mockLogAssistant).toHaveBeenCalledWith("已撤销上一轮修改: src/a.ts");
  });

  it("/tasks prints last task steps", async () => {
    mockRun.mockResolvedValue({
      diffs: [],
      finalText: "完成",
      steps: ["读取文件", "执行验证"],
      tasks: [
        {
          id: 1,
          title: "验证",
          status: "blocked",
          failureCount: 1,
          history: [
            {
              at: "2026-05-06T00:00:00.000Z",
              status: "blocked",
              failureCount: 1,
              retrySuggestion: "重试验证",
            },
          ],
        },
      ],
    });
    mockQuestion
      .mockResolvedValueOnce("修复问题")
      .mockResolvedValueOnce("/tasks")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogSection).toHaveBeenCalledWith("任务步骤");
    expect(mockLogCardList).toHaveBeenCalledWith("任务状态", [
      expect.stringContaining("失败次数: 1"),
    ]);
    expect(mockLogCardList).toHaveBeenCalledWith("上一轮步骤", [
      "**1.** 读取文件",
      "**2.** 执行验证",
    ]);
  });

  it("/tasks timeline prints task history", async () => {
    mockRun.mockResolvedValue({
      diffs: [],
      finalText: "完成",
      steps: [],
      tasks: [
        {
          id: 1,
          title: "验证",
          status: "blocked",
          history: [
            {
              at: "2026-05-06T00:00:00.000Z",
              status: "blocked",
              failureCount: 1,
              retrySuggestion: "重试验证",
            },
          ],
        },
      ],
    });
    mockQuestion
      .mockResolvedValueOnce("修复问题")
      .mockResolvedValueOnce("/tasks timeline")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogCardList).toHaveBeenCalledWith("任务时间线", [
      expect.stringContaining("重试验证"),
    ]);
  });

  it("/retry-task retries first runnable blocked task", async () => {
    mockRetryNextBlockedTask.mockResolvedValue({
      diffs: [],
      finalText: "重试完成",
      steps: ["自动重试任务"],
      tasks: [{ id: 1, title: "验证", status: "done" }],
    });
    mockQuestion
      .mockResolvedValueOnce("/retry-task")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockRetryNextBlockedTask).toHaveBeenCalledTimes(1);
    expect(mockLogCard).toHaveBeenCalledWith("任务自动重试完成");
  });

  it("printTaskSteps shows empty state", () => {
    printTaskSteps([]);
    expect(mockLogEmptyState).toHaveBeenCalledWith(
      "当前还没有可展示的任务步骤。",
    );
  });

  it("/init prints setup guidance", async () => {
    mockQuestion
      .mockResolvedValueOnce("/init")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogHint).toHaveBeenCalledWith(
      expect.stringContaining("mini-claude-code init"),
    );
  });

  it("/doctor prints setup guidance", async () => {
    mockQuestion
      .mockResolvedValueOnce("/doctor")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogHint).toHaveBeenCalledWith(
      expect.stringContaining("mini-claude-code doctor"),
    );
  });

  it("unknown slash command uses error block", async () => {
    mockQuestion
      .mockResolvedValueOnce("/wat")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("未知命令"),
    );
  });

  it("clear command resets history with success block", async () => {
    mockQuestion
      .mockResolvedValueOnce("/clear")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockClearHistory).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).toHaveBeenCalledWith(
      expect.stringContaining("上下文已清空"),
    );
  });

  it("successful task shows completion card before assistant output", async () => {
    mockRun.mockResolvedValue({
      diffs: [],
      finalText: "完成结果",
    });
    mockQuestion
      .mockResolvedValueOnce("修复问题")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockLogCard).toHaveBeenCalledWith("执行完成");
    expect(mockLogEmptyState).toHaveBeenCalledWith("本轮没有文件变更。");
    expect(mockLogAssistant).toHaveBeenCalledWith("完成结果");
  });

  it("approval prompt metadata includes risk level and default policy details", () => {
    const description = describeApprovalRequest({
      kind: "command",
      command: "npm run lint",
      reason: "需要安装依赖",
    } as never);

    expect(description.riskLevel).toBe("中");
    expect(description.defaultPolicy).toContain("默认拒绝");
    expect(description.detailLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "原因", value: "需要安装依赖" }),
      ]),
    );
  });
});
