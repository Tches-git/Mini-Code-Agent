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
  return !intent.hasWriteIntent && intent.hasAnalysisIntent && intent.mentionsProjectScope;
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
