import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { isValidationCommand } from "../agent/validation.js";
import type { AgentEvent, ApprovalRequest } from "../types/agent.js";
import { getWorkspaceRoot } from "../utils/runtime.js";
import {
  type BenchmarkIsolationConfig,
  prepareBenchmarkIsolation,
} from "./isolation.js";
import { resolveBenchmarkReportPath, withBenchmarkWorkspace } from "./runtime.js";
import {
  type BenchmarkTask,
  type BenchmarkTaskPrecondition,
  benchmarkTasks,
} from "./tasks.js";

type BenchmarkTaskMetrics = {
  toolCalls: number;
  validationRuns: number;
  autoFixes: number;
  diffs: number;
  contextTrimmed: number;
  modifiedFiles: string[];
  validationPassed: boolean;
};

type BenchmarkFailureType = "none" | "skip" | "agent" | "environment";

type BenchmarkTaskResult = {
  id: string;
  title: string;
  category: BenchmarkTask["category"];
  prompt: string;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  failureType: BenchmarkFailureType;
  durationMs: number;
  finalText: string;
  stepsCount: number;
  metrics: BenchmarkTaskMetrics;
  expectationChecks: {
    finalTextIncludes: string[];
    finalTextIncludesAny: string[][];
    minToolCallsMet: boolean;
    maxDiffsMet: boolean;
    maxValidationRunsMet: boolean;
    minValidationRunsMet: boolean;
    minAutoFixesMet: boolean;
    expectedModifiedFilesMissing: string[];
    forbiddenModifiedFilesPresent: string[];
    mustPassValidationMet: boolean;
  };
};

type BenchmarkCategorySummary = {
  category: BenchmarkTask["category"];
  total: number;
  executed: number;
  skipped: number;
  passed: number;
  successRate: number;
};

type BenchmarkSkipReasonSummary = {
  reason: string;
  count: number;
  taskIds: string[];
};

type BenchmarkFailureSummary = {
  none: number;
  skip: number;
  agent: number;
  environment: number;
};

type BenchmarkSummary = {
  total: number;
  executed: number;
  skipped: number;
  passed: number;
  successRate: number;
  avgDurationMs: number;
  avgSteps: number;
  avgToolCalls: number;
  avgValidationRuns: number;
  avgAutoFixes: number;
  avgContextTrimmed: number;
  byCategory: BenchmarkCategorySummary[];
  skipReasons: BenchmarkSkipReasonSummary[];
  failures: BenchmarkFailureSummary;
};

export type BenchmarkReport = {
  generatedAt: string;
  summary: BenchmarkSummary;
  tasks: BenchmarkTaskResult[];
};

export type BenchmarkRunOptions = {
  taskIds?: string[];
  outputPath?: string;
  includeDisabled?: boolean;
  isolation?: BenchmarkIsolationConfig;
};

function createMetrics(): BenchmarkTaskMetrics {
  return {
    toolCalls: 0,
    validationRuns: 0,
    autoFixes: 0,
    diffs: 0,
    contextTrimmed: 0,
    modifiedFiles: [],
    validationPassed: true,
  };
}

function parseRunCommandArgs(args: string): { command?: string } | null {
  try {
    return JSON.parse(args) as { command?: string };
  } catch {
    return null;
  }
}

function parseRunCommandResult(
  result: string,
): { command?: string; exitCode?: number | null } | null {
  try {
    return JSON.parse(result) as { command?: string; exitCode?: number | null };
  } catch {
    return null;
  }
}

export function normalizeModifiedPath(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath.split(path.sep).join(path.posix.sep);
  }

  const relativePath = path.relative(getWorkspaceRoot(), filePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return filePath;
  }

  return relativePath.split(path.sep).join(path.posix.sep);
}

export function getEffectiveDiffCount(
  task: BenchmarkTask,
  metrics: BenchmarkTaskMetrics,
): number {
  if (
    (task.category === "validate" || task.category === "auto_fix") &&
    metrics.modifiedFiles.length > 0
  ) {
    return metrics.modifiedFiles.length;
  }

  return metrics.diffs;
}

