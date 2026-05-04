import { promises as fs } from "node:fs";
import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandTools,
  getCommandErrorSummary,
  getLastCommandOutputPage,
  getPreferredOutputStream,
  getRunCommandPolicy,
  isCommandTimeoutResult,
  paginateCommandOutput,
} from "./command.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const getTool = (name: string) => {
  const tool = commandTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
};

const FAKE_PACKAGE_JSON = JSON.stringify({
  scripts: {
    dev: "tsx src/cli/index.ts",
    chat: "tsx src/cli/index.ts -i",
    build: "tsc -p tsconfig.json",
    start: "node dist/cli/index.js",
    "start:chat": "node dist/cli/index.js -i",
    test: "vitest run",
    "test:watch": "vitest",
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(fs, "readFile").mockResolvedValue(FAKE_PACKAGE_JSON);
  vi.mocked(execa).mockReset();
});

describe("paginateCommandOutput", () => {
  it("按行分页并给出 nextOffset", () => {
    expect(paginateCommandOutput("a\nb\nc", 1, 1)).toEqual({
      text: "b",
      totalLines: 3,
      startLine: 2,
      endLine: 2,
      truncated: true,
      nextOffset: 2,
    });
  });

  it("空输出返回空页", () => {
    expect(paginateCommandOutput("", 0, 10)).toEqual({
      text: "",
      totalLines: 0,
      startLine: 0,
      endLine: 0,
      truncated: false,
      nextOffset: undefined,
    });
  });
});

describe("command output follow-up", () => {
  it("失败命令提取关键错误段", () => {
    expect(
      getCommandErrorSummary(1, "warning\nError: boom\nstack", "ignored"),
    ).toBe("Error: boom");
  });

  it("失败时优先展示 stderr", () => {
    expect(getPreferredOutputStream(1, "stdout", "stderr")).toBe("stderr");
    expect(getPreferredOutputStream(0, "stdout", "stderr")).toBe("stdout");
  });

  it("识别命令超时结果", () => {
    expect(isCommandTimeoutResult({ timedOut: true })).toBe(true);
    expect(isCommandTimeoutResult({ signal: "SIGTERM" })).toBe(true);
  });

  it("可读取上一次命令输出后续页", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      failed: false,
      code: 0,
      exitCode: 0,
      stdout: "a\nb\nc",
      stderr: "e1\ne2",
    } as never);

    await getTool("run_command").execute({ command: "ls", outputLimit: 1 });
    const result = JSON.parse(
      getLastCommandOutputPage({
        stream: "stdout",
        outputOffset: 1,
        outputLimit: 1,
      }),
    );

    expect(result.output).toBe("b");
    expect(result.page.nextOffset).toBe(2);
  });
});

describe("run_command tool", () => {
  it("返回分页后的 stdout/stderr 和分页元数据", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      failed: false,
      code: 0,
      exitCode: 1,
      stdout: "out1\nout2\nout3",
      stderr: "err1\nerr2\nerr3",
    } as never);

    const raw = await getTool("run_command").execute({
      command: "ls",
      outputOffset: 1,
      outputLimit: 1,
    });
    const result = JSON.parse(String(raw));

    expect(result.stdout).toBe("out2");
    expect(result.stderr).toBe("err2");
    expect(result.stdoutPage).toMatchObject({
      totalLines: 3,
      startLine: 2,
      endLine: 2,
      truncated: true,
      nextOffset: 2,
    });
    expect(result.nextPageHint).toContain("read_command_output");
  });

  it("失败命令返回 errorSummary", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      failed: false,
      code: 0,
      exitCode: 1,
      stdout: "",
      stderr: "warning\nError: failed build",
    } as never);

    const raw = await getTool("run_command").execute({ command: "ls" });
    const result = JSON.parse(String(raw));

    expect(result.errorSummary).toBe("Error: failed build");
    expect(result.preferredStream).toBe("stderr");
    expect(result.preferredOutput).toBe("warning\nError: failed build");
  });

  it("超时命令返回部分输出与原因", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      code: 0,
      exitCode: null,
      timedOut: true,
      stdout: "partial out",
      stderr: "partial err",
    } as never);

    const raw = await getTool("run_command").execute({ command: "ls" });
    const result = JSON.parse(String(raw));

    expect(result.timedOut).toBe(true);
    expect(result.failureReason).toContain("命令超时");
    expect(result.stdout).toBe("partial out");
    expect(result.stderr).toBe("partial err");
  });
});

