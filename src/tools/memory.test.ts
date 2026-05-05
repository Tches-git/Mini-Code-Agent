import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeProjectMemory,
  readProjectMemory,
  sanitizeMemoryText,
  updateProjectMemory,
} from "./memory.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "project-memory-test-"));
  process.env.MINI_CLAUDE_CODE_STATE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.MINI_CLAUDE_CODE_STATE_DIR;
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
      overview: "Mini Claude Code",
      preferences: ["short output"],
      commands: ["npm test"],
    });
    await updateProjectMemory({
      preferences: ["short output", "verify build"],
      commands: ["npm run build"],
    });

    const memory = await readProjectMemory();
    expect(memory.overview).toBe("Mini Claude Code");
    expect(memory.preferences).toEqual(["short output", "verify build"]);
    expect(memory.commands).toEqual(["npm test", "npm run build"]);
    expect(memory.updatedAt).toBeDefined();
  });
});
