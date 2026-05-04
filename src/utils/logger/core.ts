import chalk from "chalk";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching intentionally uses ESC.
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*m/g;
const DEFAULT_TERMINAL_WIDTH = 100;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1$2")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function getTerminalWidth(): number {
  const width = process.stdout.columns || DEFAULT_TERMINAL_WIDTH;
  return Math.max(60, width);
}

export function splitLongWord(word: string, width: number): string[] {
  if (word.length <= width || width <= 1) {
    return [word];
  }

  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }
  return chunks;
}

export function wrapPlainText(text: string, width: number): string[] {
  if (text.length <= width || width <= 1) {
    return [text];
  }

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const parts = splitLongWord(word, width);

    for (const [partIndex, part] of parts.entries()) {
      if (!current) {
        current = part;
        continue;
      }
      const next = partIndex === 0 ? `${current} ${part}` : `${current}${part}`;
      if (next.length <= width) {
        current = next;
        continue;
      }
      lines.push(current);
      current = part;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [text];
}

export function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function wrapTextLines(text: string, width: number): string[] {
  return text
    .split("\n")
    .flatMap((line) => wrapPlainText(stripMarkdown(line), Math.max(1, width)));
}

export function stripLeadingIndent(text: string, indent: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching intentionally uses ESC.
  const prefixMatch = /^((?:\u001B\[[0-9;]*m)*)/.exec(text);
  const prefix = prefixMatch?.[1] || "";
  const rest = text.slice(prefix.length);
  return rest.startsWith(indent)
    ? `${prefix}${rest.slice(indent.length)}`
    : text;
}

export function formatInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, value: string) => chalk.yellow(value))
    .replace(/\*\*([^*]+)\*\*/g, (_, value: string) => chalk.bold(value))
    .replace(
      /(^|[^\w])__([^_]+)__(?=[^\w]|$)/g,
      (_, prefix: string, value: string) => `${prefix}${chalk.bold(value)}`,
    )
    .replace(/\*([^*]+)\*/g, (_, value: string) => chalk.italic(value))
    .replace(
      /(^|[^\w])_([^_]+)_(?=[^\w]|$)/g,
      (_, prefix: string, value: string) => `${prefix}${chalk.italic(value)}`,
    );
}

export function formatInlineText(text: string): string {
  return formatInlineMarkdown(text.replace(/^#{1,6}\s+/, ""));
}

export function truncatePlainText(text: string, width: number): string {
  if (visibleLength(text) <= width || width <= 1) {
    return text;
  }
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function renderStatusTag(
  status: string,
  color: "green" | "red" | "yellow" | "blue",
) {
  const painter =
    color === "green"
      ? chalk.green
      : color === "red"
        ? chalk.red
        : color === "yellow"
          ? chalk.yellow
          : chalk.blue;
  return painter.bold(`[${status}]`);
}
