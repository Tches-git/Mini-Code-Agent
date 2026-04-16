import path from "node:path";
import type { ChatMessage } from "../types/agent.js";
import { normalizeFilePath } from "../utils/path.js";
import { isSummaryMessage } from "../utils/token.js";

export type SummaryFocus = {
  files: string[];
  keywords: string[];
};

const MAX_FOCUS_FILES = 12;
const MAX_FOCUS_KEYWORDS = 24;
const MAX_SUMMARY_LINE_LENGTH = 160;
const ASCII_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "into",
  "read",
  "show",
  "that",
  "the",
  "this",
  "with",
  "继续",
  "完善",
  "当前",
  "项目",
  "代码",
  "文件",
  "任务",
  "执行",
]);

function uniqueRecent(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]?.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.unshift(value);
  }

  return deduped.slice(-limit);
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function summarizeText(
  text: string,
  maxLength = MAX_SUMMARY_LINE_LENGTH,
): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function extractKeywords(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) || [];
  return uniqueRecent(
    matches.filter(
      (match) => !ASCII_STOP_WORDS.has(match) && !/^\d+$/.test(match),
    ),
    MAX_FOCUS_KEYWORDS,
  );
}

function deriveFocusFromPath(filePath: string): SummaryFocus {
  const normalized = normalizeFilePath(filePath);
  const basename = path.basename(normalized);
  const stem = basename.includes(".")
    ? basename.slice(0, basename.lastIndexOf("."))
    : basename;
  return {
    files: uniqueRecent([normalized, basename], MAX_FOCUS_FILES),
    keywords: uniqueRecent(
      [stem, ...normalized.split(/[/]/)],
      MAX_FOCUS_KEYWORDS,
    ),
  };
}

function deriveFocusFromToolArguments(
  args: Record<string, unknown> | null,
): SummaryFocus {
  if (!args) {
    return { files: [], keywords: [] };
  }

  const files: string[] = [];
  const keywords: string[] = [];
  const pathLikeValues = [
    args.path,
    args.filePath,
    args.sourcePath,
    args.destinationPath,
  ].filter((value): value is string => typeof value === "string");
  for (const value of pathLikeValues) {
    const focus = deriveFocusFromPath(value);
    files.push(...focus.files);
    keywords.push(...focus.keywords);
  }

  if (typeof args.query === "string") {
    keywords.push(...extractKeywords(args.query));
  }
  if (typeof args.command === "string") {
    keywords.push(...extractKeywords(args.command));
  }

  return {
    files: uniqueRecent(files, MAX_FOCUS_FILES),
    keywords: uniqueRecent(keywords, MAX_FOCUS_KEYWORDS),
  };
}

function summarizeToolCall(message: ChatMessage): string[] {
  if (!message.tool_calls) {
    return [];
  }

  const lines: string[] = [];
  for (const toolCall of message.tool_calls) {
    const args = parseJsonObject(toolCall.function.arguments);
    const filePath = typeof args?.path === "string" ? args.path : undefined;
    const query = typeof args?.query === "string" ? args.query : undefined;
    const command =
      typeof args?.command === "string" ? args.command : undefined;

    if (filePath) {
      lines.push(`文件操作: ${toolCall.function.name} ${filePath}`);
      continue;
    }
    if (query) {
      lines.push(`代码搜索: ${summarizeText(query, 80)}`);
      continue;
    }
    if (command) {
      lines.push(`计划命令: ${summarizeText(command, 80)}`);
      continue;
    }
    lines.push(`工具调用: ${toolCall.function.name}`);
  }

  return lines;
}

export function summarizeRemovedMessage(message: ChatMessage): string[] {
  if (isSummaryMessage(message)) {
    return [];
  }

  if (message.role === "user" && message.content) {
    return [`用户任务: ${summarizeText(message.content)}`];
  }

  if (
    message.role === "assistant" &&
    message.tool_calls &&
    message.tool_calls.length > 0
  ) {
    return summarizeToolCall(message);
  }

  if (message.role === "assistant" && message.content) {
    return [`助手结论: ${summarizeText(message.content)}`];
  }

  if (message.role === "tool" && message.name && message.content) {
    if (message.name === "run_command") {
      const parsed = parseJsonObject(message.content);
      if (typeof parsed?.command === "string") {
        const exitCode =
          typeof parsed.exitCode === "number" ? parsed.exitCode : "unknown";
        return [
          `命令结果: ${summarizeText(parsed.command, 80)} -> exit ${exitCode}`,
        ];
      }
    }
    return [`工具 ${message.name}: ${summarizeText(message.content)}`];
  }

  return [];
}

