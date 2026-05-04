import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListSessions = vi.hoisted(() => vi.fn());
const mockLoadSession = vi.hoisted(() => vi.fn());

vi.mock("../agent/session.js", () => ({
  listSessions: mockListSessions,
  loadSession: mockLoadSession,
}));

import {
  matchesSessionQuery,
  printSessionDetail,
  printSessions,
} from "./sessions.js";

describe("sessions cli output", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockListSessions.mockReset();
    mockLoadSession.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("renders session list with summary and latest message fields", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "session-1",
        title: "### 修复构建",
        summary: "**读了** src/index.ts",
        latestUserMessage: "### 修复错误",
        createdAt: "2026-04-20T08:00:00.000Z",
        updatedAt: "2026-04-20T09:00:00.000Z",
        turnCount: 2,
      },
    ]);

    await printSessions();

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("会话列表");
    expect(calls).toContain("session-1");
    expect(calls).toContain("摘要");
    expect(calls).toContain("最新消息");
    expect(calls).toContain("修复错误");
    expect(calls).not.toContain("###");
  });

  it("renders session detail with cleaned latest user message", async () => {
    mockLoadSession.mockResolvedValue({
      id: "session-9",
      title: "调查问题",
      summary: "**已整理** 线索",
      latestUserMessage: "### 最新提问",
      createdAt: "2026-04-20T08:00:00.000Z",
      updatedAt: "2026-04-20T09:00:00.000Z",
      turnCount: 4,
      version: 1,
      messages: [],
      summaryLines: [],
      summaryFocus: {
        files: ["src/agent/session.ts"],
        keywords: ["session", "restore"],
      },
    });

    await printSessionDetail("session-9");

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("会话详情");
    expect(calls).toContain("焦点文件");
    expect(calls).toContain("焦点关键词");
    expect(calls).toContain("最新用户消息");
    expect(calls).toContain("最新提问");
    expect(calls).not.toContain("###");
  });

  it("renders empty session list with shared empty-state style", async () => {
    mockListSessions.mockResolvedValue([]);

    await printSessions();

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("会话列表");
    expect(calls).toContain("当前没有可恢复的会话");
  });

  it("supports session detail json output", async () => {
    mockLoadSession.mockResolvedValue({
      id: "session-json",
      title: "json title",
      summary: "json summary",
      latestUserMessage: "json message",
      createdAt: "2026-04-20T08:00:00.000Z",
      updatedAt: "2026-04-20T09:00:00.000Z",
      turnCount: 1,
      version: 1,
      messages: [],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
    });

    await printSessionDetail("session-json", { json: true });

    const payload = vi.mocked(console.log).mock.calls[0]?.[0];
    expect(typeof payload).toBe("string");
    expect(String(payload)).toContain('"id": "session-json"');
  });

  it("matches session query across title summary and latest message", () => {
    const session = {
      id: "session-auth",
      title: "实现登录",
      summary: "修改 auth middleware",
      latestUserMessage: "继续验证 token",
      createdAt: "2026-04-20T08:00:00.000Z",
      updatedAt: "2026-04-20T09:00:00.000Z",
      turnCount: 3,
    };

    expect(matchesSessionQuery(session, "AUTH")).toBe(true);
    expect(matchesSessionQuery(session, "token")).toBe(true);
    expect(matchesSessionQuery(session, "missing")).toBe(false);
  });

  it("filters session lists by query", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "s-auth",
        title: "认证问题",
        summary: "auth summary",
        latestUserMessage: "修复 token",
        createdAt: "2026-04-20T08:00:00.000Z",
        updatedAt: "2026-04-20T09:00:00.000Z",
        turnCount: 1,
      },
      {
        id: "s-build",
        title: "构建问题",
        summary: "build summary",
        latestUserMessage: "修复 tsc",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T11:00:00.000Z",
        turnCount: 2,
      },
    ]);

    await printSessions({ query: "auth" });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("s-auth");
    expect(calls).not.toContain("s-build");
    expect(calls).toContain("过滤");
  });

  it("supports paging and sorting session lists", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "s1",
        title: "第一",
        summary: "summary 1",
        latestUserMessage: "message 1",
        createdAt: "2026-04-20T08:00:00.000Z",
        updatedAt: "2026-04-20T09:00:00.000Z",
        turnCount: 1,
      },
      {
        id: "s2",
        title: "第二",
        summary: "summary 2",
        latestUserMessage: "message 2",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T11:00:00.000Z",
        turnCount: 5,
      },
    ]);

    await printSessions({ limit: 1, page: 1, sort: "turns" });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("排序");
    expect(calls).toContain("轮数");
    expect(calls).toContain("s2");
    expect(calls).not.toContain("s1");
  });
});
