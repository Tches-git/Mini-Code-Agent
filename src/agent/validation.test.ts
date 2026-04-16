import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFailurePrompt,
  getDiagnosticsForValidationCommand,
  getValidationPlan,
  isValidationCommand,
  parseCommandResult,
} from "./validation.js";

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.npm_config_user_agent;
});

describe("validation helpers", () => {
  it("parseCommandResult 能解析 JSON 字符串", () => {
    expect(
      parseCommandResult('{"command":"npm run build","exitCode":1}'),
    ).toEqual({ command: "npm run build", exitCode: 1 });
  });

  it("parseCommandResult 遇到非法 JSON 返回 null", () => {
    expect(parseCommandResult("not-json")).toBeNull();
  });

  it("buildFailurePrompt 会包含命令、退出码和输出", () => {
    const prompt = buildFailurePrompt(
      {
        command: "npm run build",
        exitCode: 2,
        stdout: "out",
        stderr: "err",
      },
      {
        command: "tsc -p tsconfig.json --pretty false --noEmit",
        truncated: false,
        diagnostics: [
          {
            file: "src/index.ts",
            line: 3,
            column: 14,
            severity: "error",
            message: "Type 'string' is not assignable to type 'number'.",
            source: "tsc",
            code: "TS2322",
          },
        ],
      },
    );
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("退出码: 2");
    expect(prompt).toContain("stdout:");
    expect(prompt).toContain("stderr:");
    expect(prompt).toContain("diagnostics:");
    expect(prompt).toContain("TS2322");
  });

  it("isValidationCommand 能识别验证命令", () => {
    expect(isValidationCommand("npm run test")).toBe(true);
    expect(isValidationCommand("eslint")).toBe(true);
    expect(isValidationCommand("npm run dev")).toBe(false);
  });
});

describe("getDiagnosticsForValidationCommand", () => {
  it("returns diagnostics for build-like commands", async () => {
    const diagnosticsModule = await import("../tools/diagnostics.js");
    vi.spyOn(diagnosticsModule, "readTypeScriptDiagnostics").mockResolvedValue({
      command: "tsc -p tsconfig.json --pretty false --noEmit",
      truncated: false,
      diagnostics: [],
    });

    const result = await getDiagnosticsForValidationCommand("npm run build");
    expect(result?.command).toContain("tsc");
  });

  it("returns null for unsupported commands", async () => {
    const result = await getDiagnosticsForValidationCommand("npm run test");
    expect(result).toBeNull();
  });
});

describe("getValidationPlan", () => {
  it("仅修改文档时跳过自动验证", async () => {
    const plan = await getValidationPlan(["README.md"]);
    expect(plan.commands).toEqual([]);
    expect(plan.reason).toContain("跳过自动验证");
  });

  it("修改源码时优先选择 lint/build", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        scripts: { lint: "eslint .", build: "tsc", test: "vitest run" },
      }),
    );
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (String(target).endsWith("package-lock.json")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const plan = await getValidationPlan(["src/index.ts"]);
    expect(plan.commands).toEqual(["npm run lint", "npm run build"]);
  });

  it("修改配置时执行完整验证", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        scripts: { lint: "eslint .", build: "tsc", test: "vitest run" },
      }),
    );
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (String(target).endsWith("package-lock.json")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const plan = await getValidationPlan(["package.json"]);
    expect(plan.commands).toEqual([
      "npm run lint",
      "npm run test",
      "npm run build",
    ]);
  });

  it("占位 test 脚本会被忽略", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        scripts: {
          lint: "eslint .",
          build: "tsc",
          test: "echo no test specified && exit 1",
        },
      }),
    );
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const plan = await getValidationPlan(["src/index.ts", "src/index.test.ts"]);
    expect(plan.commands).toEqual(["pnpm run lint", "pnpm run build"]);
  });

  it("package.json 不可读时回退默认构建命令", async () => {
    process.env.npm_config_user_agent = "npm/10.0.0";
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));
    vi.spyOn(fs, "access").mockRejectedValue(new Error("ENOENT"));
    const plan = await getValidationPlan(["src/index.ts"]);
    expect(plan.commands).toEqual(["npm run build"]);
    expect(plan.reason).toContain("默认构建验证");
  });
});
