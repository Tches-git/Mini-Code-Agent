import {
  ANALYSIS_EXECUTION_ROUND_LIMIT,
  DEFAULT_EXECUTION_ROUND_LIMIT,
  EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT,
  MIXED_EXECUTION_ROUND_LIMIT,
} from "./orchestrator-config.js";

export function analyzeTaskIntent(userTask: string) {
  const normalized = userTask.toLowerCase();
  const hasWriteIntent =
    /(修改|编辑|修复|实现|新增|重构|更新|追加|替换|写入|生成|创建|删除|fix|edit|modify|write|append|replace|implement|create|refactor|update|generate|delete)/i.test(
      normalized,
    );
  const hasAnalysisIntent =
    /(分析|总结|解释|查看|读取|搜索|查找|列出|浏览|打开|审查|analy[sz]e|summari[sz]e|explain|read|search|find|list|open|inspect|review)/i.test(
      normalized,
    );
  const mentionsExternalPath =
    /(^|[\s"'`(])\/[^\s"'`)]+/.test(userTask) ||
    /\.(doc|docx|odt|rtf|xls|xlsx|xlsm|xltx|xltm|ods|ppt|pptx|pptm|potx|potm|odp|pdf|txt|md|csv|json|yaml|yml)\b/i.test(
      normalized,
    );
  const mentionsProjectScope =
    /(项目|工程|代码库|仓库|目录|文件夹|repo|repository|project|codebase|workspace|folder|directory|架构|structure|module|入口|entry)/i.test(
      normalized,
    );
  return {
    hasWriteIntent,
    hasAnalysisIntent,
    mentionsExternalPath,
    mentionsProjectScope,
  };
}

export function shouldPreferProjectMap(userTask: string): boolean {
  const intent = analyzeTaskIntent(userTask);
  return (
    !intent.hasWriteIntent &&
    intent.hasAnalysisIntent &&
    intent.mentionsProjectScope
  );
}

export type AgentExecutionMode =
  | "analysis"
  | "edit"
  | "refactor"
  | "release"
  | "general";

export function getExecutionMode(userTask: string): AgentExecutionMode {
  const normalized = userTask.toLowerCase();
  if (
    /(发布|发版|release|pack|standalone|benchmark|ci|npm publish)/i.test(
      normalized,
    )
  ) {
    return "release";
  }
  if (/(重构|迁移|拆分|rename|refactor|migrate)/i.test(normalized)) {
    return "refactor";
  }
  const intent = analyzeTaskIntent(userTask);
  if (intent.hasWriteIntent) {
    return "edit";
  }
  if (intent.hasAnalysisIntent) {
    return "analysis";
  }
  return "general";
}

export function getModeStrategyPrompt(mode: AgentExecutionMode): string {
  if (mode === "analysis") {
    return "当前是分析模式：优先使用 tree_files/project_map/glob_files/search_text/read_file，只读探索后给出简洁结论。";
  }
  if (mode === "edit") {
    return "当前是编辑模式：优先最小改动，必要时用 update_tasks 跟踪步骤，修改后必须验证。";
  }
  if (mode === "refactor") {
    return "当前是重构模式：先规划影响面，分批小改动，使用 update_tasks 跟踪迁移步骤和阻塞点。";
  }
  if (mode === "release") {
    return "当前是发布模式：优先检查 git 状态、测试、构建、pack/benchmark/release 门禁，避免无关代码改动。";
  }
  return "当前是通用模式：按任务目标选择最小必要工具，保持步骤可追踪。";
}

export function getExecutionBudget(userTask: string): {
  limit: number;
  reason: string;
} {
  const {
    hasWriteIntent,
    hasAnalysisIntent,
    mentionsExternalPath,
    mentionsProjectScope,
  } = analyzeTaskIntent(userTask);

  if (hasWriteIntent)
    return {
      limit: DEFAULT_EXECUTION_ROUND_LIMIT,
      reason: "写入或修复类任务使用默认执行预算",
    };
  if (hasAnalysisIntent && mentionsExternalPath && mentionsProjectScope)
    return {
      limit: EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT,
      reason: "外部项目或目录分析任务使用扩展执行预算",
    };
  if (hasAnalysisIntent && mentionsExternalPath)
    return {
      limit: ANALYSIS_EXECUTION_ROUND_LIMIT,
      reason: "外部文件分析任务使用分析执行预算",
    };
  if (hasAnalysisIntent)
    return {
      limit: MIXED_EXECUTION_ROUND_LIMIT,
      reason: "只读分析任务使用放宽后的执行预算",
    };
  return {
    limit: DEFAULT_EXECUTION_ROUND_LIMIT,
    reason: "通用任务使用默认执行预算",
  };
}
