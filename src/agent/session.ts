import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../types/agent.js";
import type { SummaryFocus } from "./summary.js";

const SESSION_DIR = path.join(process.cwd(), ".mini-claude-code", "sessions");
const SESSION_FILE = path.join(SESSION_DIR, "latest.json");

export type SessionData = {
  messages: ChatMessage[];
  summaryLines: string[];
  summaryFocus: SummaryFocus;
  savedAt: string;
};

export async function saveSession(data: Omit<SessionData, "savedAt">): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const payload: SessionData = { ...data, savedAt: new Date().toISOString() };
  await fs.writeFile(SESSION_FILE, JSON.stringify(payload, null, 2), "utf8");
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const content = await fs.readFile(SESSION_FILE, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as Partial<SessionData>;
    if (!Array.isArray(data.messages) || !Array.isArray(data.summaryLines)) return null;
    return {
      messages: data.messages,
      summaryLines: data.summaryLines,
      summaryFocus: data.summaryFocus || { files: [], keywords: [] },
      savedAt: data.savedAt || ""
    };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await fs.unlink(SESSION_FILE);
  } catch {
    // 文件不存在时忽略
  }
}

export async function hasSession(): Promise<boolean> {
  try {
    await fs.access(SESSION_FILE);
    return true;
  } catch {
    return false;
  }
}
