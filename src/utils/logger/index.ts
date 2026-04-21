import chalk from "chalk";
import {
  formatInlineText,
  getTerminalWidth,
  renderStatusTag,
  stripLeadingIndent,
  stripMarkdown,
  truncatePlainText,
  wrapPlainText,
  wrapTextLines,
} from "./core.js";
import { renderRichTextLines } from "./rich-text.js";
import { Spinner } from "./spinner.js";

export { renderRichTextLines, Spinner };

export function logSection(title: string) {
  console.log(chalk.cyan.bold(`\n┌─ ${stripMarkdown(title)}`));
}

export function logCard(title: string, body?: string) {
  logSection(title);
  if (body) {
    logRenderedText(body);
  }
}

export function logDetailEntries(
  entries: Array<{ label: string; value: string }>,
  indent = "  ",
) {
  for (const entry of entries) {
    logKeyValue(entry.label, entry.value, indent);
  }
}

export function logCardList(
  title: string,
  items: string[],
  options?: { emptyText?: string; indent?: string },
) {
  logCard(title);
  if (items.length === 0) {
    logEmptyState(options?.emptyText || "暂无内容。");
    return;
  }
  for (const item of items) {
    logListItem(item, options?.indent || "  ");
  }
}

export function logLine(text: string) {
  logRenderedText(text);
}

export function logEmptyState(text: string) {
  console.log(chalk.gray(`  · ${stripMarkdown(text)}`));
}

export function logHint(text: string) {
  console.log(chalk.blue("  💡 ") + chalk.gray(formatInlineText(stripMarkdown(text))));
}

export function logKeyValue(label: string, value: string, indent = "  ") {
  const formattedValue = formatInlineText(stripMarkdown(value));
  console.log(`${chalk.gray(`${indent}• `)}${chalk.cyan(label)} ${chalk.white(formattedValue)}`);
}

export function logListItem(text: string, indent = "  ") {
  const nestedIndent = `${indent}  `;
  const lines = renderRichTextLines(text, nestedIndent);
  if (lines.length === 0) {
    console.log(chalk.gray(`${indent}•`));
    return;
  }

  const [firstLine, ...rest] = lines;
  console.log(`${chalk.gray(`${indent}• `)}${stripLeadingIndent(firstLine, nestedIndent)}`);
  for (const line of rest) {
    if (line === "") {
      console.log("");
      continue;
    }
    console.log(line);
  }
}

export function logStep(index: number, text: string) {
  const lines = wrapPlainText(stripMarkdown(text), getTerminalWidth() - 6);
  for (const [lineIndex, line] of lines.entries()) {
    console.log(
      lineIndex === 0
        ? chalk.gray(`  ${index}. `) + formatInlineText(line)
        : chalk.gray("     ") + formatInlineText(line),
    );
  }
}

export function logSuccess(text: string) {
  if (text.includes("\n") || /(^|\s)(\*\*|#{1,6}\s|\|.+\|)/.test(text)) {
    console.log(chalk.green("  ✔ 完成"));
    logRenderedText(text);
    return;
  }
  console.log(chalk.green("  ✔ ") + formatInlineText(stripMarkdown(text)));
}

export function logError(text: string) {
  console.log(chalk.red("  ✖ ") + formatInlineText(stripMarkdown(text)));
}

export function logStatusLine(
  status: "PASS" | "FAIL" | "SKIP" | "INFO",
  text: string,
  indent = "  ",
) {
  const color =
    status === "PASS"
      ? "green"
      : status === "FAIL"
        ? "red"
        : status === "SKIP"
          ? "yellow"
          : "blue";
  console.log(`${indent}${renderStatusTag(status, color)} ${formatInlineText(stripMarkdown(text))}`);
}

export function logDiffHeader(path: string, summary: string) {
  const maxPathWidth = Math.max(20, getTerminalWidth() - 30);
  const safePath = truncatePlainText(path, maxPathWidth);
  logStatusLine("INFO", `文件 ${safePath} · ${summary}`, "");
}

export function logDiffLine(line: string) {
  const prefix = line[0] || " ";
  const text = line.length > 1 ? line.slice(1) : "";
  const width = Math.max(20, getTerminalWidth() - 4);
  const wrapped = wrapTextLines(text, Math.max(1, width - 2));
  const colorize =
    prefix === "+"
      ? chalk.green
      : prefix === "-"
        ? chalk.red
        : prefix === "?"
          ? chalk.cyan
          : chalk.gray;

  if (wrapped.length === 0) {
    console.log(colorize(prefix));
    return;
  }

  for (const [index, segment] of wrapped.entries()) {
    const marker = index === 0 ? prefix : " ";
    console.log(colorize(`${marker} ${segment}`));
  }
}

export function logToolCall(name: string, args: string) {
  const short = truncatePlainText(args, Math.max(24, getTerminalWidth() - name.length - 10));
  logStatusLine("INFO", `工具调用 ${name} · ${short}`);
}

export function logToolResult(name: string, result: string) {
  const short = truncatePlainText(result, Math.max(24, getTerminalWidth() - name.length - 10));
  logStatusLine("PASS", `${name} → ${short}`);
}

export function logToolError(name: string, error: string) {
  const short = truncatePlainText(error, Math.max(24, getTerminalWidth() - name.length - 10));
  logStatusLine("FAIL", `${name} → ${short}`);
}

export function logAutoValidate(command: string) {
  logStatusLine("INFO", `自动验证 · ${truncatePlainText(command, getTerminalWidth() - 16)}`);
}

export function logAutoValidateSkipped(reason: string) {
  logStatusLine("SKIP", `自动验证已跳过 · ${truncatePlainText(reason, getTerminalWidth() - 20)}`);
}

export function logAutoFix(round: number) {
  logStatusLine("INFO", `自动修复第 ${round} 轮`);
}

export function logContextTrimmed(removed: number, totalTokens: number) {
  logStatusLine("INFO", `上下文裁剪 · 移除 ${removed} 条旧消息 · 当前约 ${totalTokens} tokens`);
}

export function logFileModified(path?: string) {
  const safePath = path ? truncatePlainText(path, Math.max(20, getTerminalWidth() - 22)) : "(unknown)";
  logStatusLine("INFO", `文件已修改 · ${safePath}`);
}

export function logBanner() {
  console.log();
  console.log(chalk.cyan.bold("  ╔══════════════════════════════════════╗"));
  console.log(
    chalk.cyan.bold("  ║") +
      chalk.white.bold("     Mini Claude Code · 交互模式      ") +
      chalk.cyan.bold("║"),
  );
  console.log(chalk.cyan.bold("  ╚══════════════════════════════════════╝"));
  console.log(
    chalk.gray("  输入任务开始对话，输入 /exit 退出，/clear 清空上下文"),
  );
  console.log();
}

export function logRenderedText(text: string, indent = "  ") {
  for (const line of renderRichTextLines(text, indent)) {
    console.log(line);
  }
}

export function logAssistant(text: string) {
  logCard("Assistant", text);
  console.log();
}
