import { buildStandaloneExecutable } from "../release/standalone.js";
import { logHint, logKeyValue, logSection, logSuccess } from "../utils/logger.js";

export async function runReleaseStandaloneCommand(options?: {
  outputDir?: string;
  executableName?: string;
}) {
  const result = await buildStandaloneExecutable({
    outputDir: options?.outputDir,
    executableName: options?.executableName,
  });

  logSection("Standalone 构建完成");
  logKeyValue("可执行文件", result.outputPath);
  logKeyValue("发布文件名", result.artifactFileName);
  logKeyValue("SEA 配置", result.configPath);
  logHint("该产物为当前平台专用；请在目标平台上构建对应版本。");
  logSuccess("现在可以像已安装 CLI 一样直接运行该可执行文件。");
}
