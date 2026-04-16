import chalk from "chalk";
import {
  listSessions,
  loadSession,
  type SessionSummary,
} from "../agent/session.js";

function formatSessionLine(session: SessionSummary): string {
  const title = session.title || "未命名会话";
  const updatedAt = session.updatedAt || session.createdAt || "unknown";
  return `${chalk.yellow(session.id)} ${chalk.white(title)} ${chalk.gray(`(${updatedAt}, turns=${session.turnCount})`)}`;
}

export async function printSessions(options?: { json?: boolean }) {
  const sessions = await listSessions();
  if (options?.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  console.log();
  console.log(chalk.cyan.bold("  会话列表"));
  if (sessions.length === 0) {
    console.log(chalk.gray("  当前没有可恢复的会话。"));
    console.log();
    return;
  }

  for (const session of sessions) {
    console.log(`  ${formatSessionLine(session)}`);
    if (session.summary) {
      console.log(chalk.gray(`    ${session.summary}`));
    }
  }
  console.log();
}

export async function printSessionDetail(
  id: string,
  options?: { json?: boolean },
) {
  const session = await loadSession(id);
  if (!session) {
    throw new Error(`未找到会话: ${id}`);
  }

  if (options?.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log();
  console.log(chalk.cyan.bold("  会话详情"));
  console.log(`  ${formatSessionLine(session)}`);
  if (session.summary) {
    console.log(chalk.gray(`  摘要: ${session.summary}`));
  }
  console.log(
    chalk.gray(`  最新用户消息: ${session.latestUserMessage || "(empty)"}`),
  );
  console.log();
}