function onBenchmarkEvent(metrics: BenchmarkTaskMetrics) {
  return (event: AgentEvent) => {
    switch (event.type) {
      case "tool_call": {
        metrics.toolCalls += 1;
        if (event.name === "run_command") {
          const parsed = parseRunCommandArgs(event.args);
          if (
            typeof parsed?.command === "string" &&
            isValidationCommand(parsed.command)
          ) {
            metrics.validationRuns += 1;
          }
        }
        break;
      }
      case "auto_validate":
        metrics.validationRuns += 1;
        break;
      case "auto_fix":
        metrics.autoFixes += 1;
        break;
      case "file_modified": {
        metrics.diffs += 1;
        const normalizedPath = event.diff?.path
          ? normalizeModifiedPath(event.diff.path)
          : undefined;
        if (
          normalizedPath &&
          !metrics.modifiedFiles.includes(normalizedPath)
        ) {
          metrics.modifiedFiles.push(normalizedPath);
        }
        break;
      }
      case "tool_result": {
        if (event.name === "run_command") {
          const parsed = parseRunCommandResult(event.result);
          if (
            typeof parsed?.command === "string" &&
            isValidationCommand(parsed.command) &&
            typeof parsed.exitCode === "number" &&
            parsed.exitCode !== 0
          ) {
            metrics.validationPassed = false;
          }
        }
        break;
      }
      case "context_trimmed":
        metrics.contextTrimmed += event.removed;
        break;
    }
  };
}

