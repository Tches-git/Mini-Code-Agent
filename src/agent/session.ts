import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentTaskItem, ChatMessage } from "../types/agent.js";
import { normalizeFilePath } from "../utils/path.js";
import { getWorkspaceStateDir } from "../utils/runtime.js";
import { isSummaryMessage } from "../utils/token.js";
import type { SummaryFocus } from "./summary.js";

function getSessionDir(): string {
  return process.env.MINI_CLAUDE_CODE_SESSION_DIR?.trim()
    ? path.resolve(process.env.MINI_CLAUDE_CODE_SESSION_DIR)
    : path.join(getWorkspaceStateDir(), "sessions");
}

function getSessionIndexFile(): string {
  return path.join(getSessionDir(), "index.json");
}

function getLatestSessionFile(): string {
  return path.join(getSessionDir(), "latest.txt");
}

export type SessionSummary = {
  id: string;
  title: string;
  summary: string;
  latestUserMessage: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
};

export type SessionContextEntry = {
  id: string;
  sessionId: string;
  sessionTitle: string;
  text: string;
  source: "summary" | "message" | "task";
  files: string[];
  keywords: string[];
  taskIds: number[];
  createdAt: string;
  updatedAt: string;
};

export type SessionData = SessionSummary & {
  version: number;
  messages: ChatMessage[];
  summaryLines: string[];
  summaryFocus: SummaryFocus;
  tasks?: AgentTaskItem[];
  contextEntries?: SessionContextEntry[];
};

const SESSION_DATA_VERSION = 2;
const MAX_SESSION_CONTEXT_ENTRIES = 80;
const MAX_RELEVANT_CONTEXT_ENTRIES = 8;
const SESSION_CONTEXT_MESSAGE_PREFIX = "[相关历史上下文]";

function getSessionFile(id: string): string {
  return path.join(getSessionDir(), `${id}.json`);
}

function trimLine(value: string | null | undefined, maxLength = 120): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function uniqueRecent(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.unshift(value);
  }
  return deduped.slice(-limit);
}

function extractKeywords(text: string): string[] {
  return uniqueRecent(
    (text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) || []).filter(
      (word) => !/^\d+$/.test(word),
    ),
    24,
  );
}

function extractFiles(text: string): string[] {
  return uniqueRecent(
    (text.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+/g) || []).map((file) =>
      normalizeFilePath(file),
    ),
    12,
  );
}

function getUserMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === "user");
}

function deriveLatestUserMessage(messages: ChatMessage[]): string {
  const userMessages = getUserMessages(messages);
  const latest = userMessages[userMessages.length - 1];
  return trimLine(typeof latest?.content === "string" ? latest.content : "");
}

function deriveTitle(messages: ChatMessage[]): string {
  const userMessages = getUserMessages(messages);
  const first = userMessages[0];
  return (
    trimLine(
      typeof first?.content === "string" ? first.content : "新会话",
      60,
    ) || "新会话"
  );
}

function deriveSummary(
  summaryLines: string[],
  latestUserMessage: string,
): string {
  const firstSummaryLine = trimLine(summaryLines[0], 100);
  return firstSummaryLine || latestUserMessage || "暂无摘要";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is number =>
          typeof item === "number" && Number.isFinite(item),
      )
    : [];
}

function normalizeContextEntry(
  entry: Partial<SessionContextEntry> | null | undefined,
): SessionContextEntry | null {
  if (!entry || typeof entry.id !== "string" || !entry.text?.trim()) {
    return null;
  }
  const source = ["summary", "message", "task"].includes(entry.source || "")
    ? (entry.source as SessionContextEntry["source"])
    : "message";
  return {
    id: entry.id,
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
    sessionTitle:
      typeof entry.sessionTitle === "string" ? entry.sessionTitle : "新会话",
    text: trimLine(entry.text, 240),
    source,
    files: uniqueRecent(
      normalizeStringArray(entry.files).map(normalizeFilePath),
      12,
    ),
    keywords: uniqueRecent(normalizeStringArray(entry.keywords), 24),
    taskIds: uniqueRecent(
      normalizeNumberArray(entry.taskIds).map(String),
      12,
    ).map(Number),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
  };
}

