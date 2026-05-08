import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setWorkspaceRoot } from "../utils/runtime.js";

const mockChatStream = vi.hoisted(() => vi.fn());

vi.mock("../llm/client.js", () => ({
  LlmClient: class {
    chatStream = mockChatStream;
  },
}));

import {
  getBenchmarkDashboardPaths,
  getEffectiveDiffCount,
  normalizeModifiedPath,
  runBenchmark,
} from "./index.js";

const TEST_TIMEOUT_MS = 15000;

describe("runBenchmark report summary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockChatStream.mockReset();
    setWorkspaceRoot(process.cwd());
  });

  it(
    "aggregates byCategory, skipReasons and failures",
    async () => {
      mockChatStream.mockImplementation(
        async (_messages, _tools, _onEvent) => ({
          text: "完成。",
          toolCalls: [],
        }),
      );

      const report = await runBenchmark({
        taskIds: [
          "project-structure-overview",
          "code-agent-tooling-smoke",
          "interactive-cli-commands-smoke",
          "file-and-command-inspection-smoke",
          "fix-readme-command",
          "rename-local-symbol",
          "fix-interactive-resume-regression",
          "fix-failing-token-test",
          "fix-approval-policy-regression",
        ],
        isolation: {
          mode: "temp_copy",
          cleanup: true,
        },
      });

      expect(report.summary.byCategory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "read", total: 4 }),
          expect.objectContaining({ category: "edit", total: 2 }),
          expect.objectContaining({ category: "validate", total: 3 }),
        ]),
      );
      expect(report.summary.skipReasons.length).toBeGreaterThanOrEqual(1);
      expect(report.summary.failures.skip).toBeGreaterThanOrEqual(0);
      expect(report.summary.slowestTasks.length).toBeGreaterThan(0);
      expect(report.summary.releaseChecklist.length).toBeGreaterThan(0);
      expect(report.tasks.every((task) => task.failureType)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "captures runtime errors as environment failures instead of crashing",
    async () => {
      mockChatStream.mockImplementationOnce(async () => {
        throw new Error(
          "APIConnectionError: Connection error. connect EPERM pipe",
        );
      });

      const report = await runBenchmark({
        taskIds: ["project-structure-overview"],
        isolation: {
          mode: "temp_copy",
          cleanup: true,
        },
      });

      expect(report.tasks).toHaveLength(1);
      expect(report.tasks[0]?.failureType).toBe("environment");
      expect(report.tasks[0]?.passed).toBe(false);
      expect(report.summary.failures.environment).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs benchmark in mock mode without calling provider",
    async () => {
      const report = await runBenchmark({
        taskIds: ["memory-smoke", "semantic-finder-smoke"],
        mock: true,
        isolation: {
          mode: "temp_copy",
          cleanup: true,
        },
      });

      expect(mockChatStream).not.toHaveBeenCalled();
      expect(report.summary.passed).toBe(2);
      expect(report.summary.successRate).toBe(1);
      expect(report.summary.releaseChecklist.every((item) => item.ok)).toBe(
        true,
      );
      expect(report.tasks.every((task) => task.passed)).toBe(true);
      expect(report.tasks[0]?.finalText).toContain("mock benchmark result");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stores benchmark history and uses it for trend",
    async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), "benchmark-history-"),
      );
      const outputPath = path.join(tempDir, "report.json");
      try {
        const first = await runBenchmark({
          taskIds: ["memory-smoke"],
          outputPath,
          mock: true,
          isolation: { mode: "temp_copy", cleanup: true },
        });
        const second = await runBenchmark({
          taskIds: ["memory-smoke"],
          outputPath,
          mock: true,
          isolation: { mode: "temp_copy", cleanup: true },
        });
        const paths = getBenchmarkDashboardPaths(outputPath);
        const history = JSON.parse(await readFile(paths.history, "utf8"));
        const markdown = await readFile(paths.markdown, "utf8");
        const html = await readFile(paths.html, "utf8");

        expect(first.summary.trend).toBeUndefined();
        expect(second.summary.trend?.historyCount).toBe(1);
        expect(history).toHaveLength(2);
        expect(history[1]).toMatchObject({ successRate: 1, passed: 1 });
        expect(markdown).toContain("Benchmark Dashboard");
        expect(markdown).toContain("Trend History");
        expect(html).toContain("<title>Benchmark Dashboard</title>");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "can soft-pass provider environment failures",
    async () => {
      mockChatStream.mockImplementationOnce(async () => {
        throw new Error("APIConnectionError: Connection error");
      });

      const report = await runBenchmark({
        taskIds: ["project-structure-overview"],
        environmentSoftFail: true,
        isolation: {
          mode: "temp_copy",
          cleanup: true,
        },
      });

      expect(report.tasks[0]?.failureType).toBe("environment");
      expect(report.tasks[0]?.passed).toBe(true);
      expect(report.summary.passed).toBe(1);
      expect(
        report.summary.releaseChecklist.find((item) =>
          item.label.includes("environment"),
        )?.ok,
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it("normalizes modified paths from isolated workspaces", () => {
    const normalizedPath = normalizeModifiedPath(
      path.join(process.cwd(), "src/cli/interactive.ts"),
    );

    expect(normalizedPath).toBe("src/cli/interactive.ts");
  });

  it("uses modified file count for validate and auto-fix diff checks", () => {
    expect(
      getEffectiveDiffCount(
        {
          id: "validate-task",
          title: "validate task",
          category: "validate",
          prompt: "",
          description: "",
          expectation: {},
        },
        {
          toolCalls: 0,
          validationRuns: 0,
          autoFixes: 0,
          diffs: 6,
          contextTrimmed: 0,
          modifiedFiles: ["src/foo.ts"],
          validationPassed: true,
        },
      ),
    ).toBe(1);

    expect(
      getEffectiveDiffCount(
        {
          id: "edit-task",
          title: "edit task",
          category: "edit",
          prompt: "",
          description: "",
          expectation: {},
        },
        {
          toolCalls: 0,
          validationRuns: 0,
          autoFixes: 0,
          diffs: 6,
          contextTrimmed: 0,
          modifiedFiles: ["src/foo.ts"],
          validationPassed: true,
        },
      ),
    ).toBe(6);
  });
});
