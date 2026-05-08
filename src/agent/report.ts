import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiffEntry } from "../types/agent.js";
import { getWorkspaceStateDir } from "../utils/runtime.js";

export type RunReportToolCall = {
  name: string;
  args: string;
  result?: string;
};

export type RunReport = {
  id: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "completed" | "blocked" | "failed";
  workspace: string;
  toolCalls: RunReportToolCall[];
  approvals: {
    allowed: string[];
    rejected: string[];
  };
  modifiedFiles: string[];
  validationCommands: string[];
  autoFixRounds: number;
  finalText: string;
  steps: string[];
  diffs: DiffEntry[];
};

export type RunReportSummary = Pick<
  RunReport,
  "id" | "task" | "startedAt" | "finishedAt" | "durationMs" | "status"
> & {
  toolCallCount: number;
  modifiedFileCount: number;
  validationCommandCount: number;
};

function getReportsDir(): string {
  return path.join(getWorkspaceStateDir(), "reports");
}

function getReportJsonPath(id: string): string {
  return path.join(getReportsDir(), `${id}.json`);
}

function getReportMarkdownPath(id: string): string {
  return path.join(getReportsDir(), `${id}.md`);
}

function formatMarkdownList(items: string[]): string {
  return items.length > 0
    ? items.map((item) => `- ${item}`).join("\n")
    : "- 无";
}

function renderRunReportMarkdown(report: RunReport): string {
  return [
    `# Run Report ${report.id}`,
    "",
    `- Task: ${report.task}`,
    `- Status: ${report.status}`,
    `- Workspace: ${report.workspace}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Duration: ${report.durationMs}ms`,
    `- Tool calls: ${report.toolCalls.length}`,
    `- Auto fix rounds: ${report.autoFixRounds}`,
    "",
    "## Modified files",
    formatMarkdownList(report.modifiedFiles),
    "",
    "## Validation commands",
    formatMarkdownList(report.validationCommands),
    "",
    "## Approvals allowed",
    formatMarkdownList(report.approvals.allowed),
    "",
    "## Approvals rejected",
    formatMarkdownList(report.approvals.rejected),
    "",
    "## Tool calls",
    formatMarkdownList(
      report.toolCalls.map((call) =>
        call.result
          ? `${call.name} ${call.args} -> ${call.result}`
          : `${call.name} ${call.args}`,
      ),
    ),
    "",
    "## Final text",
    report.finalText || "(empty)",
    "",
  ].join("\n");
}

export async function writeRunReport(report: RunReport): Promise<void> {
  await fs.mkdir(getReportsDir(), { recursive: true });
  await fs.writeFile(
    getReportJsonPath(report.id),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  await fs.writeFile(
    getReportMarkdownPath(report.id),
    renderRunReportMarkdown(report),
    "utf8",
  );
}

export async function listRunReports(limit = 10): Promise<RunReportSummary[]> {
  try {
    const files = await fs.readdir(getReportsDir());
    const jsonFiles = files.filter((file) => file.endsWith(".json"));
    const reports = await Promise.all(
      jsonFiles.map(async (file) => {
        const report = JSON.parse(
          await fs.readFile(path.join(getReportsDir(), file), "utf8"),
        ) as RunReport;
        return {
          id: report.id,
          task: report.task,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          durationMs: report.durationMs,
          status: report.status,
          toolCallCount: report.toolCalls.length,
          modifiedFileCount: report.modifiedFiles.length,
          validationCommandCount: report.validationCommands.length,
        } satisfies RunReportSummary;
      }),
    );
    return reports
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

export async function readRunReport(id: string): Promise<RunReport | null> {
  try {
    return JSON.parse(
      await fs.readFile(getReportJsonPath(id), "utf8"),
    ) as RunReport;
  } catch {
    return null;
  }
}

export function createRunReportId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function getRunReportMarkdownPath(id: string): string {
  return getReportMarkdownPath(id);
}
