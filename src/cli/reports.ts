import {
  getRunReportMarkdownPath,
  listRunReports,
  readRunReport,
} from "../agent/report.js";
import {
  logCardList,
  logDetailEntries,
  logEmptyState,
  logKeyValue,
  logSection,
} from "../utils/logger.js";

function formatReportLine(
  report: Awaited<ReturnType<typeof listRunReports>>[number],
) {
  return `**${report.id}** · ${report.status} · ${report.task} · ${report.durationMs}ms`;
}

export async function printRunReports(options?: {
  id?: string;
  limit?: number;
  json?: boolean;
}) {
  if (options?.id) {
    const report = await readRunReport(options.id);
    if (!report) throw new Error(`未找到运行报告: ${options.id}`);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    logSection("运行报告详情");
    logKeyValue("ID", report.id);
    logKeyValue("任务", report.task);
    logKeyValue("状态", report.status);
    logKeyValue("耗时", `${report.durationMs}ms`);
    logKeyValue("Markdown", getRunReportMarkdownPath(report.id));
    logCardList(
      "修改文件",
      report.modifiedFiles.length ? report.modifiedFiles : ["无"],
    );
    logCardList(
      "验证命令",
      report.validationCommands.length ? report.validationCommands : ["无"],
    );
    logCardList(
      "工具调用",
      report.toolCalls.map((call) => `${call.name} ${call.args}`).slice(0, 20),
      { emptyText: "无工具调用。" },
    );
    console.log();
    return;
  }

  const reports = await listRunReports(options?.limit || 10);
  if (options?.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  logSection("运行报告列表");
  if (reports.length === 0) {
    logEmptyState("当前没有运行报告。每次 agent run 完成后会自动生成。 ");
    console.log();
    return;
  }
  logDetailEntries([{ label: "数量", value: String(reports.length) }]);
  logCardList("最近报告", reports.map(formatReportLine));
  console.log();
}
