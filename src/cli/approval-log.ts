import {
  type CommandAuditAction,
  type CommandAuditDecision,
  type CommandAuditEntry,
  type CommandAuditKind,
  type CommandAuditSource,
  readCommandAuditEntries,
} from "../utils/command-audit.js";
import { logCardList, logDetailEntries, logEmptyState, logRenderedText, logSection } from "../utils/logger.js";

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
  page?: number;
  sort?: "newest" | "oldest";
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
  return `**${decision.toUpperCase()}**`;
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

  logRenderedText(
    `| 统计项 | 值 |\n| --- | --- |\n| 总记录数 | ${entries.length} |\n| 结果 | ${renderCountMap(decisions) || "-"} |\n| 类别 | ${renderCountMap(kinds) || "-"} |\n| 操作 | ${renderCountMap(actions) || "-"} |`,
  );
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
    if (key === "page") {
      const parsedPage = Number.parseInt(value, 10);
      if (Number.isFinite(parsedPage) && parsedPage > 0) {
        filters.page = parsedPage;
      }
      continue;
    }
    if (key === "sort") {
      filters.sort = value === "oldest" ? "oldest" : "newest";
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

function compressText(text: string, maxLength = 88): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

export async function printApprovalLog(
  filters: ApprovalLogFilters,
  options?: ApprovalLogPrintOptions,
): Promise<void> {
  const allEntries = await readCommandAuditEntries({
    ...filters,
    limit: undefined,
  });
  const sortedEntries =
    filters.sort === "oldest" ? [...allEntries].reverse() : allEntries;
  const page = Math.max(1, filters.page || 1);
  const pageSize = Math.max(1, filters.limit || 20);
  const startIndex = (page - 1) * pageSize;
  const entries = sortedEntries.slice(startIndex, startIndex + pageSize);

  if (options?.json) {
    if (options.stats) {
      console.log(JSON.stringify({ total: allEntries.length, page, pageSize, entries }, null, 2));
      return;
    }
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  logSection("命令审批记录");

  if (entries.length === 0) {
    logEmptyState("暂无匹配的审批记录。");
    console.log();
    return;
  }

  if (options?.stats) {
    printApprovalStats(allEntries);
    console.log();
  }

  logDetailEntries(
    [
      { label: "排序", value: filters.sort === "oldest" ? "最早优先" : "最新优先" },
      { label: "页码", value: `${page}/${Math.max(1, Math.ceil(allEntries.length / pageSize))}` },
      { label: "每页条数", value: String(pageSize) },
      { label: "匹配总数", value: String(allEntries.length) },
    ],
  );

  for (const entry of entries) {
    logCardList("审批项", [
      `${formatDecision(entry.decision)} ${compressText(entry.command, 96)}`,
    ]);
    logDetailEntries(
      [
        { label: "时间", value: formatTimestamp(entry.timestamp) },
        { label: "来源", value: entry.source },
        { label: "类别", value: `${formatKind(entry.kind)} / ${formatAction(entry.action)}` },
        ...(entry.targetPath ? [{ label: "路径", value: entry.targetPath }] : []),
        { label: "原因", value: compressText(entry.reason, 120) },
      ],
      "    ",
    );
  }

  console.log();
}
