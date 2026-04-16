import chalk from "chalk";
import {
  type CommandAuditAction,
  type CommandAuditDecision,
  type CommandAuditEntry,
  type CommandAuditKind,
  type CommandAuditSource,
  readCommandAuditEntries,
} from "../utils/command-audit.js";

export type ApprovalLogFilters = {
  contains?: string;
  decision?: CommandAuditDecision;
  source?: CommandAuditSource;
  kind?: CommandAuditKind;
  action?: CommandAuditAction;
  path?: string;
  after?: string;
  before?: string;
  limit?: number;
};

export type ApprovalLogPrintOptions = {
  json?: boolean;
  stats?: boolean;
};

export type ParsedApprovalLogQuery = {
  filters: ApprovalLogFilters;
  options: ApprovalLogPrintOptions;
};

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

function formatDecision(decision: CommandAuditEntry["decision"]): string {
  if (decision === "approved") {
    return chalk.green(decision.toUpperCase());
  }
  if (decision === "blocked") {
    return chalk.red(decision.toUpperCase());
  }
  return chalk.yellow(decision.toUpperCase());
}

function formatKind(kind: CommandAuditEntry["kind"]): string {
  if (kind === "external_file") {
    return "外部文件";
  }
  if (kind === "external_path") {
    return "外部路径";
  }
  return "命令";
}

function formatAction(action: CommandAuditEntry["action"]): string {
  if (action === "import") return "打开文档";
  if (action === "list") return "列目录";
  if (action === "read") return "读取";
  if (action === "search") return "搜索";
  if (action === "write") return "修改";
  return "执行";
}

function incrementCount(map: Map<string, number>, key: string | undefined) {
  if (!key) {
    return;
  }
  map.set(key, (map.get(key) || 0) + 1);
}

function renderCountMap(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}:${value}`)
    .join("  ");
}

function printApprovalStats(entries: CommandAuditEntry[]) {
  const decisions = new Map<string, number>();
  const kinds = new Map<string, number>();
  const actions = new Map<string, number>();

  for (const entry of entries) {
    incrementCount(decisions, entry.decision);
    incrementCount(kinds, entry.kind);
    incrementCount(actions, entry.action);
  }

  console.log(chalk.gray(`  共 ${entries.length} 条记录`));
  if (decisions.size > 0) {
    console.log(chalk.gray(`  结果: ${renderCountMap(decisions)}`));
  }
  if (kinds.size > 0) {
    console.log(chalk.gray(`  类别: ${renderCountMap(kinds)}`));
  }
  if (actions.size > 0) {
    console.log(chalk.gray(`  操作: ${renderCountMap(actions)}`));
  }
}

function splitQueryTokens(input: string): string[] {
  return input.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function unquoteToken(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export function parseApprovalLogQueryText(
  input: string,
): ParsedApprovalLogQuery {
  const filters: ApprovalLogFilters = {};
  const options: ApprovalLogPrintOptions = {};
  const containsParts: string[] = [];

  for (const rawToken of splitQueryTokens(input.trim())) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }
    if (token === "stats") {
      options.stats = true;
      continue;
    }
    if (token === "json") {
      options.json = true;
      continue;
    }

    const separatorIndex = token.indexOf(":");
    if (separatorIndex <= 0) {
      containsParts.push(unquoteToken(token));
      continue;
    }

    const key = token.slice(0, separatorIndex).toLowerCase();
    const value = unquoteToken(token.slice(separatorIndex + 1)).trim();
    if (!value) {
      continue;
    }

    if (key === "decision") {
      filters.decision = value as ApprovalLogFilters["decision"];
      continue;
    }
    if (key === "source") {
      filters.source = value as ApprovalLogFilters["source"];
      continue;
    }
    if (key === "kind") {
      filters.kind = value as ApprovalLogFilters["kind"];
      continue;
    }
    if (key === "action") {
      filters.action = value as ApprovalLogFilters["action"];
      continue;
    }
    if (key === "path") {
      filters.path = value;
      continue;
    }
    if (key === "after") {
      filters.after = value;
      continue;
    }
    if (key === "before") {
      filters.before = value;
      continue;
    }
    if (key === "limit") {
      const parsedLimit = Number.parseInt(value, 10);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        filters.limit = parsedLimit;
      }
      continue;
    }
    if (key === "contains") {
      containsParts.push(value);
      continue;
    }

    containsParts.push(unquoteToken(token));
  }

  if (containsParts.length > 0) {
    filters.contains = containsParts.join(" ");
  }

  return { filters, options };
}

export async function printApprovalLog(
  filters: ApprovalLogFilters,
  options?: ApprovalLogPrintOptions,
): Promise<void> {
  const entries = await readCommandAuditEntries(filters);

  if (options?.json) {
    if (options.stats) {
      console.log(JSON.stringify({ total: entries.length, entries }, null, 2));
      return;
    }
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log();
  console.log(chalk.cyan("═══ 命令审批记录 ═══"));

  if (entries.length === 0) {
    console.log(chalk.gray("暂无匹配的审批记录。"));
    console.log();
    return;
  }

  if (options?.stats) {
    printApprovalStats(entries);
    console.log();
  }

  for (const entry of entries) {
    console.log(
      `  ${formatDecision(entry.decision)} ${chalk.gray(formatTimestamp(entry.timestamp))} ${chalk.magenta(`[${entry.source}]`)} ${chalk.cyan(`[${formatKind(entry.kind)}/${formatAction(entry.action)}]`)}`,
    );
    console.log(chalk.white(`    ${entry.command}`));
    if (entry.targetPath) {
      console.log(chalk.gray(`    路径: ${entry.targetPath}`));
    }
    console.log(chalk.gray(`    原因: ${entry.reason}`));
  }

  console.log();
}
