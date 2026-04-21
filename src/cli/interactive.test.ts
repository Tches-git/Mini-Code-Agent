import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadWorkspaceEnv = vi.hoisted(() => vi.fn());
const mockQuestion = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockListSessions = vi.hoisted(() => vi.fn());
const mockRestoreSession = vi.hoisted(() => vi.fn());
const mockRun = vi.hoisted(() => vi.fn());
const mockClearHistory = vi.hoisted(() => vi.fn());
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
const mockGetAppDataDir = vi.hoisted(() => vi.fn(() => "/tmp/home/.mini-claude-code"));

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
}));

vi.mock("../agent/orchestrator.js", () => ({
  AgentOrchestrator: class {
    turnCount = 3;
    restoreSession = mockRestoreSession;
    run = mockRun;
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

import { describeApprovalRequest, startInteractive } from "./interactive.js";

describe("startInteractive", () => {
  it("shows workspace and app data hints on startup", async () => {
    mockQuestion.mockRejectedValueOnce(new Error("stop"));

    await startInteractive({ cwd: "/tmp/demo" });

    expect(mockSetWorkspaceRoot).toHaveBeenCalledWith("/tmp/demo");
    expect(mockLoadWorkspaceEnv).toHaveBeenCalledWith("/tmp/demo");
    expect(mockLogHint).toHaveBeenCalledWith(expect.stringContaining("当前工作区"));
    expect(mockLogHint).toHaveBeenCalledWith(expect.stringContaining("用户数据目录"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mockQuestion.mockReset();
    mockClose.mockReset();
    mockListSessions.mockReset().mockResolvedValue([]);
    mockRestoreSession.mockReset().mockResolvedValue(false);
    mockRun.mockReset();
    mockClearHistory.mockReset();
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
    mockSetWorkspaceRoot.mockReset();
    mockGetWorkspaceRoot.mockReset().mockReturnValue("/tmp/workspace");
    mockGetAppDataDir.mockReset().mockReturnValue("/tmp/home/.mini-claude-code");
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
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
      .mockResolvedValueOnce("/sessions")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockListSessions).toHaveBeenCalledTimes(1);
    expect(mockLogCardList).toHaveBeenCalledWith(
      "可恢复会话",
      expect.arrayContaining([expect.stringContaining("session-1")]),
      { emptyText: "当前没有可恢复的会话。" },
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

    expect(description.riskLevel).toBe("高");
    expect(description.defaultPolicy).toContain("默认拒绝");
    expect(description.detailLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "原因", value: "需要安装依赖" }),
      ]),
    );
  });
});
