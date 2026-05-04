import { promises as fs } from "node:fs";
import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBiomeJsonOutput,
  parseBiomeTextOutput,
  parseEslintJsonOutput,
  parseTscDiagnostics,
  readLintDiagnostics,
  readTypeScriptDiagnostics,
} from "./diagnostics.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("parseTscDiagnostics", () => {
  it("parses standard tsc diagnostics", () => {
    const diagnostics = parseTscDiagnostics(
      [
        "src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/app.ts(8,2): warning TS9999: Example warning.",
      ].join("\n"),
    );

    expect(diagnostics).toEqual([
      {
        file: "src/index.ts",
        line: 3,
        column: 14,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        source: "tsc",
      },
      {
        file: "src/app.ts",
        line: 8,
        column: 2,
        severity: "warning",
        code: "TS9999",
        message: "Example warning.",
        source: "tsc",
      },
    ]);
  });
});

describe("parseBiomeJsonOutput", () => {
  it("parses biome json reporter output", () => {
    const diagnostics = parseBiomeJsonOutput(
      JSON.stringify({
        diagnostics: {
          diagnostics: [
            {
              category: "lint/style/useTemplate",
              severity: "error",
              description: "Use a template literal.",
              location: {
                path: {
                  file: "/workspace/src/example.ts",
                },
              },
            },
          ],
        },
      }),
    );

    expect(diagnostics).toEqual([
      {
        file: "/workspace/src/example.ts",
        severity: "error",
        message: "Use a template literal.",
        source: "biome",
        code: "lint/style/useTemplate",
      },
    ]);
  });
});

describe("parseBiomeTextOutput", () => {
  it("parses fallback text output", () => {
    const diagnostics = parseBiomeTextOutput(
      "src/example.ts:12:4 error noDebugger Debugger statements are not allowed.",
    );

    expect(diagnostics).toEqual([
      {
        file: "src/example.ts",
        line: 12,
        column: 4,
        severity: "error",
        message:
          "src/example.ts:12:4 error noDebugger Debugger statements are not allowed.",
        source: "biome",
      },
    ]);
  });
});

describe("parseEslintJsonOutput", () => {
  it("parses eslint json formatter output", () => {
    const diagnostics = parseEslintJsonOutput(
      JSON.stringify([
        {
          filePath: "/workspace/src/example.ts",
          messages: [
            {
              line: 7,
              column: 3,
              severity: 2,
              message: "Unexpected console statement.",
              ruleId: "no-console",
            },
          ],
        },
      ]),
    );

    expect(diagnostics).toEqual([
      {
        file: "/workspace/src/example.ts",
        line: 7,
        column: 3,
        severity: "error",
        message: "Unexpected console statement.",
        source: "eslint",
        code: "no-console",
      },
    ]);
  });
});

describe("readTypeScriptDiagnostics", () => {
  it("prefers project typecheck script when present", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "tsc" } }),
    );
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (String(target).endsWith("package-lock.json")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.mocked(execa).mockResolvedValue({
      stdout:
        "src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      stderr: "",
      failed: false,
      code: 0,
    } as never);

    const result = await readTypeScriptDiagnostics();

    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      "npm",
      ["run", "typecheck"],
      expect.any(Object),
    );
    expect(result.command).toBe("npm run typecheck");
  });
});

describe("readLintDiagnostics", () => {
  it("prefers npm run lint when lint script exists", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({ scripts: { lint: "biome check ." } }),
    );
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify({ diagnostics: { diagnostics: [] } }),
      stderr: "",
      failed: false,
      code: 0,
    } as never);

    const result = await readLintDiagnostics();

    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      "npm",
      ["run", "lint", "--", "--reporter", "json"],
      expect.any(Object),
    );
    expect(result.command).toBe("npm run lint -- --reporter json");
  });

  it("uses eslint json formatting for eslint-based lint scripts", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify([
        {
          filePath: "/workspace/src/example.ts",
          messages: [
            {
              line: 7,
              column: 3,
              severity: 2,
              message: "Unexpected console statement.",
              ruleId: "no-console",
            },
          ],
        },
      ]),
      stderr: "",
      failed: false,
      code: 0,
    } as never);

    const result = await readLintDiagnostics();

    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      "npm",
      ["run", "lint", "--", "--format", "json"],
      expect.any(Object),
    );
    expect(result.command).toBe("npm run lint -- --format json");
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        source: "eslint",
        code: "no-console",
      }),
    );
  });

  it("uses detected package manager and check script when lint is absent", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({ scripts: { check: "biome check ." } }),
    );
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (String(target).endsWith("pnpm-lock.yaml")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify({ diagnostics: { diagnostics: [] } }),
      stderr: "",
      failed: false,
      code: 0,
    } as never);

    const result = await readLintDiagnostics();

    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      "pnpm",
      ["run", "check", "--", "--reporter", "json"],
      expect.any(Object),
    );
    expect(result.command).toBe("pnpm run check -- --reporter json");
  });

  it("falls back to biome check . when lint script is missing", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify({ diagnostics: { diagnostics: [] } }),
      stderr: "",
      failed: false,
      code: 0,
    } as never);

    const result = await readLintDiagnostics();

    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      "biome",
      ["check", ".", "--reporter", "json"],
      expect.any(Object),
    );
    expect(result.command).toBe("biome check . --reporter json");
  });

  it("supports custom diagnostics script names from package.json config", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        scripts: { static: "eslint .", verify: "tsc --noEmit" },
        miniClaudeCode: {
          diagnostics: {
            lintScripts: ["static"],
            typecheckScripts: ["verify"],
          },
        },
      }),
    );
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify([]),
      stderr: "",
      failed: false,
      code: 0,
    } as never);

    const lintResult = await readLintDiagnostics();
    const typeResult = await readTypeScriptDiagnostics();

    expect(lintResult.command).toBe("npm run static -- --format json");
    expect(typeResult.command).toBe("npm run verify");
  });
});
