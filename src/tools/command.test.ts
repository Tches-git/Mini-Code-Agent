import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRunCommandPolicy } from "./command.js";

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

    it("allows bare package manager (help)", async () => {
      const result = await getRunCommandPolicy("npm");
      expect(result.decision).toBe("allow");
    });
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
