import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSession,
  listSessions,
  loadSession,
  saveSession,
} from "./session.js";

let sessionDir: string;

describe("session storage", () => {
  beforeEach(async () => {
    sessionDir = await mkdtemp(
      path.join(os.tmpdir(), "mini-claude-session-test-"),
    );
    process.env.MINI_CLAUDE_CODE_SESSION_DIR = sessionDir;
    const sessions = await listSessions();
    await Promise.all(sessions.map((session) => clearSession(session.id)));
    await clearSession();
  });

  afterEach(() => {
    delete process.env.MINI_CLAUDE_CODE_SESSION_DIR;
  });

  it("saves and reloads latest session with metadata", async () => {
    const id = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "分析这个项目" },
      ],
      summaryLines: ["读取了 src/agent/orchestrator.ts"],
      summaryFocus: {
        files: ["src/agent/orchestrator.ts"],
        keywords: ["agent"],
      },
    });

    const loaded = await loadSession();
    expect(loaded?.id).toBe(id);
    expect(loaded?.title).toContain("分析这个项目");
    expect(loaded?.summary).toContain("读取了 src/agent/orchestrator.ts");
    expect(loaded?.turnCount).toBe(1);
  });

  it("lists sessions in updated order", async () => {
    const firstId = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "第一个会话" },
      ],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
    });

    const secondId = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "第二个会话" },
      ],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
    });

    const sessions = await listSessions();
    expect(sessions.map((session) => session.id)).toEqual([secondId, firstId]);
  });

  it("clears a specific session and updates latest pointer", async () => {
    const firstId = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "保留会话" },
      ],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
    });

    const secondId = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "删除会话" },
      ],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
    });

    await clearSession(secondId);

    const latest = await loadSession();
    expect(latest?.id).toBe(firstId);
    expect(await loadSession(secondId)).toBeNull();
  });
});
