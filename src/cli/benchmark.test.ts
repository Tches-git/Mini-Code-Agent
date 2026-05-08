import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunBenchmark = vi.hoisted(() => vi.fn());
const mockBenchmarkTasks = vi.hoisted(
  () =>
    [] as Array<{
      id: string;
      category: string;
      enabled?: boolean;
      title: string;
      description: string;
    }>,
);

vi.mock("../benchmark/index.js", () => ({
  runBenchmark: mockRunBenchmark,
  getBenchmarkDashboardPaths: (outputPath: string) => ({
    markdown: `${outputPath}.md`,
    html: `${outputPath}.html`,
    history: `${outputPath}.history.json`,
  }),
}));

vi.mock("../benchmark/runtime.js", () => ({
  resolveBenchmarkReportPath: (outputPath?: string) =>
    outputPath || "benchmark-report.json",
}));

vi.mock("../benchmark/tasks.js", () => ({
  benchmarkTasks: mockBenchmarkTasks,
}));

import { runBenchmarkCommand } from "./benchmark.js";

describe("runBenchmarkCommand", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRunBenchmark.mockReset().mockResolvedValue({
      generatedAt: "2026-04-20T00:00:00.000Z",
      summary: {
        total: 0,
        executed: 0,
        skipped: 0,
        passed: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgSteps: 0,
        avgToolCalls: 0,
        avgValidationRuns: 0,
        avgAutoFixes: 0,
        avgContextTrimmed: 0,
        byCategory: [],
        skipReasons: [],
        failures: { none: 0, skip: 0, agent: 0, environment: 0 },
        slowestTasks: [],
        releaseChecklist: [],
      },
      tasks: [],
    });
    mockBenchmarkTasks.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("defaults benchmark runs to temp_copy isolation", async () => {
    await runBenchmarkCommand({});

    expect(mockRunBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: expect.objectContaining({
          mode: "temp_copy",
          cleanup: true,
        }),
      }),
    );
  });

  it("keeps explicit isolation mode when provided", async () => {
    await runBenchmarkCommand({ isolationMode: "in_place" });

    expect(mockRunBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: expect.objectContaining({
          mode: "in_place",
        }),
      }),
    );
  });

  it("renders formatted benchmark summary", async () => {
    mockRunBenchmark.mockResolvedValue({
      generatedAt: "2026-04-20T00:00:00.000Z",
      summary: {
        total: 2,
        executed: 2,
        skipped: 0,
        passed: 1,
        successRate: 0.5,
        avgDurationMs: 120,
        avgSteps: 3,
        avgToolCalls: 4,
        avgValidationRuns: 1,
        avgAutoFixes: 0,
        avgContextTrimmed: 0,
        byCategory: [
          {
            category: "read",
            total: 1,
            executed: 1,
            skipped: 0,
            passed: 1,
            successRate: 1,
          },
        ],
        skipReasons: [],
        failures: { none: 1, skip: 0, agent: 1, environment: 0 },
        slowestTasks: [],
        releaseChecklist: [],
      },
      tasks: [],
    });

    await runBenchmarkCommand({});

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Benchmark 摘要"),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("通过率"));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("按任务类别统计"),
    );
  });

  it("renders task list view with shared bullet and key-value layout", async () => {
    mockBenchmarkTasks.push({
      id: "bench-1",
      category: "read",
      enabled: false,
      title: "### 标题",
      description: "**说明**",
    });

    await runBenchmarkCommand({ list: true });

    const calls = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(calls).toContain("可用 benchmark 任务");
    expect(calls).toContain("bench-1");
    expect(calls).toContain("标题");
    expect(calls).toContain("说明");
    expect(calls).not.toContain("###");
  });
});
