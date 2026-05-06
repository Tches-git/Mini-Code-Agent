import { runBenchmark } from "../benchmark/index.js";
import { benchmarkTasks } from "../benchmark/tasks.js";
import {
  logKeyValue,
  logListItem,
  logRenderedText,
  logSection,
  logStatusLine,
} from "../utils/logger.js";

export async function runBenchmarkCommand(options: {
  taskIds?: string[];
  output?: string;
  list?: boolean;
  json?: boolean;
  includeDisabled?: boolean;
  isolationMode?: "in_place" | "temp_copy";
  keepIsolatedWorkspace?: boolean;
  mock?: boolean;
  environmentSoftFail?: boolean;
}) {
  if (options.list) {
    logSection("可用 benchmark 任务");
    for (const task of benchmarkTasks) {
      logListItem(
        `**${task.id}** (${task.category}${task.enabled === false ? ", disabled" : ""})`,
      );
      logKeyValue("标题", task.title);
      logKeyValue("说明", task.description);
    }
    console.log();
    return;
  }

  const report = await runBenchmark({
    taskIds: options.taskIds,
    outputPath: options.output,
    includeDisabled: Boolean(options.includeDisabled),
    isolation: {
      mode: options.isolationMode || "temp_copy",
      cleanup: !options.keepIsolatedWorkspace,
    },
    mock: Boolean(options.mock),
    environmentSoftFail: Boolean(options.environmentSoftFail),
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  logSection(options.mock ? "Benchmark 摘要（mock 模式）" : "Benchmark 摘要");
  if (options.environmentSoftFail) {
    logListItem("环境失败软处理已启用：provider/env 失败会记录但不阻塞门禁");
  }
  logRenderedText(
    `
| 字段 | 值 |
| --- | --- |
| 生成时间 | ${report.generatedAt} |
| 通过率 | ${report.summary.passed}/${report.summary.executed} (${(report.summary.successRate * 100).toFixed(1)}%) |
| 总任务数 | ${report.summary.total} |
| 实际执行 | ${report.summary.executed} |
| 跳过任务 | ${report.summary.skipped} |
| 平均耗时 | ${report.summary.avgDurationMs} ms |
| 平均步骤数 | ${report.summary.avgSteps} |
| 平均工具调用 | ${report.summary.avgToolCalls} |
| 平均验证次数 | ${report.summary.avgValidationRuns} |
| 平均自动修复次数 | ${report.summary.avgAutoFixes} |
| 平均上下文裁剪量 | ${report.summary.avgContextTrimmed} |
| 失败统计 | agent=${report.summary.failures.agent}, environment=${report.summary.failures.environment}, skip=${report.summary.failures.skip} |
| 趋势 | ${report.summary.trend ? `${report.summary.trend.successRateDelta || 0}` : "无历史基线"} |
`.trim(),
  );
  console.log();

  if (report.summary.byCategory.length > 0) {
    logSection("按任务类别统计");
    logRenderedText(
      [
        "| 类别 | 通过/执行 | 跳过 | 总数 | 成功率 |",
        "| --- | --- | --- | --- | --- |",
        ...report.summary.byCategory.map(
          (item) =>
            `| ${item.category} | ${item.passed}/${item.executed} | ${item.skipped} | ${item.total} | ${(item.successRate * 100).toFixed(1)}% |`,
        ),
      ].join("\n"),
    );
    console.log();
  }

  if (report.summary.slowestTasks.length > 0) {
    logSection("耗时 Top 任务");
    logRenderedText(
      [
        "| 任务 | 耗时 | 工具调用 | 类型 |",
        "| --- | --- | --- | --- |",
        ...report.summary.slowestTasks.map(
          (item) =>
            `| ${item.id} | ${item.durationMs} ms | ${item.toolCalls} | ${item.failureType} |`,
        ),
      ].join("\n"),
    );
    console.log();
  }

  if (report.summary.releaseChecklist.length > 0) {
    logSection("Release Checklist");
    for (const item of report.summary.releaseChecklist) {
      logStatusLine(item.ok ? "PASS" : "FAIL", item.label);
      logListItem(item.detail, "    ");
    }
    console.log();
  }

  if (report.summary.skipReasons.length > 0) {
    logSection("跳过原因汇总");
    for (const item of report.summary.skipReasons) {
      logRenderedText(
        `- ${item.count} 次：${item.reason}\n- tasks: ${item.taskIds.join(", ")}`,
      );
    }
    console.log();
  }

  logSection("任务详情");
  for (const task of report.tasks) {
    const status = task.skipped ? "SKIP" : task.passed ? "PASS" : "FAIL";
    logStatusLine(
      status,
      `${task.id} · ${task.durationMs} ms · tools=${task.metrics.toolCalls} · steps=${task.stepsCount}`,
    );
    if (task.skipped) {
      logListItem(`前置条件不满足: ${task.skipReason}`, "    ");
      continue;
    }
    if (!task.passed) {
      const failureReasons: string[] = [`failureType: ${task.failureType}`];
      if (task.expectationChecks.finalTextIncludes.length > 0) {
        failureReasons.push(
          `缺少关键词: ${task.expectationChecks.finalTextIncludes.join(", ")}`,
        );
      }
      if (!task.expectationChecks.minToolCallsMet) {
        failureReasons.push("工具调用次数不足");
      }
      if (!task.expectationChecks.maxDiffsMet) {
        failureReasons.push("出现了不期望的文件修改");
      }
      if (!task.expectationChecks.maxValidationRunsMet) {
        failureReasons.push("验证次数超出预期");
      }
      if (!task.expectationChecks.minValidationRunsMet) {
        failureReasons.push("验证次数少于预期");
      }
      if (!task.expectationChecks.minAutoFixesMet) {
        failureReasons.push("自动修复次数少于预期");
      }
      if (task.expectationChecks.expectedModifiedFilesMissing.length > 0) {
        failureReasons.push(
          `缺少目标修改文件: ${task.expectationChecks.expectedModifiedFilesMissing.join(", ")}`,
        );
      }
      if (task.expectationChecks.forbiddenModifiedFilesPresent.length > 0) {
        failureReasons.push(
          `出现禁止修改文件: ${task.expectationChecks.forbiddenModifiedFilesPresent.join(", ")}`,
        );
      }
      if (!task.expectationChecks.mustPassValidationMet) {
        failureReasons.push("验证结果未通过预期");
      }
      for (const reason of failureReasons) {
        logListItem(reason, "    ");
      }
    }
  }
  console.log();
}
