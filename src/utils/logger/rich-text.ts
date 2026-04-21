import chalk from "chalk";
import {
  formatInlineMarkdown,
  formatInlineText,
  getTerminalWidth,
  padRight,
  stripMarkdown,
  wrapPlainText,
} from "./core.js";

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const cells = parseTableRow(line);
  return Boolean(
    cells && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
}

function renderTableAsCards(rows: string[][], indent: string): string[] {
  const [header, ...body] = rows;
  return body.flatMap((row, rowIndex) => {
    const title = stripMarkdown(row[0] || `${header[0] || "条目"} ${rowIndex + 1}`) || `第 ${rowIndex + 1} 项`;
    const cardLines = [chalk.cyan(`${indent}┌─ ${title}`)];

    for (let index = 1; index < row.length; index++) {
      const label = stripMarkdown(header[index] || `列${index + 1}`);
      const value = stripMarkdown(row[index] || "-");
      const wrapped = wrapPlainText(
        `${label}: ${value || "-"}`,
        Math.max(12, getTerminalWidth() - indent.length - 3),
      );
      for (const line of wrapped) {
        cardLines.push(`${chalk.gray(`${indent}│ `)}${formatInlineText(line)}`);
      }
    }

    cardLines.push(chalk.gray(`${indent}└─`));
    if (rowIndex < body.length - 1) {
      cardLines.push("");
    }
    return cardLines;
  });
}

function renderTable(rows: string[][], indent: string): string[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] || ""),
  );
  const availableWidth = Math.max(
    columnCount,
    getTerminalWidth() - indent.length - (columnCount + 1) * 3,
  );
  const minColumnWidth = Math.max(6, Math.floor(availableWidth / Math.max(columnCount, 1)));
  const longestCell = Math.max(
    ...normalizedRows.flatMap((row) => row.map((cell) => stripMarkdown(cell).length)),
  );
  if (columnCount >= 3 && (minColumnWidth < 24 || longestCell > minColumnWidth * 2)) {
    return renderTableAsCards(normalizedRows, indent);
  }

  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(
      1,
      Math.min(
        Math.max(
          ...normalizedRows.map((row) => stripMarkdown(row[index] || "").length),
          1,
        ),
        minColumnWidth,
      ),
    ),
  );

  const border = (left: string, middle: string, right: string) =>
    chalk.gray(
      `${indent}${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`,
    );

  const renderCellLines = (cell: string, width: number) => {
    const plain = stripMarkdown(cell);
    const wrapped = wrapPlainText(plain, width);
    return wrapped.length > 0 ? wrapped : [plain];
  };

  const renderRow = (row: string[], accent = false) => {
    const cellLines = row.map((cell, index) => renderCellLines(cell, widths[index] || 1));
    const rowHeight = Math.max(...cellLines.map((lines) => lines.length));
    const renderedLines: string[] = [];

    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
      const renderedCells = cellLines.map((lines, index) => {
        const content = padRight(
          formatInlineText(lines[lineIndex] || ""),
          widths[index] || 1,
        );
        return accent ? chalk.cyan(content) : chalk.white(content);
      });
      renderedLines.push(
        `${chalk.gray(`${indent}│ `)}${renderedCells.join(chalk.gray(" │ "))}${chalk.gray(" │")}`,
      );
    }

    return renderedLines;
  };

  const [header, ...body] = normalizedRows;
  return [
    border("┌", "┬", "┐"),
    ...renderRow(header, true),
    border("├", "┼", "┤"),
    ...body.flatMap((row) => renderRow(row)),
    border("└", "┴", "┘"),
  ];
}

export function renderRichTextLines(text: string, indent = "  "): string[] {
  const lines = text.split("\n");
  const rendered: string[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        rendered.push(chalk.gray(`${indent}┌─ code`));
      } else {
        rendered.push(chalk.gray(`${indent}└─`));
      }
      continue;
    }

    if (inCodeBlock) {
      rendered.push(chalk.gray(`${indent}  ${line}`));
      continue;
    }

    if (trimmed === "") {
      rendered.push("");
      continue;
    }

    const maybeHeader = parseTableRow(line);
    if (maybeHeader && index + 1 < lines.length && isTableSeparatorLine(lines[index + 1] || "")) {
      const rows = [maybeHeader];
      index += 2;
      while (index < lines.length) {
        const row = parseTableRow(lines[index] || "");
        if (!row) {
          index -= 1;
          break;
        }
        rows.push(row);
        index += 1;
      }
      rendered.push(...renderTable(rows, indent));
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      rendered.push(chalk.cyan.bold(`${indent}${stripMarkdown(headingMatch[2])}`));
      continue;
    }

    const boldHeadingMatch = /^\*\*(.+)\*\*$/.exec(trimmed);
    if (boldHeadingMatch) {
      rendered.push(chalk.cyan.bold(`${indent}${stripMarkdown(boldHeadingMatch[1])}`));
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      rendered.push(`${chalk.gray(`${indent}• `)}${formatInlineMarkdown(bulletMatch[1])}`);
      continue;
    }

    const orderedMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (orderedMatch) {
      rendered.push(
        `${chalk.gray(`${indent}${orderedMatch[1]}. `)}${formatInlineMarkdown(orderedMatch[2])}`,
      );
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      rendered.push(chalk.gray(`${indent}${"─".repeat(24)}`));
      continue;
    }

    for (const wrappedLine of wrapPlainText(trimmed, getTerminalWidth() - indent.length)) {
      rendered.push(`${indent}${formatInlineMarkdown(wrappedLine)}`);
    }
  }

  return rendered;
}
