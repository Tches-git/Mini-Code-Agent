import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockChat = vi.hoisted(() => vi.fn());

vi.mock("../llm/client.js", () => ({
  LlmClient: class {
    chat = mockChat;
  },
}));

import {
  editProjectMemory,
  editProjectMemoryCandidateText,
  extractProjectMemoryCandidates,
  getProjectMemoryContext,
  normalizeProjectMemory,
  readProjectMemory,
  rememberProjectMemoryFromRun,
  rememberProjectMemoryFromRunWithReview,
  reviewProjectMemoryEdit,
  reviewProjectMemoryUpdate,
  sanitizeMemoryText,
  selectProjectMemoryCandidates,
  updateProjectMemory,
} from "./memory.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "project-memory-test-"));
  process.env.LOCAL_CODE_AGENT_STATE_DIR = tempDir;
  mockChat.mockReset();
});

afterEach(async () => {
  delete process.env.LOCAL_CODE_AGENT_STATE_DIR;
  delete process.env.OPENAI_API_KEY;
  await rm(tempDir, { recursive: true, force: true });
});

describe("project memory", () => {
  it("normalizes whitespace and deduplicates lists", () => {
    expect(
      normalizeProjectMemory({
        overview: "  local agent  ",
        preferences: [" concise ", "concise", ""],
        commands: ["npm test", " npm test "],
      }),
    ).toEqual({
      overview: "local agent",
      preferences: ["concise"],
      commands: ["npm test"],
    });
  });

  it("filters sensitive memory text", () => {
    expect(sanitizeMemoryText("OPENAI_API_KEY=sk-secret")).toBe("");
    expect(sanitizeMemoryText("use concise output")).toBe("use concise output");
    expect(
      normalizeProjectMemory({
        overview: "token abc",
        preferences: ["safe preference", "email test@example.com"],
        commands: ["npm test"],
      }),
    ).toEqual({
      overview: "",
      preferences: ["safe preference"],
      commands: ["npm test"],
    });
  });

  it("persists updates across reads", async () => {
    await updateProjectMemory({
      overview: "Local Code Agent",
      preferences: ["short output"],
      commands: ["npm test"],
    });
    await updateProjectMemory({
      preferences: ["short output", "verify build"],
      commands: ["npm run build"],
    });

    const memory = await readProjectMemory();
    expect(memory.overview).toBe("Local Code Agent");
    expect(memory.preferences).toEqual(["short output", "verify build"]);
    expect(memory.commands).toEqual(["npm test", "npm run build"]);
    expect(memory.updatedAt).toBeDefined();
  });

  it("stores sourced facts with confidence and filters expired or sensitive facts", () => {
    const memory = normalizeProjectMemory({
      facts: [
        {
          text: "uses vitest",
          source: "auto",
          confidence: 0.4,
          updatedAt: new Date().toISOString(),
        },
        {
          text: "uses vitest",
          source: "manual",
          confidence: 0.9,
          updatedAt: new Date().toISOString(),
        },
        {
          text: "email user@example.com",
          source: "manual",
          confidence: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        {
          text: "expired fact",
          source: "auto",
          confidence: 1,
          updatedAt: "2024-01-01T00:00:00.000Z",
          expiresAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });

    expect(memory.facts).toHaveLength(1);
    expect(memory.facts?.[0]).toMatchObject({
      text: "uses vitest",
      source: "manual",
    });
    expect(memory.facts?.[0]?.confidence).toBeGreaterThan(0.8);
    expect(memory.facts?.[0].expiresAt).toBeDefined();
  });

  it("extracts automatic memory candidates from run summaries", () => {
    const candidates = extractProjectMemoryCandidates({
      finalText: "完成，保持 concise 输出。",
      steps: ["自动验证: npm run lint", "自动验证: npm test"],
      modifiedPaths: ["src/tools/memory.ts"],
      validationCommands: ["npm run build"],
    });

    expect(candidates.commands).toEqual([
      "npm run build",
      "npm run lint",
      "npm test",
    ]);
    expect(candidates.preferences).toContain(
      "默认输出保持简洁，优先给出结果和验证状态",
    );
    expect(candidates.facts?.map((fact) => fact.text)).toContain(
      "最近关注文件: src/tools/memory.ts",
    );
  });

  it("supports overview summary and user-editable memory facts", async () => {
    await updateProjectMemory({
      commands: ["npm test"],
      facts: [
        {
          text: "uses TypeScript",
          source: "manual",
          confidence: 0.8,
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    let memory = await readProjectMemory();
    expect(memory.overview).toContain("uses TypeScript");
    const factId = memory.facts?.[0]?.id;
    expect(factId).toBeDefined();

    memory = await editProjectMemory({
      overview: "edited overview",
      removeFactIds: [factId as string],
    });

    expect(memory.overview).toBe("edited overview");
    expect(memory.facts).toBeUndefined();
  });

  it("can clear project memory", async () => {
    await updateProjectMemory({ overview: "local code agent" });

    const memory = await editProjectMemory({ clear: true });

    expect(memory).toMatchObject({
      overview: "",
      preferences: [],
      commands: [],
    });
  });

  it("reviews memory updates with a diff before writing", async () => {
    await updateProjectMemory({ overview: "local code agent" });

    const review = await reviewProjectMemoryUpdate({
      preferences: ["short output"],
    });
    const afterReview = await readProjectMemory();

    expect(review.proposed.preferences).toContain("short output");
    expect(review.diff).toContain("project-memory.json");
    expect(review.diff).toContain("short output");
    expect(afterReview.preferences).toEqual([]);
  });

  it("reviews memory edits with a diff before writing", async () => {
    await updateProjectMemory({
      facts: [
        {
          text: "uses TypeScript",
          source: "manual",
          confidence: 0.8,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const factId = (await readProjectMemory()).facts?.[0]?.id as string;

    const review = await reviewProjectMemoryEdit({ removeFactIds: [factId] });
    const afterReview = await readProjectMemory();

    expect(review.proposed.facts).toBeUndefined();
    expect(review.diff).toContain("uses TypeScript");
    expect(afterReview.facts).toHaveLength(1);
  });

  it("decays old facts and merges conflicts by stable fact id", () => {
    const memory = normalizeProjectMemory({
      facts: [
        {
          text: "最近关注文件: src/tools/memory.ts",
          source: "auto",
          confidence: 0.9,
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
        {
          text: "src/tools/memory.ts",
          source: "manual",
          confidence: 0.6,
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    expect(memory.facts).toHaveLength(1);
    expect(memory.facts?.[0]?.text).toBe("src/tools/memory.ts");
  });

  it("builds selectable automatic memory review items", async () => {
    await updateProjectMemory({
      facts: [
        {
          text: "最近关注文件: src/tools/memory.ts",
          source: "manual",
          confidence: 0.8,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const reviewHandler = vi.fn().mockResolvedValue("reject");

    await rememberProjectMemoryFromRunWithReview(
      {
        finalText: "完成，保持 concise 输出。",
        validationCommands: ["npm test"],
        modifiedPaths: ["src/tools/memory.ts"],
      },
      reviewHandler,
    );

    expect(reviewHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            key: "command:npm test",
            label: "命令: npm test",
          }),
          expect.objectContaining({
            kind: "fact",
            conflict: expect.stringContaining("可能更新已有事实"),
          }),
        ]),
      }),
    );
  });

  it("selects and edits automatic memory candidates", () => {
    const candidates = extractProjectMemoryCandidates({
      finalText: "完成，保持 concise 输出。",
      validationCommands: ["npm test", "npm run build"],
      modifiedPaths: ["src/tools/memory.ts"],
    });
    const edited = editProjectMemoryCandidateText(
      candidates,
      "command:npm test",
      "npm run test:focused",
    );

    expect(
      selectProjectMemoryCandidates(edited, ["command:npm run test:focused"]),
    ).toEqual({
      preferences: [],
      commands: ["npm run test:focused"],
      facts: [],
    });
  });

  it("reviews automatic memory before saving", async () => {
    const reviewHandler = vi.fn().mockResolvedValue("reject");

    const rejected = await rememberProjectMemoryFromRunWithReview(
      {
        finalText: "完成，保持 concise 输出。",
        validationCommands: ["npm test"],
      },
      reviewHandler,
    );
    const afterReject = await readProjectMemory();

    expect(rejected).toBeNull();
    expect(reviewHandler).toHaveBeenCalledWith(
      expect.objectContaining({ diff: expect.stringContaining("npm test") }),
    );
    expect(afterReject.commands).toEqual([]);

    const accepted = await rememberProjectMemoryFromRunWithReview(
      {
        finalText: "完成，保持 concise 输出。",
        validationCommands: ["npm test"],
      },
      vi.fn().mockResolvedValue("accept"),
    );

    expect(accepted?.commands).toContain("npm test");
    expect((await readProjectMemory()).commands).toContain("npm test");
  });

  it("allows editing automatic memory during review", async () => {
    await rememberProjectMemoryFromRunWithReview(
      {
        finalText: "完成，保持 concise 输出。",
        validationCommands: ["npm test"],
      },
      vi.fn().mockResolvedValue({ update: { overview: "reviewed overview" } }),
    );

    const memory = await readProjectMemory();

    expect(memory.overview).toBe("reviewed overview");
    expect(memory.commands).toEqual([]);
  });

  it("uses LLM summary when env is configured", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockChat.mockResolvedValue({
      text: "TypeScript CLI，常用 npm test 验证，偏好简洁输出。",
      toolCalls: [],
    });

    const memory = await rememberProjectMemoryFromRun({
      finalText: "完成，保持 concise 输出。",
      validationCommands: ["npm test"],
      modifiedPaths: ["src/tools/memory.ts"],
    });

    expect(mockChat).toHaveBeenCalled();
    expect(memory?.overview).toBe(
      "TypeScript CLI，常用 npm test 验证，偏好简洁输出。",
    );
  });

  it("builds concise project memory context", async () => {
    await updateProjectMemory({
      overview: "local code agent",
      preferences: ["short output"],
      commands: ["npm test"],
      facts: [
        {
          text: "uses TypeScript",
          source: "manual",
          confidence: 0.8,
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const context = await getProjectMemoryContext();
    expect(context).toContain("项目长期记忆");
    expect(context).toContain("local code agent");
    expect(context).toContain("uses TypeScript");
  });
});
