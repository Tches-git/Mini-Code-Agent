import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccess = vi.hoisted(() => vi.fn());
const mockMkdtemp = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockExeca = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  access: mockAccess,
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  rm: mockRm,
  writeFile: mockWriteFile,
}));

vi.mock("execa", () => ({
  execa: mockExeca,
}));

describe("buildStandaloneExecutable", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockAccess.mockReset().mockResolvedValue(undefined);
    mockMkdtemp.mockReset().mockResolvedValue("/tmp/sea-work");
    mockReadFile.mockReset().mockImplementation(async (target: string) => {
      if (target === "/project/package.json") {
        return JSON.stringify({ name: "local-code-agent", version: "0.1.0" });
      }
      throw new Error(`Unexpected readFile: ${target}`);
    });
    mockRm.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockExeca.mockReset().mockResolvedValue({});
  });

  it("builds standalone output with node build-sea", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/project");
    Object.defineProperty(process, "execPath", {
      value: "/mock/node",
      configurable: true,
    });
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "x64",
      configurable: true,
    });

    const { buildStandaloneExecutable } = await import("./standalone.js");
    const result = await buildStandaloneExecutable();

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("esbuild"),
      expect.arrayContaining(["./dist/cli/index.js", "--bundle"]),
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      "/mock/node",
      [expect.stringContaining("--build-sea=/tmp/sea-work/sea-config.json")],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/sea-work/sea-config.json",
      expect.stringContaining(
        '"output": "/project/dist/standalone/local-code-agent"',
      ),
      "utf8",
    );
    expect(result.outputPath).toBe("/project/dist/standalone/local-code-agent");
    expect(result.artifactFileName).toBe("local-code-agent-linux-x64");
  });

  it("surfaces unsupported node binary as a friendly error", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/project");
    Object.defineProperty(process, "execPath", {
      value: "/mock/node",
      configurable: true,
    });
    mockExeca
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new Error("Error: sentinel NODE_SEA_FUSE_x not found"),
      );

    const { buildStandaloneExecutable } = await import("./standalone.js");

    await expect(buildStandaloneExecutable()).rejects.toThrow(
      "当前 Node.js 可执行文件不支持 SEA standalone 构建",
    );
  });
});
