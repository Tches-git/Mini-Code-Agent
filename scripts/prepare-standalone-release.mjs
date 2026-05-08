import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const extension = process.platform === "win32" ? ".exe" : "";
const sourceBinary = path.resolve(`dist/standalone/local-code-agent${extension}`);
const artifactName = `local-code-agent-${process.platform}-${process.arch}${extension}`;
const targetBinary = path.resolve("dist", "release-assets", artifactName);

await execa("npm", ["run", "build:standalone:gha"], { stdio: "inherit" });
await mkdir(path.dirname(targetBinary), { recursive: true });
await copyFile(sourceBinary, targetBinary);
console.log(targetBinary);
