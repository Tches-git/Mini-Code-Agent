import {
  listSessions,
  loadSession,
  type SessionSummary,
} from "../agent/session.js";
import {
  logCardList,
  logDetailEntries,
  logEmptyState,
  logRenderedText,
  logSection,
} from "../utils/logger.js";

function cleanInlineText(text: string): string {
  return text.replace(/^#{1,6}\s+/, "").trim();
}

function compressSessionText(text: string, maxLength = 72): string {
  const normalized = cleanInlineText(text).replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function formatSessionLine(session: SessionSummary): string {
  const title = compressSessionText(session.title || "未命名会话", 48);
  const updatedAt = session.updatedAt || session.createdAt || "unknown";
  return `**${session.id}** · ${title} · ${updatedAt} · ${session.turnCount} 轮`;
}

function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    session.id,
    session.title,
    session.summary,
    session.latestUserMessage,
    session.createdAt,
    session.updatedAt,
    String(session.turnCount),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(normalized);
}

export async function printSessions(options?: {
  json?: boolean;
  limit?: number;
  page?: number;
  sort?: "updated" | "created" | "turns";
  query?: string;
}) {
  const sessions = (await listSessions()).filter((session) =>
    matchesSessionQuery(session, options?.query || ""),
  );
  if (options?.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  const sort = options?.sort || "updated";
  const sortedSessions = [...sessions].sort((a, b) => {
    if (sort === "created") {
      return b.createdAt.localeCompare(a.createdAt);
    }
    if (sort === "turns") {
      return (
        b.turnCount - a.turnCount || b.updatedAt.localeCompare(a.updatedAt)
      );
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const page = Math.max(1, options?.page || 1);
  const limit = Math.max(1, options?.limit || 10);
  const startIndex = (page - 1) * limit;
  const pageItems = sortedSessions.slice(startIndex, startIndex + limit);

  logSection("会话列表");
  if (pageItems.length === 0) {
    logEmptyState("当前没有可恢复的会话。");
    console.log();
    return;
  }

  logDetailEntries([
    ...(options?.query ? [{ label: "过滤", value: options.query }] : []),
    {
      label: "排序",
      value:
        sort === "updated"
          ? "最近更新"
          : sort === "created"
            ? "最近创建"
            : "轮数",
    },
    {
      label: "页码",
      value: `${page}/${Math.max(1, Math.ceil(sortedSessions.length / limit))}`,
    },
    { label: "每页条数", value: String(limit) },
    { label: "总会话数", value: String(sortedSessions.length) },
  ]);

  for (const session of pageItems) {
    logCardList("会话项", [formatSessionLine(session)]);
    logDetailEntries(
      [
        ...(session.summary
          ? [{ label: "摘要", value: compressSessionText(session.summary, 96) }]
          : []),
        ...(session.latestUserMessage
          ? [
              {
                label: "最新消息",
                value: compressSessionText(session.latestUserMessage, 96),
              },
            ]
          : []),
      ],
      "    ",
    );
  }
  console.log();
}

export { matchesSessionQuery };

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

  logSection("会话详情");
  logCardList("会话项", [formatSessionLine(session)]);
  const detailLines = [
    ...(session.summary
      ? [{ label: "摘要", value: compressSessionText(session.summary, 120) }]
      : []),
    ...(session.summaryFocus.files.length > 0
      ? [
          {
            label: "焦点文件",
            value: session.summaryFocus.files.slice(0, 3).join(", "),
          },
        ]
      : []),
    ...(session.summaryFocus.keywords.length > 0
      ? [
          {
            label: "焦点关键词",
            value: session.summaryFocus.keywords.slice(0, 5).join(", "),
          },
        ]
      : []),
  ];
  if (detailLines.length > 0) {
    logDetailEntries(detailLines, "    ");
  }
  logSection("最新用户消息");
  logRenderedText(session.latestUserMessage || "(empty)");
  console.log();
}
