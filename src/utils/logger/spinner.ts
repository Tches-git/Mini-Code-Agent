import chalk from "chalk";
import { SPINNER_FRAMES } from "./core.js";

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