function createContextEntry(input: {
  sessionId: string;
  sessionTitle: string;
  source: SessionContextEntry["source"];
  text: string;
  files?: string[];
  keywords?: string[];
  taskIds?: number[];
  updatedAt: string;
  fallbackCreatedAt?: string;
}): SessionContextEntry | null {
  const text = trimLine(input.text, 240);
  if (!text || isSummaryMessage({ role: "assistant", content: text }))
    return null;
  const files = uniqueRecent(
    [...(input.files || []), ...extractFiles(text)].map(normalizeFilePath),
    12,
  );
  return {
    id: `${input.source}:${text.toLowerCase().slice(0, 80)}`,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    text,
    source: input.source,
    files,
    keywords: uniqueRecent(
      [...(input.keywords || []), ...extractKeywords(text)],
      24,
    ),
    taskIds: uniqueRecent((input.taskIds || []).map(String), 12).map(Number),
    createdAt: input.fallbackCreatedAt || input.updatedAt,
    updatedAt: input.updatedAt,
  };
}

function buildSessionContextEntries(input: {
  id: string;
  title: string;
  messages: ChatMessage[];
  summaryLines: string[];
  summaryFocus: SummaryFocus;
  tasks?: AgentTaskItem[];
  updatedAt: string;
  existing?: SessionContextEntry[];
}): SessionContextEntry[] {
  const entries = new Map<string, SessionContextEntry>();
  for (const existing of input.existing || []) {
    const normalized = normalizeContextEntry(existing);
    if (normalized) entries.set(normalized.id, normalized);
  }

  for (const line of input.summaryLines) {
    const entry = createContextEntry({
      sessionId: input.id,
      sessionTitle: input.title,
      source: "summary",
      text: line,
      files: input.summaryFocus.files,
      keywords: input.summaryFocus.keywords,
      updatedAt: input.updatedAt,
    });
    if (entry) entries.set(entry.id, entry);
  }

  for (const message of input.messages.slice(-12)) {
    if (message.role !== "user" || !message.content) continue;
    const entry = createContextEntry({
      sessionId: input.id,
      sessionTitle: input.title,
      source: "message",
      text: `用户任务: ${message.content}`,
      updatedAt: input.updatedAt,
    });
    if (entry) entries.set(entry.id, entry);
  }

  for (const task of input.tasks || []) {
    if (task.status === "todo") continue;
    const details = [
      task.blockedReason ? `阻塞: ${task.blockedReason}` : "",
      task.note ? `备注: ${task.note}` : "",
    ].filter(Boolean);
    const entry = createContextEntry({
      sessionId: input.id,
      sessionTitle: input.title,
      source: "task",
      text: `任务 ${task.id} [${task.status}]: ${task.title}${details.length ? ` — ${details.join("; ")}` : ""}`,
      taskIds: [task.id],
      updatedAt: input.updatedAt,
    });
    if (entry) entries.set(entry.id, entry);
  }

  return Array.from(entries.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSION_CONTEXT_ENTRIES);
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(getSessionDir(), { recursive: true });
}

function normalizeSessionSummary(
  session: Partial<SessionSummary> | null | undefined,
): SessionSummary | null {
  if (!session || typeof session.id !== "string" || !session.id.trim()) {
    return null;
  }

  return {
    id: session.id,
    title:
      typeof session.title === "string" && session.title.trim()
        ? session.title
        : "新会话",
    summary:
      typeof session.summary === "string" && session.summary.trim()
        ? session.summary
        : "暂无摘要",
    latestUserMessage:
      typeof session.latestUserMessage === "string"
        ? session.latestUserMessage
        : "",
    createdAt: typeof session.createdAt === "string" ? session.createdAt : "",
    updatedAt:
      typeof session.updatedAt === "string"
        ? session.updatedAt
        : typeof session.createdAt === "string"
          ? session.createdAt
          : "",
    turnCount:
      typeof session.turnCount === "number" &&
      Number.isFinite(session.turnCount)
        ? session.turnCount
        : 0,
  };
}

async function readSessionIndex(): Promise<SessionSummary[]> {
  try {
    const content = await fs.readFile(getSessionIndexFile(), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => normalizeSessionSummary(item as Partial<SessionSummary>))
      .filter((item): item is SessionSummary => Boolean(item));
  } catch {
    return [];
  }
}

async function writeSessionIndex(items: SessionSummary[]): Promise<void> {
  await ensureSessionDir();
  await fs.writeFile(
    getSessionIndexFile(),
    JSON.stringify(items, null, 2),
    "utf8",
  );
}

async function writeLatestSessionId(id: string): Promise<void> {
  await ensureSessionDir();
  await fs.writeFile(getLatestSessionFile(), id, "utf8");
}