function createAutoApproveHandler() {
  return async (_request: ApprovalRequest) => true;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function evaluatePrecondition(
  precondition: BenchmarkTaskPrecondition,
): Promise<string | null> {
  const targetPath = path.join(getWorkspaceRoot(), precondition.path);
  const content = await readFile(targetPath, "utf8");

  if (precondition.includes?.some((snippet) => !content.includes(snippet))) {
    return precondition.reason;
  }

  if (precondition.excludes?.some((snippet) => content.includes(snippet))) {
    return precondition.reason;
  }

  return null;
}

async function getPreconditionFailureReason(
  task: BenchmarkTask,
): Promise<string | null> {
  for (const precondition of task.preconditions || []) {
    const failureReason = await evaluatePrecondition(precondition);
    if (failureReason) {
      return failureReason;
    }
  }

  return null;
}

function createPassingExpectationChecks(): BenchmarkTaskResult["expectationChecks"] {
  return {
    finalTextIncludes: [],
    finalTextIncludesAny: [],
    minToolCallsMet: true,
    maxDiffsMet: true,
    maxValidationRunsMet: true,
    minValidationRunsMet: true,
    minAutoFixesMet: true,
    expectedModifiedFilesMissing: [],
    forbiddenModifiedFilesPresent: [],
    mustPassValidationMet: true,
  };
}

function inferRuntimeErrorFailureType(errorText: string): BenchmarkFailureType {
  return /api connection|connection error|eperm|enoent|eacces|network|fetcherror|listen|connect|pipe|module not found|cannot find module|vitest|@types\/node|node:/i.test(
    errorText,
  )
    ? "environment"
    : "agent";
}

function inferFailureType(
  _task: BenchmarkTask,
  finalText: string,
  expectationChecks: BenchmarkTaskResult["expectationChecks"],
): BenchmarkFailureType {
  if (expectationChecks.mustPassValidationMet === false) {
    return /依赖|环境|解析|module not found|cannot find module|enoent|vitest|@types\/node|node:/i.test(
      finalText,
    )
      ? "environment"
      : "agent";
  }

  if (
    expectationChecks.expectedModifiedFilesMissing.length > 0 ||
    expectationChecks.forbiddenModifiedFilesPresent.length > 0 ||
    expectationChecks.finalTextIncludes.length > 0 ||
    expectationChecks.finalTextIncludesAny.length > 0 ||
    !expectationChecks.minToolCallsMet ||
    !expectationChecks.maxDiffsMet ||
    !expectationChecks.maxValidationRunsMet ||
    !expectationChecks.minValidationRunsMet ||
    !expectationChecks.minAutoFixesMet
  ) {
    return "agent";
  }

  if (
    /依赖|环境|解析|module not found|cannot find module|enoent|vitest|@types\/node|node:/i.test(
      finalText,
    )
  ) {
    return "environment";
  }

  return "none";
}

function buildCategorySummary(
  results: BenchmarkTaskResult[],
): BenchmarkCategorySummary[] {
  const categories = [...new Set(results.map((result) => result.category))];
  return categories.map((category) => {
    const categoryResults = results.filter(
      (result) => result.category === category,
    );
    const executed = categoryResults.filter((result) => !result.skipped);
    const passed = executed.filter((result) => result.passed);
    return {
      category,
      total: categoryResults.length,
      executed: executed.length,
      skipped: categoryResults.filter((result) => result.skipped).length,
      passed: passed.length,
      successRate: round(
        executed.length === 0 ? 0 : passed.length / executed.length,
      ),
    };
  });
}

function buildSkipReasonSummary(
  results: BenchmarkTaskResult[],
): BenchmarkSkipReasonSummary[] {
  const map = new Map<string, { count: number; taskIds: string[] }>();
  for (const result of results) {
    if (!result.skipped || !result.skipReason) continue;
    const entry = map.get(result.skipReason) || { count: 0, taskIds: [] };
    entry.count += 1;
    entry.taskIds.push(result.id);
    map.set(result.skipReason, entry);
  }

  return [...map.entries()].map(([reason, value]) => ({
    reason,
    count: value.count,
    taskIds: value.taskIds,
  }));
}

function buildFailureSummary(
  results: BenchmarkTaskResult[],
): BenchmarkFailureSummary {
  return results.reduce<BenchmarkFailureSummary>(
    (acc, result) => {
      acc[result.failureType] += 1;
      return acc;
    },
    { none: 0, skip: 0, agent: 0, environment: 0 },
  );
}

function evaluateTask(
  task: BenchmarkTask,
  finalText: string,
  metrics: BenchmarkTaskMetrics,
): BenchmarkTaskResult["expectationChecks"] & { passed: boolean } {
  const normalizedFinalText = finalText.toLowerCase();
  const finalTextIncludes = (task.expectation.finalTextIncludes || []).filter(
    (keyword) => !normalizedFinalText.includes(keyword.toLowerCase()),
  );
  const finalTextIncludesAny = (
    task.expectation.finalTextIncludesAny || []
  ).filter(
    (keywords) =>
      !keywords.some((keyword) =>
        normalizedFinalText.includes(keyword.toLowerCase()),
      ),
  );
  const minToolCallsMet =
    metrics.toolCalls >= (task.expectation.minToolCalls || 0);
  const effectiveDiffCount = getEffectiveDiffCount(task, metrics);
  const maxDiffsMet =
    effectiveDiffCount <= (task.expectation.maxDiffs ?? Infinity);
  const maxValidationRunsMet =
    metrics.validationRuns <=
    (task.expectation.maxValidationRuns ?? Number.POSITIVE_INFINITY);
  const minValidationRunsMet =
    metrics.validationRuns >= (task.expectation.minValidationRuns || 0);
  const minAutoFixesMet =
    metrics.autoFixes >= (task.expectation.minAutoFixes || 0);
  const expectedModifiedFilesMissing = (
    task.expectation.expectedModifiedFiles || []
  ).filter((file) => !metrics.modifiedFiles.includes(file));
  const forbiddenModifiedFilesPresent = (
    task.expectation.forbiddenModifiedFiles || []
  ).filter((file) => metrics.modifiedFiles.includes(file));
  const mustPassValidationMet = task.expectation.mustPassValidation
    ? metrics.validationPassed
    : true;

  return {
    finalTextIncludes,
    finalTextIncludesAny,
    minToolCallsMet,
    maxDiffsMet,
    maxValidationRunsMet,
    minValidationRunsMet,
    minAutoFixesMet,
    expectedModifiedFilesMissing,
    forbiddenModifiedFilesPresent,
    mustPassValidationMet,
    passed:
      finalTextIncludes.length === 0 &&
      finalTextIncludesAny.length === 0 &&
      minToolCallsMet &&
      maxDiffsMet &&
      maxValidationRunsMet &&
      minValidationRunsMet &&
      minAutoFixesMet &&
      expectedModifiedFilesMissing.length === 0 &&
      forbiddenModifiedFilesPresent.length === 0 &&
      mustPassValidationMet,
  };
}

export async function runBenchmark(
  options?: BenchmarkRunOptions,
): Promise<BenchmarkReport> {
  const enabledTasks = benchmarkTasks.filter((task) => task.enabled !== false);
  const selectedTasks =
    options?.taskIds && options.taskIds.length > 0
      ? benchmarkTasks.filter((task) => options.taskIds?.includes(task.id))
      : options?.includeDisabled
        ? benchmarkTasks
        : enabledTasks;

  if (selectedTasks.length === 0) {
    throw new Error("没有匹配的 benchmark 任务");
  }

  const results: BenchmarkTaskResult[] = [];
  for (const task of selectedTasks) {
    const isolation = await prepareBenchmarkIsolation(task, options?.isolation);
    try {
      await withBenchmarkWorkspace(isolation.workspacePath, async () => {
        const preconditionFailureReason = await getPreconditionFailureReason(task);
        if (preconditionFailureReason) {
          results.push({
            id: task.id,
            title: task.title,
            category: task.category,
            prompt: task.prompt,
            passed: false,
            skipped: true,
            skipReason: preconditionFailureReason,
            failureType: "skip",
            durationMs: 0,
            finalText: preconditionFailureReason,
            stepsCount: 0,
            metrics: createMetrics(),
            expectationChecks: {
              finalTextIncludes: [],
              finalTextIncludesAny: [],
              minToolCallsMet: true,
              maxDiffsMet: true,
              maxValidationRunsMet: true,
              minValidationRunsMet: true,
              minAutoFixesMet: true,
              expectedModifiedFilesMissing: [],
              forbiddenModifiedFilesPresent: [],
              mustPassValidationMet: true,
            },
          });
          return;
        }

        const metrics = createMetrics();
        const agent = new AgentOrchestrator({
          onEvent: onBenchmarkEvent(metrics),
          onConfirmCommand: createAutoApproveHandler(),
        });

        try {
          const start = performance.now();
          const result = await agent.run(task.prompt);
          const durationMs = performance.now() - start;
          const expectationChecks = evaluateTask(task, result.finalText, metrics);

          const failureType = expectationChecks.passed
            ? "none"
            : inferFailureType(task, result.finalText, expectationChecks);

          results.push({
            id: task.id,
            title: task.title,
            category: task.category,
            prompt: task.prompt,
            passed: expectationChecks.passed,
            failureType,
            durationMs: round(durationMs),
            finalText: result.finalText,
            stepsCount: result.steps.length,
            metrics: { ...metrics },
            expectationChecks: {
              finalTextIncludes: expectationChecks.finalTextIncludes,
              finalTextIncludesAny: expectationChecks.finalTextIncludesAny,
              minToolCallsMet: expectationChecks.minToolCallsMet,
              maxDiffsMet: expectationChecks.maxDiffsMet,
              maxValidationRunsMet: expectationChecks.maxValidationRunsMet,
              minValidationRunsMet: expectationChecks.minValidationRunsMet,
              minAutoFixesMet: expectationChecks.minAutoFixesMet,
              expectedModifiedFilesMissing:
                expectationChecks.expectedModifiedFilesMissing,
              forbiddenModifiedFilesPresent:
                expectationChecks.forbiddenModifiedFilesPresent,
              mustPassValidationMet: expectationChecks.mustPassValidationMet,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            id: task.id,
            title: task.title,
            category: task.category,
            prompt: task.prompt,
            passed: false,
            failureType: inferRuntimeErrorFailureType(message),
            durationMs: 0,
            finalText: message,
            stepsCount: 0,
            metrics: { ...metrics },
            expectationChecks: createPassingExpectationChecks(),
          });
        }
      });
    } finally {
      await isolation.cleanup();
    }
  }

  const executedResults = results.filter((result) => !result.skipped);
  const passedResults = executedResults.filter((result) => result.passed);

  const summary: BenchmarkSummary = {
    total: results.length,
    executed: executedResults.length,
    skipped: results.filter((result) => result.skipped).length,
    passed: passedResults.length,
    successRate: round(
      executedResults.length === 0
        ? 0
        : passedResults.length / executedResults.length,
    ),
    avgDurationMs: round(
      average(executedResults.map((result) => result.durationMs)),
    ),
    avgSteps: round(
      average(executedResults.map((result) => result.stepsCount)),
    ),
    avgToolCalls: round(
      average(executedResults.map((result) => result.metrics.toolCalls)),
    ),
    avgValidationRuns: round(
      average(executedResults.map((result) => result.metrics.validationRuns)),
    ),
    avgAutoFixes: round(
      average(executedResults.map((result) => result.metrics.autoFixes)),
    ),
    avgContextTrimmed: round(
      average(executedResults.map((result) => result.metrics.contextTrimmed)),
    ),
    byCategory: buildCategorySummary(results),
    skipReasons: buildSkipReasonSummary(results),
    failures: buildFailureSummary(results),
  };

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    summary,
    tasks: results,
  };

  const outputPath = resolveBenchmarkReportPath(options?.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  return report;
}
