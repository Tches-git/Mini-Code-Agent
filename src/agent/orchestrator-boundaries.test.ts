import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("architecture boundaries", () => {
  it("removes interactive backup file from src", () => {
    const backupPath = fileURLToPath(
      new URL("../cli/interactive.ts.bak", import.meta.url),
    );
    expect(existsSync(backupPath)).toBe(false);
  });

  it("keeps logger facade as a re-export entry", () => {
    const loggerPath = fileURLToPath(
      new URL("../utils/logger.ts", import.meta.url),
    );
    const source = readFileSync(loggerPath, "utf8").trim();
    expect(source).toBe('export * from "./logger/index.js";');
  });
});
