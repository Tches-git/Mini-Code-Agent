import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

const DEFAULT_OUTPUT_DIR = path.join("dist", "standalone");
const DEFAULT_EXECUTABLE_NAME = "mini-claude-code";

function getExecutableExtension(): string {
  return process.platform === "win32" ? ".exe" : "";
}

type PackageJson = {
  name?: string;
  version?: string;
};

type StandaloneBuildOptions = {
  outputDir?: string;
  executableName?: string;
};

type StandaloneBuildResult = {
  outputPath: string;
  configPath: string;
  artifactFileName: string;
};

async function findEsbuildBinary(): Promise<string> {
  const candidates = [
    path.resolve("node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild"),
    path.resolve("node_modules", "esbuild", "bin", "esbuild"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error("未找到 esbuild 可执行文件，请先运行 npm install。");
}

async function readPackageMetadata(): Promise<PackageJson> {
  return JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as PackageJson;
}

function getOutputPath(outputDir: string, executableName: string): string {
  return path.join(outputDir, `${executableName}${getExecutableExtension()}`);
}

async function buildJavaScriptBundle(tempDir: string, version: string): Promise<string> {
  const bundlePath = path.join(tempDir, "cli-bundle.cjs");
  const esbuildBinary = await findEsbuildBinary();
  await execa(
    esbuildBinary,
    [
      "./dist/cli/index.js",
      "--bundle",
      "--platform=node",
      "--target=node22",
      "--format=cjs",
      `--outfile=${bundlePath}`,
      `--banner:js=process.env.MINI_CLAUDE_CODE_STANDALONE=\"1\";process.env.MINI_CLAUDE_CODE_VERSION=${JSON.stringify(version)};`,
    ],
    { stdio: "inherit" },
  );
  return bundlePath;
}

async function writeSeaConfig(
  tempDir: string,
  bundlePath: string,
  outputPath: string,
): Promise<string> {
  const seaConfigPath = path.join(tempDir, "sea-config.json");
  await writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: outputPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
    "utf8",
  );
  return seaConfigPath;
}

async function buildStandaloneBinary(configPath: string): Promise<void> {
  try {
    await execa(process.execPath, [`--build-sea=${configPath}`], {
      stdio: "inherit",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("sentinel") && message.includes("not found")) {
      throw new Error(
        "当前 Node.js 可执行文件不支持 SEA standalone 构建；请改用官方 Node.js 发行版，或在 GitHub Actions setup-node 环境中构建。",
      );
    }
    if (message.includes("import.meta") && message.includes("cjs")) {
      throw new Error("standalone 打包失败：当前 bundle 仍依赖 import.meta，请先消除该运行时路径依赖。");
    }
    throw error;
  }
}

function getPlatformArtifactFileName(baseName: string): string {
  return `${baseName}-${process.platform}-${process.arch}${getExecutableExtension()}`;
}

export async function buildStandaloneExecutable(
  options?: StandaloneBuildOptions,
): Promise<StandaloneBuildResult> {
  const packageJson = await readPackageMetadata();
  const outputDir = path.resolve(options?.outputDir || DEFAULT_OUTPUT_DIR);
  const executableName =
    options?.executableName || packageJson.name || DEFAULT_EXECUTABLE_NAME;
  const outputPath = getOutputPath(outputDir, executableName);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mini-claude-code-sea-"));
  const artifactFileName = getPlatformArtifactFileName(executableName);

  try {
    const version = packageJson.version || "0.0.0";
    const bundlePath = await buildJavaScriptBundle(tempDir, version);
    const configPath = await writeSeaConfig(tempDir, bundlePath, outputPath);
    await buildStandaloneBinary(configPath);
    await access(outputPath);
    return { outputPath, configPath, artifactFileName };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