async function readLatestSessionId(): Promise<string | null> {
  try {
    const content = await fs.readFile(getLatestSessionFile(), "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function repairLatestSessionPointer(
  index: SessionSummary[],
): Promise<string | null> {
  for (const item of index) {
    try {
      await fs.access(getSessionFile(item.id));
      await writeLatestSessionId(item.id);
      return item.id;
    } catch {}
  }
  await fs.unlink(getLatestSessionFile()).catch(() => {});
  return null;
}

export async function saveSession(data: {
  id?: string;
  messages: ChatMessage[];
  summaryLines: string[];
  summaryFocus: SummaryFocus;
  tasks?: AgentTaskItem[];
}): Promise<string> {
  await ensureSessionDir();

  const id = data.id || randomUUID();
  const existing = await loadSession(id);
  const createdAt = existing?.createdAt || new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const latestUserMessage = deriveLatestUserMessage(data.messages);
  const summary = deriveSummary(data.summaryLines, latestUserMessage);
  const title = existing?.title || deriveTitle(data.messages);
  const turnCount = getUserMessages(data.messages).length;
  const tasks = data.tasks || existing?.tasks || [];

  const payload: SessionData = {
    id,
    version: SESSION_DATA_VERSION,
    title,
    summary,
    latestUserMessage,
    createdAt,
    updatedAt,
    turnCount,
    messages: data.messages,
    summaryLines: data.summaryLines,
    summaryFocus: data.summaryFocus,
    tasks,
    contextEntries: buildSessionContextEntries({
      id,
      title,
      messages: data.messages,
      summaryLines: data.summaryLines,
      summaryFocus: data.summaryFocus,
      tasks,
      updatedAt,
      existing: existing?.contextEntries,
    }),
  };

  await fs.writeFile(
    getSessionFile(id),
    JSON.stringify(payload, null, 2),
    "utf8",
  );

  const summaryEntry: SessionSummary = {
    id: payload.id,
    title: payload.title,
    summary: payload.summary,
    latestUserMessage: payload.latestUserMessage,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    turnCount: payload.turnCount,
  };

  const index = await readSessionIndex();
  const nextIndex = [summaryEntry, ...index.filter((item) => item.id !== id)];

  await writeSessionIndex(nextIndex);
  await writeLatestSessionId(id);
  return id;
}

export async function loadSession(id?: string): Promise<SessionData | null> {
  try {
    let sessionId = id || (await readLatestSessionId());
    if (!sessionId) {
      return null;
    }

    let content: string;
    try {
      content = await fs.readFile(getSessionFile(sessionId), "utf8");
    } catch {
      if (id) {
        return null;
      }
      const repairedSessionId = await repairLatestSessionPointer(
        await readSessionIndex(),
      );
      if (!repairedSessionId || repairedSessionId === sessionId) {
        return null;
      }
      sessionId = repairedSessionId;
      content = await fs.readFile(getSessionFile(sessionId), "utf8");
    }

    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const data = parsed as Partial<SessionData>;
    if (!Array.isArray(data.messages) || !Array.isArray(data.summaryLines)) {
      return null;
    }

    const latestUserMessage =
      typeof data.latestUserMessage === "string"
        ? data.latestUserMessage
        : deriveLatestUserMessage(data.messages);

    return {
      id: data.id || sessionId,
      version:
        typeof data.version === "number" && Number.isFinite(data.version)
          ? data.version
          : SESSION_DATA_VERSION,
      title:
        typeof data.title === "string" && data.title.trim()
          ? data.title
          : deriveTitle(data.messages),
      summary:
        typeof data.summary === "string" && data.summary.trim()
          ? data.summary
          : deriveSummary(data.summaryLines, latestUserMessage),
      latestUserMessage,
      createdAt: data.createdAt || data.updatedAt || "",
      updatedAt: data.updatedAt || data.createdAt || "",
      turnCount:
        typeof data.turnCount === "number"
          ? data.turnCount
          : getUserMessages(data.messages).length,
      messages: data.messages,
      summaryLines: data.summaryLines,
      summaryFocus: data.summaryFocus || { files: [], keywords: [] },
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      contextEntries: Array.isArray(data.contextEntries)
        ? data.contextEntries
            .map((entry) =>
              normalizeContextEntry(entry as Partial<SessionContextEntry>),
            )
            .filter((entry): entry is SessionContextEntry => Boolean(entry))
        : [],
    };
  } catch {
    return null;
  }
}

function scoreContextEntry(
  entry: SessionContextEntry,
  query: SummaryFocus,
): number {
  const normalizedText = entry.text.toLowerCase();
  let score = 0;
  for (const file of query.files) {
    const normalized = normalizeFilePath(file).toLowerCase();
    const basename = path.basename(normalized);
    if (
      entry.files.some((candidate) => candidate.toLowerCase() === normalized)
    ) {
      score += 12;
    } else if (basename && normalizedText.includes(basename)) {
      score += 6;
    }
  }
  for (const keyword of query.keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.length < 2) continue;
    if (
      entry.keywords.some((candidate) => candidate.toLowerCase() === normalized)
    ) {
      score += normalized.length >= 6 ? 3 : 1.5;
    } else if (normalizedText.includes(normalized)) {
      score += 1;
    }
  }
  if (entry.source === "task") score += 0.4;
  return score;
}

export async function findRelevantSessionContext(options: {
  queryText?: string;
  focus?: SummaryFocus;
  taskIds?: number[];
  sessionId?: string;
  limit?: number;
}): Promise<SessionContextEntry[]> {
  const queryFocus: SummaryFocus = {
    files: uniqueRecent(
      [
        ...(options.focus?.files || []),
        ...extractFiles(options.queryText || ""),
      ].map(normalizeFilePath),
      12,
    ),
    keywords: uniqueRecent(
      [
        ...(options.focus?.keywords || []),
        ...extractKeywords(options.queryText || ""),
      ],
      24,
    ),
  };
  const taskIds = new Set(options.taskIds || []);
  const sessions = options.sessionId
    ? [await loadSession(options.sessionId)]
    : await Promise.all(
        (await listSessions()).map((session) => loadSession(session.id)),
      );
  const scored = sessions
    .filter((session): session is SessionData => Boolean(session))
    .flatMap((session) => session.contextEntries || [])
    .map((entry) => ({
      entry,
      score:
        scoreContextEntry(entry, queryFocus) +
        (taskIds.size > 0 && entry.taskIds.some((id) => taskIds.has(id))
          ? 20
          : 0),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    )
    .slice(0, Math.max(1, options.limit || MAX_RELEVANT_CONTEXT_ENTRIES));
  return scored.map(({ entry }) => entry);
}

export function buildRelevantSessionContextMessage(
  entries: SessionContextEntry[],
): ChatMessage | null {
  if (entries.length === 0) return null;
  return {
    role: "assistant",
    content: `${SESSION_CONTEXT_MESSAGE_PREFIX}\n${entries
      .map(
        (entry) =>
          `- ${entry.text}（${entry.sessionTitle} / ${entry.source}${entry.files.length ? ` / ${entry.files.slice(0, 3).join(", ")}` : ""}）`,
      )
      .join("\n")}`,
  };
}

export function isRelevantSessionContextMessage(
  message: ChatMessage | undefined,
): boolean {
  return Boolean(
    message &&
      message.role === "assistant" &&
      message.content?.startsWith(SESSION_CONTEXT_MESSAGE_PREFIX),
  );
}

export async function listSessions(): Promise<SessionSummary[]> {
  const index = await readSessionIndex();
  const validSessions: SessionSummary[] = [];

  for (const item of index) {
    try {
      await fs.access(getSessionFile(item.id));
      validSessions.push(item);
    } catch {}
  }

  const sorted = validSessions.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  if (sorted.length !== index.length) {
    await writeSessionIndex(sorted);
    const latestId = await readLatestSessionId();
    if (!latestId || !sorted.some((session) => session.id === latestId)) {
      await repairLatestSessionPointer(sorted);
    }
  }
  return sorted;
}

export async function clearSession(id?: string): Promise<void> {
  try {
    const sessionId = id || (await readLatestSessionId());
    if (!sessionId) {
      return;
    }

    await fs.unlink(getSessionFile(sessionId)).catch(() => {});
    const index = await readSessionIndex();
    await writeSessionIndex(index.filter((item) => item.id !== sessionId));

    const latestId = await readLatestSessionId();
    if (latestId === sessionId) {
      const remaining = await readSessionIndex();
      if (remaining[0]?.id) {
        await writeLatestSessionId(remaining[0].id);
      } else {
        await fs.unlink(getLatestSessionFile()).catch(() => {});
      }
    }
  } catch {
    // 忽略清理错误
  }
}

export async function hasSession(id?: string): Promise<boolean> {
  const session = await loadSession(id);
  return Boolean(session);
}