describe("getRunCommandPolicy", () => {
  describe("blocked commands", () => {
    it("blocks shell syntax (&&)", async () => {
      const result = await getRunCommandPolicy("echo hello && echo world");
      expect(result.decision).toBe("block");
    });

    it("blocks shell syntax (pipe)", async () => {
      const result = await getRunCommandPolicy("ls | grep foo");
      expect(result.decision).toBe("block");
    });

    it("blocks shell syntax (semicolon)", async () => {
      const result = await getRunCommandPolicy("echo a; echo b");
      expect(result.decision).toBe("block");
    });

    it("blocks shell syntax (backtick)", async () => {
      const result = await getRunCommandPolicy("echo `whoami`");
      expect(result.decision).toBe("block");
    });

    it("blocks shell syntax (redirect)", async () => {
      const result = await getRunCommandPolicy("echo hello > file.txt");
      expect(result.decision).toBe("block");
    });

    it("blocks rm -rf /", async () => {
      const result = await getRunCommandPolicy("rm -rf /");
      expect(result.decision).toBe("block");
    });

    it("blocks rm -rf ~", async () => {
      const result = await getRunCommandPolicy("rm -rf ~");
      expect(result.decision).toBe("block");
    });

    it("blocks git reset --hard", async () => {
      const result = await getRunCommandPolicy("git reset --hard");
      expect(result.decision).toBe("block");
    });

    it("blocks git clean -fd", async () => {
      const result = await getRunCommandPolicy("git clean -fd");
      expect(result.decision).toBe("block");
    });

    it("blocks git push --force", async () => {
      const result = await getRunCommandPolicy("git push --force");
      expect(result.decision).toBe("block");
    });

    it("blocks blocked executables (sudo)", async () => {
      const result = await getRunCommandPolicy("sudo ls");
      expect(result.decision).toBe("block");
    });

    it("blocks blocked executables (rm)", async () => {
      const result = await getRunCommandPolicy("rm file.txt");
      expect(result.decision).toBe("block");
    });

    it("blocks blocked executables (shutdown)", async () => {
      const result = await getRunCommandPolicy("shutdown now");
      expect(result.decision).toBe("block");
    });

    it("blocks network executables (curl)", async () => {
      const result = await getRunCommandPolicy("curl https://example.com");
      expect(result.decision).toBe("block");
    });

    it("blocks network executables (wget)", async () => {
      const result = await getRunCommandPolicy("wget https://example.com");
      expect(result.decision).toBe("block");
    });

    it("blocks network executables (ssh)", async () => {
      const result = await getRunCommandPolicy("ssh user@host");
      expect(result.decision).toBe("block");
    });

    it("blocks unknown executables", async () => {
      const result = await getRunCommandPolicy("unknown-binary --flag");
      expect(result.decision).toBe("block");
    });

    it("blocks unknown git subcommands", async () => {
      const result = await getRunCommandPolicy("git bisect");
      expect(result.decision).toBe("block");
    });

    it("blocks npm run without script name", async () => {
      const result = await getRunCommandPolicy("npm run");
      expect(result.decision).toBe("block");
    });

    it("blocks npm run with nonexistent script", async () => {
      const result = await getRunCommandPolicy("npm run nonexistent");
      expect(result.decision).toBe("block");
    });

    it("blocks unknown package manager subcommands", async () => {
      const result = await getRunCommandPolicy("npm publish");
      expect(result.decision).toBe("block");
    });

    it("blocks npm test when project has no test script", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ scripts: { build: "tsc -p tsconfig.json" } }),
      );
      const result = await getRunCommandPolicy("npm test");
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("test");
    });
  });

  describe("allowed commands", () => {
    it("allows safe executables (ls)", async () => {
      const result = await getRunCommandPolicy("ls -la");
      expect(result.decision).toBe("allow");
      expect(result.executable).toBe("ls");
    });

    it("allows safe executables (cat)", async () => {
      const result = await getRunCommandPolicy("cat file.txt");
      expect(result.decision).toBe("allow");
      expect(result.executable).toBe("cat");
    });

    it("allows safe executables (rg)", async () => {
      const result = await getRunCommandPolicy("rg pattern src/");
      expect(result.decision).toBe("allow");
      expect(result.executable).toBe("rg");
    });

    it("allows safe toolchain executables (tsc)", async () => {
      const result = await getRunCommandPolicy("tsc --noEmit");
      expect(result.decision).toBe("allow");
      expect(result.executable).toBe("tsc");
    });

    it("allows safe toolchain executables (vitest)", async () => {
      const result = await getRunCommandPolicy("vitest run");
      expect(result.decision).toBe("allow");
      expect(result.executable).toBe("vitest");
    });

    it("allows safe git subcommands (status)", async () => {
      const result = await getRunCommandPolicy("git status");
      expect(result.decision).toBe("allow");
      expect(result.executable).toBe("git");
    });

    it("allows safe git subcommands (log)", async () => {
      const result = await getRunCommandPolicy("git log --oneline");
      expect(result.decision).toBe("allow");
    });

    it("allows safe git subcommands (diff)", async () => {
      const result = await getRunCommandPolicy("git diff");
      expect(result.decision).toBe("allow");
    });

    it("allows bare git (help)", async () => {
      const result = await getRunCommandPolicy("git");
      expect(result.decision).toBe("allow");
    });

    it("allows npm run build (safe script)", async () => {
      const result = await getRunCommandPolicy("npm run build");
      expect(result.decision).toBe("allow");
    });

    it("allows npm run test (safe script)", async () => {
      const result = await getRunCommandPolicy("npm run test");
      expect(result.decision).toBe("allow");
    });

    it("allows npm test", async () => {
      const result = await getRunCommandPolicy("npm test");
      expect(result.decision).toBe("allow");
    });

    it("allows pnpm test when project test script is safe", async () => {
      const result = await getRunCommandPolicy("pnpm test");
      expect(result.decision).toBe("allow");
    });

    it("allows npm run test with forwarded file args", async () => {
      const result = await getRunCommandPolicy(
        "npm run test -- src/utils/token.test.ts",
      );
      expect(result.decision).toBe("allow");
    });

    it("allows npm run test with jest targeted flags", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({
          scripts: {
            ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
            test: "jest --runInBand",
          },
        }),
      );
      const result = await getRunCommandPolicy(
        "npm run test -- --runTestsByPath src/utils/token.test.ts",
      );
      expect(result.decision).toBe("allow");
    });

    it("guards npm run lint with forwarded --fix", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({
          scripts: {
            ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
            lint: "eslint .",
          },
        }),
      );
      const result = await getRunCommandPolicy("npm run lint -- --fix");
      expect(result.decision).toBe("confirm");
    });

    it("allows nested safe package scripts", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({
          scripts: {
            ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
            verify: "npm run test",
          },
        }),
      );
      const result = await getRunCommandPolicy("npm run verify");
      expect(result.decision).toBe("confirm");
    });

    it("blocks nested package scripts that reference missing scripts", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({
          scripts: {
            ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
            verify: "npm run missing-script",
          },
        }),
      );
      const result = await getRunCommandPolicy("npm run verify");
      expect(result.decision).toBe("confirm");
    });

    it("guards nested package scripts that install dependencies", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({
          scripts: {
            ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
            bootstrap: "pnpm install",
          },
        }),
      );
      const result = await getRunCommandPolicy("npm run bootstrap");
      expect(result.decision).toBe("confirm");
    });

    it("guards npm test with snapshot update flag", async () => {
      const result = await getRunCommandPolicy("npm test -- -u");
      expect(result.decision).toBe("confirm");
    });

    it("allows bare package manager (help)", async () => {
      const result = await getRunCommandPolicy("npm");
      expect(result.decision).toBe("allow");
    });
  });

  it("allows custom safe script names from package.json config", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        scripts: {
          ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
          verify: "eslint .",
        },
        miniClaudeCode: {
          commandPolicy: {
            safeScripts: ["verify"],
          },
        },
      }),
    );
    const result = await getRunCommandPolicy("npm run verify");
    expect(result.decision).toBe("allow");
  });

  it("guards custom guarded script names from package.json config", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        scripts: {
          ...JSON.parse(FAKE_PACKAGE_JSON).scripts,
          sandbox: "node script.js",
        },
        miniClaudeCode: {
          commandPolicy: {
            guardedScripts: ["sandbox"],
          },
        },
      }),
    );
    const result = await getRunCommandPolicy("npm run sandbox");
    expect(result.decision).toBe("confirm");
  });

  describe("guarded commands (confirm)", () => {
    it("guards git push", async () => {
      const result = await getRunCommandPolicy("git push");
      expect(result.decision).toBe("confirm");
    });

    it("guards git commit", async () => {
      const result = await getRunCommandPolicy("git commit -m message");
      expect(result.decision).toBe("confirm");
    });

    it("guards git add", async () => {
      const result = await getRunCommandPolicy("git add .");
      expect(result.decision).toBe("confirm");
    });

    it("guards git checkout", async () => {
      const result = await getRunCommandPolicy("git checkout main");
      expect(result.decision).toBe("confirm");
    });

    it("guards git rebase", async () => {
      const result = await getRunCommandPolicy("git rebase main");
      expect(result.decision).toBe("confirm");
    });

    it("guards npm install", async () => {
      const result = await getRunCommandPolicy("npm install");
      expect(result.decision).toBe("confirm");
      expect(result.executable).toBe("npm");
    });

    it("guards pnpm add", async () => {
      const result = await getRunCommandPolicy("pnpm add lodash");
      expect(result.decision).toBe("confirm");
    });

    it("guards npm run dev (guarded script)", async () => {
      const result = await getRunCommandPolicy("npm run dev");
      expect(result.decision).toBe("confirm");
    });

    it("guards npm run start (guarded script)", async () => {
      const result = await getRunCommandPolicy("npm run start");
      expect(result.decision).toBe("confirm");
    });

    it("guards npm run with custom script (chat)", async () => {
      const result = await getRunCommandPolicy("npm run chat");
      expect(result.decision).toBe("confirm");
    });

    it("guards npx", async () => {
      const result = await getRunCommandPolicy("npx something");
      expect(result.decision).toBe("confirm");
      expect(result.executable).toBe("npx");
    });

    it("guards node", async () => {
      const result = await getRunCommandPolicy("node script.js");
      expect(result.decision).toBe("confirm");
      expect(result.executable).toBe("node");
    });

    it("guards tsx", async () => {
      const result = await getRunCommandPolicy("tsx script.ts");
      expect(result.decision).toBe("confirm");
      expect(result.executable).toBe("tsx");
    });

    it("guards workspace scripts with path", async () => {
      const result = await getRunCommandPolicy("./scripts/deploy.sh");
      expect(result.decision).toBe("confirm");
    });
  });

  describe("edge cases", () => {
    it("blocks empty command", async () => {
      const result = await getRunCommandPolicy("");
      expect(result.decision).toBe("block");
    });

    it("blocks whitespace-only command", async () => {
      const result = await getRunCommandPolicy("   ");
      expect(result.decision).toBe("block");
    });

    it("blocks overly long command (>2000 chars)", async () => {
      const longCommand = `ls ${"a".repeat(2000)}`;
      const result = await getRunCommandPolicy(longCommand);
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("2000");
    });

    it("blocks unclosed single quote", async () => {
      const result = await getRunCommandPolicy("echo 'hello");
      expect(result.decision).toBe("block");
    });

    it("blocks unclosed double quote", async () => {
      const result = await getRunCommandPolicy('echo "hello');
      expect(result.decision).toBe("block");
    });

    it("handles command with leading/trailing whitespace", async () => {
      const result = await getRunCommandPolicy("  ls -la  ");
      expect(result.decision).toBe("allow");
    });

    it("handles package.json read failure gracefully", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      const result = await getRunCommandPolicy("npm run build");
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("build");
    });
  });
});
