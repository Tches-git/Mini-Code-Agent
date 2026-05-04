import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../types/agent.js";
import { getWorkspaceStateDir } from "../utils/runtime.js";
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

export type SessionData = SessionSummary & {
  version: number;
  messages: ChatMessage[];
  summaryLines: string[];
  summaryFocus: SummaryFocus;
};

const SESSION_DATA_VERSION = 1;

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
    };
  } catch {
    return null;
  }
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
