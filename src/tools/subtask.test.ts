import { beforeEach, describe, expect, it, vi } from "vitest";

const mockChat = vi.hoisted(() => vi.fn());

vi.mock("../llm/client.js", () => ({
  LlmClient: class {
    chat = mockChat;
  },
}));

import {
  clearSubtaskResultCache,
  getSubtaskTools,
  runReadOnlySubtask,
  subtaskTools,
} from "./subtask.js";

beforeEach(() => {
  mockChat.mockReset();
  clearSubtaskResultCache();
});

describe("subtask tools", () => {
  it("only exposes read-only tools to subagents", () => {
    const names = getSubtaskTools().map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("search_text");
    expect(names).toContain("project_map");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("git_commit");
  });

  it("includes single and batch task tools", () => {
    expect(subtaskTools.map((tool) => tool.name)).toEqual([
      "task",
      "task_batch",
    ]);
  });

  it("returns structured subtask status and cache hits", async () => {
    mockChat.mockResolvedValueOnce({ text: "分析完成", toolCalls: [] });

    const first = await runReadOnlySubtask({ task: "分析 session restore" });
    const second = await runReadOnlySubtask({ task: "分析 session restore" });

    expect(first).toMatchObject({
      status: "done",
      task: "分析 session restore",
      result: "分析完成",
      roundsUsed: 1,
      estimatedTokens: 1,
    });
    expect(first.startedAt).toBeDefined();
    expect(first.finishedAt).toBeDefined();
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.cached).toBe(true);
    expect(second.cacheExpiresAt).toBeDefined();
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("task_batch enforces token budget", async () => {
    mockChat.mockResolvedValue({ text: "x".repeat(6000), toolCalls: [] });
    const batchTool = subtaskTools.find((tool) => tool.name === "task_batch");
    if (!batchTool) throw new Error("task_batch tool missing");

    const raw = await batchTool.execute({
      tokenBudget: 1000,
      tasks: [{ task: "one" }, { task: "two" }, { task: "three" }],
    });
    const result = JSON.parse(typeof raw === "string" ? raw : raw.message);

    expect(result.status).toBe("truncated");
    expect(result.usedTokens).toBeGreaterThan(1000);
    expect(result.results[2]).toMatchObject({
      status: "truncated",
      retrySuggestion: "整批子任务 token 预算已耗尽，建议拆分批次。",
    });
  });

  it("task_batch supports configurable governance", async () => {
    mockChat.mockResolvedValue({ text: "x".repeat(2000), toolCalls: [] });
    const batchTool = subtaskTools.find((tool) => tool.name === "task_batch");
    if (!batchTool) throw new Error("task_batch tool missing");

    const raw = await batchTool.execute({
      maxConcurrency: 1,
      maxRetries: 0,
      cacheTtlMs: 0,
      tasks: [
        { task: "one", maxOutputLength: 600 },
        { task: "two", maxOutputLength: 600 },
      ],
    });
    const result = JSON.parse(typeof raw === "string" ? raw : raw.message);

    expect(result.status).toBe("truncated");
    expect(result.maxConcurrency).toBe(1);
    expect(result.maxRetries).toBe(0);
    expect(result.cacheTtlMs).toBe(0);
    expect(result.results[0]).toMatchObject({
      status: "truncated",
      result: expect.stringContaining("子任务输出已截断"),
    });
  });

  it("task_batch can cancel remaining tasks and reports progress", async () => {
    mockChat.mockResolvedValue({ text: "完成", toolCalls: [] });
    const batchTool = subtaskTools.find((tool) => tool.name === "task_batch");
    if (!batchTool) throw new Error("task_batch tool missing");

    const raw = await batchTool.execute({
      maxConcurrency: 1,
      cancelAfterTasks: 1,
      tasks: [{ task: "one" }, { task: "two" }, { task: "three" }],
    });
    const result = JSON.parse(typeof raw === "string" ? raw : raw.message);

    expect(result.canceled).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.results[0]).toMatchObject({ progress: "1/3" });
    expect(result.results[1]).toMatchObject({
      status: "truncated",
      retrySuggestion: "子任务批次已取消，剩余任务未启动。",
    });
  });

  it("task_batch isolates individual failures", async () => {
    mockChat.mockRejectedValueOnce(new Error("provider busy"));
    mockChat.mockRejectedValueOnce(new Error("provider busy"));
    mockChat.mockResolvedValueOnce({ text: "第二个完成", toolCalls: [] });
    const batchTool = subtaskTools.find((tool) => tool.name === "task_batch");
    if (!batchTool) throw new Error("task_batch tool missing");

    const raw = await batchTool.execute({
      maxConcurrency: 1,
      tasks: [{ task: "失败任务" }, { task: "成功任务" }],
    });
    const result = JSON.parse(typeof raw === "string" ? raw : raw.message);

    expect(result.status).toBe("failed");
    expect(result.maxConcurrency).toBe(1);
    expect(result.maxRetries).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.tokenBudget).toBe(12000);
    expect(result.usedTokens).toBeGreaterThan(0);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      attempts: 2,
      error: "provider busy",
      retrySuggestion: "提供方繁忙或超时，稍后重试或降低并发/轮数。",
    });
    expect(result.results[1]).toMatchObject({
      status: "done",
      result: "第二个完成",
    });
  });
});
