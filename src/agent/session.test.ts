import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRelevantSessionContextMessage,
  clearSession,
  findRelevantSessionContext,
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
    expect(loaded?.version).toBe(2);
    expect(loaded?.title).toContain("分析这个项目");
    expect(loaded?.summary).toContain("读取了 src/agent/orchestrator.ts");
    expect(loaded?.turnCount).toBe(1);
    expect(
      loaded?.contextEntries?.some((entry) =>
        entry.text.includes("orchestrator.ts"),
      ),
    ).toBe(true);
  });

  it("indexes and retrieves relevant historical context by file and task", async () => {
    const id = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "修复 src/tools/search.ts 的引用分析" },
      ],
      summaryLines: ["文件操作: read_file src/tools/search.ts"],
      summaryFocus: {
        files: ["src/tools/search.ts"],
        keywords: ["semantic_find", "references"],
      },
      tasks: [{ id: 3, title: "验证 search 引用分析", status: "blocked" }],
    });

    const byFile = await findRelevantSessionContext({
      queryText: "继续修复 src/tools/search.ts references",
    });
    expect(byFile.some((entry) => entry.sessionId === id)).toBe(true);

    const byTask = await findRelevantSessionContext({ taskIds: [3] });
    expect(byTask[0]?.text).toContain("任务 3");

    const message = buildRelevantSessionContextMessage(byFile.slice(0, 1));
    expect(message?.content).toContain("[相关历史上下文]");
  });

  it("persists task graph items with sessions", async () => {
    const id = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "修复问题" },
      ],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
      tasks: [
        { id: 1, title: "修复问题", status: "done" },
        { id: 2, title: "验证", status: "blocked", note: "测试失败" },
      ],
    });

    const loaded = await loadSession(id);
    expect(loaded?.tasks).toEqual([
      { id: 1, title: "修复问题", status: "done" },
      { id: 2, title: "验证", status: "blocked", note: "测试失败" },
    ]);
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

  it("repairs latest pointer when latest session file is missing", async () => {
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

    await writeFile(path.join(sessionDir, "latest.txt"), secondId, "utf8");
    await unlink(path.join(sessionDir, `${secondId}.json`));

    const latest = await loadSession();
    expect(latest?.id).toBe(firstId);
    await expect(
      readFile(path.join(sessionDir, "latest.txt"), "utf8"),
    ).resolves.toContain(firstId);
  });

  it("filters invalid entries from session index", async () => {
    const validId = await saveSession({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "有效会话" },
      ],
      summaryLines: [],
      summaryFocus: { files: [], keywords: [] },
    });

    await writeFile(
      path.join(sessionDir, "index.json"),
      JSON.stringify([
        {
          id: validId,
          title: "有效会话",
          summary: "ok",
          latestUserMessage: "hi",
          createdAt: "2026-04-20",
          updatedAt: "2026-04-20",
          turnCount: 1,
        },
        { title: "损坏条目" },
      ]),
      "utf8",
    );

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(validId);
  });
});
