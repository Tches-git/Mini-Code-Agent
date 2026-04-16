const DEFAULT_CONTEXT_LINES = 3;
const MAX_DIFF_MATRIX_CELLS = 200_000;
const INLINE_CONTEXT_CHARS = 18;
const INLINE_CHANGE_CHARS = 32;

type DiffOp =
  | { type: "equal"; line: string }
  | { type: "delete"; line: string }
  | { type: "insert"; line: string };

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function buildFallbackPreview(
  beforeLines: string[],
  afterLines: string[],
  path?: string,
): string {
  const beforeHeader = path ? `--- a/${path}` : "--- before";
  const afterHeader = path ? `+++ b/${path}` : "+++ after";
  const previewLines = [
    beforeHeader,
    ...beforeLines.slice(0, 20).map((line) => `-${line}`),
    afterHeader,
    ...afterLines.slice(0, 20).map((line) => `+${line}`),
  ];

  if (beforeLines.length > 20 || afterLines.length > 20) {
    previewLines.push(" ...diff too large, preview truncated...");
  }

  return previewLines.join("\n");
}

function buildDiffOperations(
  beforeLines: string[],
  afterLines: string[],
): DiffOp[] {
  const cells = beforeLines.length * afterLines.length;
  if (cells > MAX_DIFF_MATRIX_CELLS) {
    return [];
  }

  const lcs = Array.from({ length: beforeLines.length + 1 }, () =>
    new Array<number>(afterLines.length + 1).fill(0),
  );

  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      if (beforeLines[i] === afterLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ type: "equal", line: beforeLines[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "delete", line: beforeLines[i] });
      i += 1;
    } else {
      ops.push({ type: "insert", line: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    ops.push({ type: "delete", line: beforeLines[i] });
    i += 1;
  }

  while (j < afterLines.length) {
    ops.push({ type: "insert", line: afterLines[j] });
    j += 1;
  }

  return ops;
}

function formatRange(start: number, length: number): string {
  if (length === 0) return `${start},0`;
  if (length === 1) return String(start);
  return `${start},${length}`;
}

function trimStartWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `...${text.slice(-(maxChars - 3))}`;
}

function trimEndWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function trimMiddleWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  const keep = maxChars - 3;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}...${text.slice(text.length - right)}`;
}

function getSharedPrefixLength(before: string, after: string): number {
  let index = 0;
  while (
    index < before.length &&
    index < after.length &&
    before[index] === after[index]
  ) {
    index += 1;
  }
  return index;
}

function getSharedSuffixLength(
  before: string,
  after: string,
  prefixLength: number,
): number {
  let suffixLength = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefixLength;
  while (
    suffixLength < maxSuffix &&
    before[before.length - suffixLength - 1] ===
      after[after.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }
  return suffixLength;
}

function buildInlineSnippet(
  prefix: string,
  changed: string,
  suffix: string,
  openMarker: string,
  closeMarker: string,
): string {
  const prefixSnippet = trimStartWithEllipsis(prefix, INLINE_CONTEXT_CHARS);
  const suffixSnippet = trimEndWithEllipsis(suffix, INLINE_CONTEXT_CHARS);
  const changedSnippet = trimMiddleWithEllipsis(
    changed || "∅",
    INLINE_CHANGE_CHARS,
  );
  return `${prefixSnippet}${openMarker}${changedSnippet}${closeMarker}${suffixSnippet}`;
}

function buildInlineChangeHints(
  beforeLine: string,
  afterLine: string,
): string[] {
  const prefixLength = getSharedPrefixLength(beforeLine, afterLine);
  const suffixLength = getSharedSuffixLength(
    beforeLine,
    afterLine,
    prefixLength,
  );
  if (prefixLength === beforeLine.length && prefixLength === afterLine.length) {
    return [];
  }

  const prefix = beforeLine.slice(0, prefixLength);
  const beforeChanged = beforeLine.slice(
    prefixLength,
    beforeLine.length - suffixLength || beforeLine.length,
  );
  const afterChanged = afterLine.slice(
    prefixLength,
    afterLine.length - suffixLength || afterLine.length,
  );
  const suffix =
    suffixLength > 0 ? beforeLine.slice(beforeLine.length - suffixLength) : "";

  return [
    `? old inline: ${buildInlineSnippet(prefix, beforeChanged, suffix, "[-", "-]")}`,
    `? new inline: ${buildInlineSnippet(prefix, afterChanged, suffix, "{+", "+}")}`,
  ];
}

function flushChangeHints(
  lines: string[],
  deletions: string[],
  insertions: string[],
) {
  const pairCount = Math.min(deletions.length, insertions.length);
  for (let index = 0; index < pairCount; index++) {
    lines.push(...buildInlineChangeHints(deletions[index], insertions[index]));
  }
}

function formatHunkLines(hunkOps: DiffOp[]): string[] {
  const lines: string[] = [];
  let pendingDeletes: string[] = [];
  let pendingInserts: string[] = [];

  const flushPending = () => {
    flushChangeHints(lines, pendingDeletes, pendingInserts);
    pendingDeletes = [];
    pendingInserts = [];
  };

  for (const op of hunkOps) {
    if (op.type === "equal") {
      flushPending();
      lines.push(` ${op.line}`);
      continue;
    }

    if (op.type === "delete") {
      pendingDeletes.push(op.line);
      lines.push(`-${op.line}`);
      continue;
    }

    pendingInserts.push(op.line);
    lines.push(`+${op.line}`);
  }

  flushPending();
  return lines;
}

function pushHunk(
  hunks: string[],
  hunkOps: DiffOp[],
  beforeStart: number,
  afterStart: number,
  beforeLength: number,
  afterLength: number,
) {
  hunks.push(
    `@@ -${formatRange(beforeStart, beforeLength)} +${formatRange(afterStart, afterLength)} @@`,
  );
  for (const line of formatHunkLines(hunkOps)) {
    hunks.push(line);
  }
}

function buildUnifiedDiff(
  beforeLines: string[],
  afterLines: string[],
  path?: string,
): string {
  const ops = buildDiffOperations(beforeLines, afterLines);
  if (ops.length === 0) {
    return buildFallbackPreview(beforeLines, afterLines, path);
  }

  const beforeHeader = path ? `--- a/${path}` : "--- before";
  const afterHeader = path ? `+++ b/${path}` : "+++ after";
  const hunks: string[] = [beforeHeader, afterHeader];
  let beforeLine = 1;
  let afterLine = 1;
  let contextBuffer: DiffOp[] = [];
  let currentHunk: DiffOp[] = [];
  let hunkBeforeStart = 1;
  let hunkAfterStart = 1;
  let hunkBeforeLength = 0;
  let hunkAfterLength = 0;
  let trailingContext = 0;

  const flushHunk = () => {
    if (currentHunk.length === 0) return;
    pushHunk(
      hunks,
      currentHunk,
      hunkBeforeStart,
      hunkAfterStart,
      hunkBeforeLength,
      hunkAfterLength,
    );
    currentHunk = [];
    hunkBeforeLength = 0;
    hunkAfterLength = 0;
    trailingContext = 0;
  };

  for (const op of ops) {
    const beforeDelta = op.type !== "insert" ? 1 : 0;
    const afterDelta = op.type !== "delete" ? 1 : 0;

    if (op.type === "equal") {
      if (currentHunk.length === 0) {
        contextBuffer.push(op);
        if (contextBuffer.length > DEFAULT_CONTEXT_LINES) {
          contextBuffer.shift();
        }
      } else {
        currentHunk.push(op);
        hunkBeforeLength += beforeDelta;
        hunkAfterLength += afterDelta;
        trailingContext += 1;
        if (trailingContext > DEFAULT_CONTEXT_LINES) {
          currentHunk.splice(currentHunk.length - trailingContext, 1);
          hunkBeforeLength -= 1;
          hunkAfterLength -= 1;
          flushHunk();
          contextBuffer = [op];
        }
      }
    } else {
      if (currentHunk.length === 0) {
        hunkBeforeStart = beforeLine - contextBuffer.length;
        hunkAfterStart = afterLine - contextBuffer.length;
        currentHunk = [...contextBuffer];
        hunkBeforeLength = contextBuffer.length;
        hunkAfterLength = contextBuffer.length;
      }

      currentHunk.push(op);
      hunkBeforeLength += beforeDelta;
      hunkAfterLength += afterDelta;
      trailingContext = 0;
      contextBuffer = [];
    }

    beforeLine += beforeDelta;
    afterLine += afterDelta;
  }

  flushHunk();
  return hunks.join("\n");
}

export function buildDiffPreview(
  before: string,
  after: string,
  path?: string,
): string {
  if (before === after) {
    const beforeHeader = path ? `--- a/${path}` : "--- before";
    const afterHeader = path ? `+++ b/${path}` : "+++ after";
    return `${beforeHeader}\n${afterHeader}\n (no changes)`;
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  return buildUnifiedDiff(beforeLines, afterLines, path);
}
