import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

function getDefaultBinaryPath() {
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.resolve(`dist/standalone/local-code-agent${extension}`);
}

const binaryPath = path.resolve(process.argv[2] || getDefaultBinaryPath());
const workspace = await mkdtemp(path.join(os.tmpdir(), "local-code-agent-standalone-check-"));

await execa(binaryPath, ["--version"], { stdio: "inherit" });
await execa(binaryPath, ["init", "--cwd", workspace], { stdio: "inherit" });
await access(path.join(workspace, ".env"));
await execa(binaryPath, ["doctor", "--cwd", workspace, "--json"], { stdio: "inherit", reject: false });
