import { promises as fs } from "node:fs";
import path from "node:path";
import { getWorkspaceStateDir } from "./runtime.js";

export type CommandAuditDecision = "approved" | "rejected" | "blocked";
export type CommandAuditSource = "tool" | "auto_validate" | "policy";
export type CommandAuditKind = "command" | "external_file" | "external_path";
export type CommandAuditAction =
  | "run"
  | "import"
  | "list"
  | "read"
  | "search"
  | "write";

export type CommandAuditEntry = {
  timestamp: string;
  command: string;
  reason: string;
  decision: CommandAuditDecision;
  source: CommandAuditSource;
  kind?: CommandAuditKind;
  action?: CommandAuditAction;
  targetPath?: string;
};

export type CommandAuditQuery = {
  decision?: CommandAuditDecision;
  source?: CommandAuditSource;
  contains?: string;
  kind?: CommandAuditKind;
  action?: CommandAuditAction;
  path?: string;
  after?: string;
  before?: string;
  limit?: number;
};

const DEFAULT_AUDIT_LOG_PATH = path.join(
  getWorkspaceStateDir(),
  "command-approvals.ndjson",
);

export function getAuditLogPath(): string {
  return process.env.RUN_COMMAND_AUDIT_LOG_PATH || DEFAULT_AUDIT_LOG_PATH;
}

export async function appendCommandAudit(
  entry: CommandAuditEntry,
): Promise<void> {
  const logPath = getAuditLogPath();
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(
    logPath,
    `${JSON.stringify(enrichAuditEntry(entry))}\n`,
    "utf8",
  );
}

function isCommandAuditDecision(value: unknown): value is CommandAuditDecision {
  return value === "approved" || value === "rejected" || value === "blocked";
}

function isCommandAuditSource(value: unknown): value is CommandAuditSource {
  return value === "tool" || value === "auto_validate" || value === "policy";
}

function isCommandAuditKind(value: unknown): value is CommandAuditKind {
  return (
    value === "command" ||
    value === "external_file" ||
    value === "external_path"
  );
}

function isCommandAuditAction(value: unknown): value is CommandAuditAction {
  return (
    value === "run" ||
    value === "import" ||
    value === "list" ||
    value === "read" ||
    value === "search" ||
    value === "write"
  );
}

function isCommandAuditEntry(value: unknown): value is CommandAuditEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<CommandAuditEntry>;
  return (
    typeof entry.timestamp === "string" &&
    typeof entry.command === "string" &&
    typeof entry.reason === "string" &&
    isCommandAuditDecision(entry.decision) &&
    isCommandAuditSource(entry.source) &&
    (entry.kind === undefined || isCommandAuditKind(entry.kind)) &&
    (entry.action === undefined || isCommandAuditAction(entry.action)) &&
    (entry.targetPath === undefined || typeof entry.targetPath === "string")
  );
}

function parseAuditTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFileAccessCommand(
  command: string,
): Pick<CommandAuditEntry, "kind" | "action" | "targetPath"> {
  const remainder = command.slice("file_access ".length).trim();
  const firstSpace = remainder.indexOf(" ");
  const toolName = firstSpace >= 0 ? remainder.slice(0, firstSpace) : remainder;
  const targetPath =
    firstSpace >= 0 ? remainder.slice(firstSpace + 1).trim() : undefined;

  const action =
    toolName === "list_files" ||
    toolName === "tree_files" ||
    toolName === "glob_files"
      ? "list"
      : toolName === "read_file" || toolName === "inspect_file"
        ? "read"
        : toolName === "search_text"
          ? "search"
          : toolName === "write_file" ||
              toolName === "append_text" ||
              toolName === "insert_after" ||
              toolName === "replace_range" ||
              toolName === "replace_text" ||
              toolName === "create_file"
            ? "write"
            : undefined;

  return {
    kind: "external_path",
    action,
    targetPath: targetPath || undefined,
  };
}

function deriveAuditMetadata(
  command: string,
): Pick<CommandAuditEntry, "kind" | "action" | "targetPath"> {
  if (command.startsWith("import_external_file ")) {
    const remainder = command.slice("import_external_file ".length);
    const [targetPath] = remainder.split(" -> ", 1);
    return {
      kind: "external_file",
      action: "import",
      targetPath: targetPath?.trim() || undefined,
    };
  }

  if (command.startsWith("file_access ")) {
    return parseFileAccessCommand(command);
  }

  return { kind: "command", action: "run" };
}

function enrichAuditEntry(entry: CommandAuditEntry): CommandAuditEntry {
  const derived = deriveAuditMetadata(entry.command);
  return {
    ...derived,
    ...entry,
    kind: entry.kind || derived.kind,
    action: entry.action || derived.action,
    targetPath: entry.targetPath || derived.targetPath,
  };
}

function parseRelativeTimeFilter(value: string): number | null {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)(m|h|d|w)$/);
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multiplier =
    unit === "m"
      ? 60_000
      : unit === "h"
        ? 3_600_000
        : unit === "d"
          ? 86_400_000
          : 604_800_000;
  return Date.now() - amount * multiplier;
}

function resolveTimeFilter(
  value: string | undefined,
  label: string,
): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const relative = parseRelativeTimeFilter(value);
  if (relative !== null) {
    return relative;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`无效的 ${label} 时间过滤条件: ${value}`);
  }

  return parsed;
}

export async function readCommandAuditEntries(
  query: CommandAuditQuery = {},
): Promise<CommandAuditEntry[]> {
  let content = "";
  try {
    content = await fs.readFile(getAuditLogPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const contains = query.contains?.trim().toLowerCase();
  const pathFilter = query.path?.trim().toLowerCase();
  const after = resolveTimeFilter(query.after, "after");
  const before = resolveTimeFilter(query.before, "before");
  const entries = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isCommandAuditEntry(parsed) ? [enrichAuditEntry(parsed)] : [];
      } catch {
        return [];
      }
    })
    .filter((entry) => {
      const timestamp = parseAuditTimestamp(entry.timestamp);
      if (query.decision && entry.decision !== query.decision) {
        return false;
      }
      if (query.source && entry.source !== query.source) {
        return false;
      }
      if (query.kind && entry.kind !== query.kind) {
        return false;
      }
      if (query.action && entry.action !== query.action) {
        return false;
      }
      if (after !== undefined && timestamp < after) {
        return false;
      }
      if (before !== undefined && timestamp > before) {
        return false;
      }
      if (
        pathFilter &&
        !(entry.targetPath || "").toLowerCase().includes(pathFilter)
      ) {
        return false;
      }
      if (!contains) {
        return true;
      }

      const haystack =
        `${entry.command}\n${entry.reason}\n${entry.source}\n${entry.kind || ""}\n${entry.action || ""}\n${entry.targetPath || ""}`.toLowerCase();
      return haystack.includes(contains);
    })
    .sort(
      (a, b) =>
        parseAuditTimestamp(b.timestamp) - parseAuditTimestamp(a.timestamp),
    );

  if (query.limit !== undefined) {
    return entries.slice(0, Math.max(0, query.limit));
  }

  return entries;
}
