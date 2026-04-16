import chalk from "chalk";
import { runBenchmark } from "../benchmark/index.js";
import { benchmarkTasks } from "../benchmark/tasks.js";

export async function runBenchmarkCommand(options: {
  taskIds?: string[];
  output?: string;
  list?: boolean;
  json?: boolean;
  includeDisabled?: boolean;
  isolationMode?: "in_place" | "temp_copy";
  keepIsolatedWorkspace?: boolean;
}) {
  if (options.list) {
    console.log();
    console.log(chalk.cyan.bold("  可用 benchmark 任务:"));
    for (const task of benchmarkTasks) {
      console.log(
        chalk.yellow(`  - ${task.id}`) +
          chalk.gray(
            ` (${task.category}${task.enabled === false ? ", disabled" : ""}) ${task.title}`,
          ),
      );
      console.log(chalk.gray(`    ${task.description}`));
    }
    console.log();
    return;
  }

  const report = await runBenchmark({
    taskIds: options.taskIds,
    outputPath: options.output,
    includeDisabled: Boolean(options.includeDisabled),
    isolation: {
      mode: options.isolationMode || "in_place",
      cleanup: !options.keepIsolatedWorkspace,
    },
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(chalk.cyan.bold("  Benchmark 摘要"));
  console.log(chalk.gray(`  生成时间: ${report.generatedAt}`));
  console.log(
    chalk.white(
      `  通过率: ${report.summary.passed}/${report.summary.executed} (${(report.summary.successRate * 100).toFixed(1)}%)`,
    ),
  );
  console.log(chalk.gray(`  总任务数: ${report.summary.total}`));
  console.log(chalk.gray(`  实际执行: ${report.summary.executed}`));
  console.log(chalk.gray(`  跳过任务: ${report.summary.skipped}`));
  console.log(chalk.gray(`  平均耗时: ${report.summary.avgDurationMs} ms`));
  console.log(chalk.gray(`  平均步骤数: ${report.summary.avgSteps}`));
  console.log(chalk.gray(`  平均工具调用: ${report.summary.avgToolCalls}`));
  console.log(
    chalk.gray(`  平均验证次数: ${report.summary.avgValidationRuns}`),
  );
  console.log(chalk.gray(`  平均自动修复次数: ${report.summary.avgAutoFixes}`));
  console.log(
    chalk.gray(`  平均上下文裁剪量: ${report.summary.avgContextTrimmed}`),
  );
  console.log(
    chalk.gray(
      `  失败统计: agent=${report.summary.failures.agent}, environment=${report.summary.failures.environment}, skip=${report.summary.failures.skip}`,
    ),
  );
  console.log();

  if (report.summary.byCategory.length > 0) {
    console.log(chalk.cyan.bold("  按任务类别统计"));
    for (const item of report.summary.byCategory) {
      console.log(
        chalk.gray(
          `  - ${item.category}: ${item.passed}/${item.executed} passed, skipped=${item.skipped}, total=${item.total}, success=${(item.successRate * 100).toFixed(1)}%`,
        ),
      );
    }
    console.log();
  }

  if (report.summary.skipReasons.length > 0) {
    console.log(chalk.cyan.bold("  跳过原因汇总"));
    for (const item of report.summary.skipReasons) {
      console.log(chalk.gray(`  - ${item.count} 次: ${item.reason}`));
      console.log(chalk.gray(`    tasks: ${item.taskIds.join(", ")}`));
    }
    console.log();
  }

  console.log(chalk.cyan.bold("  任务详情"));
  for (const task of report.tasks) {
    const status = task.skipped
      ? chalk.yellow("SKIP")
      : task.passed
        ? chalk.green("PASS")
        : chalk.red("FAIL");
    console.log(
      `${status} ${chalk.yellow(task.id)} ${chalk.gray(`(${task.durationMs} ms, tools=${task.metrics.toolCalls}, steps=${task.stepsCount})`)}`,
    );
    if (task.skipped) {
      console.log(chalk.gray(`    - 前置条件不满足: ${task.skipReason}`));
      continue;
    }
    if (!task.passed) {
      console.log(chalk.gray(`    - failureType: ${task.failureType}`));
      const failureReasons: string[] = [];
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
        console.log(chalk.gray(`    - ${reason}`));
      }
    }
  }
  console.log();
}
