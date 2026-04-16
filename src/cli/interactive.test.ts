import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuestion = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockListSessions = vi.hoisted(() => vi.fn());
const mockRestoreSession = vi.hoisted(() => vi.fn());
const mockRun = vi.hoisted(() => vi.fn());
const mockClearHistory = vi.hoisted(() => vi.fn());
const mockLogBanner = vi.hoisted(() => vi.fn());
const mockSpinnerStart = vi.hoisted(() => vi.fn());
const mockSpinnerStop = vi.hoisted(() => vi.fn());

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

vi.mock("../agent/orchestrator.js", () => ({
  AgentOrchestrator: class {
    turnCount = 3;
    restoreSession = mockRestoreSession;
    run = mockRun;
    clearHistory = mockClearHistory;
  },
}));

vi.mock("../utils/logger.js", () => ({
  logAssistant: vi.fn(),
  logAutoFix: vi.fn(),
  logAutoValidate: vi.fn(),
  logAutoValidateSkipped: vi.fn(),
  logBanner: mockLogBanner,
  logContextTrimmed: vi.fn(),
  logDiffHeader: vi.fn(),
  logDiffLine: vi.fn(),
  logFileModified: vi.fn(),
  logToolCall: vi.fn(),
  logToolError: vi.fn(),
  logToolResult: vi.fn(),
  Spinner: class {
    start = mockSpinnerStart;
    stop = mockSpinnerStop;
  },
}));

import { startInteractive } from "./interactive.js";

describe("startInteractive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockQuestion.mockReset();
    mockClose.mockReset();
    mockListSessions.mockReset().mockResolvedValue([]);
    mockRestoreSession.mockReset().mockResolvedValue(false);
    mockRun.mockReset();
    mockClearHistory.mockReset();
    mockLogBanner.mockReset();
    mockSpinnerStart.mockReset();
    mockSpinnerStop.mockReset();
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
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("可恢复会话"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("session-1"),
    );
  });

  it("/resume restores the requested session id", async () => {
    mockRestoreSession.mockResolvedValue(true);
    mockQuestion
      .mockResolvedValueOnce("/resume abc123")
      .mockRejectedValueOnce(new Error("stop"));

    await startInteractive();

    expect(mockRestoreSession).toHaveBeenCalledWith("abc123");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("已恢复会话 abc123"),
    );
  });

  it("resume option restores session on startup", async () => {
    mockRestoreSession.mockResolvedValue(true);
    mockQuestion.mockRejectedValueOnce(new Error("stop"));

    await startInteractive({ resumeSessionId: "saved-1" });

    expect(mockRestoreSession).toHaveBeenCalledWith("saved-1");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("已恢复会话 saved-1"),
    );
  });
});