export function deriveFocusFromMessage(message: ChatMessage): SummaryFocus {
  const files: string[] = [];
  const keywords: string[] = [];

  if (message.role === "user" && message.content) {
    keywords.push(...extractKeywords(message.content));
    const pathCandidates =
      message.content.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+/g) || [];
    for (const candidate of pathCandidates) {
      const focus = deriveFocusFromPath(candidate);
      files.push(...focus.files);
      keywords.push(...focus.keywords);
    }
  }

  if (message.role === "assistant" && message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      const focus = deriveFocusFromToolArguments(
        parseJsonObject(toolCall.function.arguments),
      );
      files.push(...focus.files);
      keywords.push(...focus.keywords);
      keywords.push(toolCall.function.name.toLowerCase());
    }
  }

  if (
    message.role === "tool" &&
    message.name === "run_command" &&
    message.content
  ) {
    const parsed = parseJsonObject(message.content);
    if (typeof parsed?.command === "string") {
      keywords.push(...extractKeywords(parsed.command));
    }
  }

  return {
    files: uniqueRecent(files, MAX_FOCUS_FILES),
    keywords: uniqueRecent(keywords, MAX_FOCUS_KEYWORDS),
  };
}

export function deriveFocusFromPaths(paths: Iterable<string>): SummaryFocus {
  const files: string[] = [];
  const keywords: string[] = [];

  for (const filePath of paths) {
    const focus = deriveFocusFromPath(filePath);
    files.push(...focus.files);
    keywords.push(...focus.keywords);
  }

  return {
    files: uniqueRecent(files, MAX_FOCUS_FILES),
    keywords: uniqueRecent(keywords, MAX_FOCUS_KEYWORDS),
  };
}

export function mergeSummaryFocus(
  base: SummaryFocus,
  extra: SummaryFocus,
): SummaryFocus {
  return {
    files: uniqueRecent([...base.files, ...extra.files], MAX_FOCUS_FILES),
    keywords: uniqueRecent(
      [...base.keywords, ...extra.keywords],
      MAX_FOCUS_KEYWORDS,
    ),
  };
}

function scoreSummaryLine(
  line: string,
  focus: SummaryFocus,
  index: number,
  total: number,
): number {
  const normalized = line.toLowerCase();
  const recencyScore = total === 0 ? 0 : index / total;
  let score = recencyScore;

  for (const file of focus.files) {
    const normalizedFile = file.toLowerCase();
    const basename = path.basename(normalizedFile);
    if (normalized.includes(normalizedFile)) {
      score += 8;
      continue;
    }
    if (basename && normalized.includes(basename)) {
      score += 5;
    }
  }

  let keywordHits = 0;
  for (const keyword of focus.keywords) {
    if (keyword.length < 2) {
      continue;
    }
    if (normalized.includes(keyword.toLowerCase())) {
      score += keyword.length >= 6 ? 2 : 1.2;
      keywordHits += 1;
      if (keywordHits >= 4) {
        break;
      }
    }
  }

  if (line.startsWith("文件操作:")) {
    score += 1.5;
  } else if (line.startsWith("代码搜索:")) {
    score += 1;
  } else if (line.startsWith("计划命令:")) {
    score += 0.8;
  }

  return score;
}

export function compactSummaryLines(
  lines: string[],
  focus: SummaryFocus,
  maxLines: number,
): string[] {
  const deduped = uniqueRecent(lines, Math.max(maxLines * 3, maxLines));
  if (deduped.length <= maxLines) {
    return deduped;
  }

  const selectedIndexes = new Set(
    deduped
      .map((line, index) => ({
        index,
        score: scoreSummaryLine(line, focus, index, deduped.length),
      }))
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, maxLines)
      .map((entry) => entry.index),
  );

  return deduped.filter((_, index) => selectedIndexes.has(index));
}
