import chalk from "chalk";

 const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

 export class Spinner {
   private timer?: ReturnType<typeof setInterval>;
   private frame = 0;

   start(text: string) {
     this.stop();
     this.frame = 0;
     this.timer = setInterval(() => {
       const symbol = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
       process.stdout.write(`\r${chalk.cyan(symbol)} ${chalk.gray(text)}`);
       this.frame++;
     }, 80);
   }

   stop() {
     if (this.timer) {
       clearInterval(this.timer);
       this.timer = undefined;
       process.stdout.write("\r\x1b[K");
     }
   }
 }

export function logSection(title: string) {
  console.log(chalk.cyan(`\n═══ ${title} ═══`));
}

export function logLine(text: string) {
  console.log(text);
}

export function logStep(index: number, text: string) {
  console.log(chalk.gray(`  ${index}. `) + text);
}

export function logSuccess(text: string) {
  console.log(chalk.green("✔ ") + text);
}

export function logError(text: string) {
  console.log(chalk.red("✖ ") + text);
}

export function logDiffHeader(path: string, summary: string) {
  console.log(chalk.yellow(`\n📄 ${path}`) + chalk.gray(` (${summary})`));
}

export function logDiffLine(line: string) {
  if (line.startsWith("+")) {
    console.log(chalk.green(line));
  } else if (line.startsWith("-")) {
    console.log(chalk.red(line));
  } else if (line.startsWith("?")) {
    console.log(chalk.cyan(line));
  } else {
    console.log(chalk.gray(line));
  }
}

 export function logToolCall(name: string, args: string) {
   const short = args.length > 80 ? args.slice(0, 77) + "..." : args;
   console.log(chalk.magenta("  ⚙ ") + chalk.white(name) + chalk.gray(` ${short}`));
 }

 export function logToolResult(name: string, result: string) {
   const short = result.length > 100 ? result.slice(0, 97) + "..." : result;
   console.log(chalk.green("  ✓ ") + chalk.gray(`${name} → ${short}`));
 }

 export function logToolError(name: string, error: string) {
   console.log(chalk.red("  ✖ ") + chalk.yellow(name) + chalk.red(` ${error}`));
 }

 export function logAutoValidate(command: string) {
   console.log(chalk.blue("  🔍 ") + chalk.gray(`自动验证: ${command}`));
 }

 export function logAutoValidateSkipped(reason: string) {
   console.log(chalk.blue("  ⏭ ") + chalk.gray(`自动验证已跳过: ${reason}`));
 }

 export function logAutoFix(round: number) {
   console.log(chalk.yellow("  🔧 ") + chalk.gray(`自动修复第 ${round} 轮`));
 }

 export function logContextTrimmed(removed: number, totalTokens: number) {
   console.log(chalk.yellow("  ✂️  ") + chalk.gray(`上下文裁剪: 移除 ${removed} 条旧消息，当前约 ${totalTokens} tokens`));
 }

 export function logFileModified(path?: string) {
   console.log(chalk.yellow("  📝 ") + chalk.gray(`文件已修改${path ? `: ${path}` : ""}`));
 }

 export function logBanner() {
   console.log();
   console.log(chalk.cyan.bold("  ╔══════════════════════════════════════╗"));
   console.log(chalk.cyan.bold("  ║") + chalk.white.bold("     Mini Claude Code · 交互模式      ") + chalk.cyan.bold("║"));
   console.log(chalk.cyan.bold("  ╚══════════════════════════════════════╝"));
   console.log(chalk.gray("  输入任务开始对话，输入 /exit 退出, /clear 清空上下文"));
   console.log();
 }

 export function logAssistant(text: string) {
   console.log();
   console.log(chalk.green.bold("  Assistant:"));
   const lines = text.split("\n");
   for (const line of lines) {
     console.log(chalk.white("  " + line));
   }
   console.log();
 }
