export type BenchmarkCategory = "read" | "edit" | "validate" | "auto_fix";

export type BenchmarkTaskExpectation = {
  finalTextIncludes?: string[];
  finalTextIncludesAny?: string[][];
  minToolCalls?: number;
  maxDiffs?: number;
  maxValidationRuns?: number;
  minValidationRuns?: number;
  minAutoFixes?: number;
  expectedModifiedFiles?: string[];
  forbiddenModifiedFiles?: string[];
  mustPassValidation?: boolean;
};

export type BenchmarkTaskPrecondition = {
  path: string;
  includes?: string[];
  excludes?: string[];
  reason: string;
};

export type BenchmarkTask = {
  id: string;
  title: string;
  category: BenchmarkCategory;
  prompt: string;
  description: string;
  enabled?: boolean;
  preconditions?: BenchmarkTaskPrecondition[];
  expectation: BenchmarkTaskExpectation;
};

export const benchmarkTasks: BenchmarkTask[] = [
  {
    id: "project-structure-overview",
    title: "项目结构总览",
    category: "read",
    prompt:
      "分析整个项目结构，说明 CLI、agent、tools、utils 分别负责什么。请用 4-6 个要点简洁总结。",
    description: "验证 Agent 能否理解整体分层与核心目录职责。",
    expectation: {
      finalTextIncludes: ["cli", "agent", "tools", "utils"],
      minToolCalls: 2,
      maxDiffs: 0,
      maxValidationRuns: 0,
    },
  },
  {
    id: "orchestrator-flow",
    title: "编排流程分析",
    category: "read",
    prompt:
      "分析 src/agent/orchestrator.ts 的主执行流程，说明 LLM、工具调用、自动验证之间的关系。请用 4-6 个要点简洁总结。",
    description: "验证 Agent 能否读懂 orchestrator 主流程。",
    expectation: {
      finalTextIncludesAny: [
        ["llm", "模型"],
        ["工具", "tool"],
        ["验证", "校验", "validation"],
      ],
      minToolCalls: 2,
      maxDiffs: 0,
      maxValidationRuns: 0,
    },
  },
  {
    id: "approval-safety",
    title: "审批与安全机制",
    category: "read",
    prompt:
      "总结这个项目的安全机制，重点解释命令审批、工作区外路径确认和审计日志。请用 4-6 个要点简洁总结。",
    description: "验证 Agent 能否定位并总结安全边界设计。",
    expectation: {
      finalTextIncludesAny: [
        ["审批", "确认"],
        ["工作区外", "外部路径", "路径"],
        ["审计", "日志"],
      ],
      minToolCalls: 2,
      maxDiffs: 0,
      maxValidationRuns: 0,
    },
  },
  {
    id: "validation-loop",
    title: "自动验证闭环",
    category: "read",
    prompt:
      "解释代码修改后自动验证的策略，说明 lint、test、build 是如何被选择和触发的。请用 4-6 个要点简洁总结。",
    description: "验证 Agent 能否总结自动验证规划逻辑。",
    expectation: {
      finalTextIncludes: ["lint", "test", "build"],
      minToolCalls: 2,
      maxDiffs: 0,
      maxValidationRuns: 0,
    },
  },
  {
    id: "context-management",
    title: "上下文管理",
    category: "read",
    prompt:
      "解释长会话里的上下文管理机制，说明摘要压缩、焦点保留和 token 控制分别怎么工作。请用 4-6 个要点简洁总结。",
    description: "验证 Agent 能否理解上下文裁剪与摘要策略。",
    expectation: {
      finalTextIncludesAny: [
        ["摘要", "总结"],
        ["焦点", "相关", "上下文"],
        ["token", "上下文窗口", "裁剪"],
      ],
      minToolCalls: 2,
      maxDiffs: 0,
      maxValidationRuns: 0,
    },
  },
  {
    id: "tooling-and-ci",
    title: "工程化配置",
    category: "read",
    prompt:
      "总结这个项目的工程化配置，说明构建、测试、lint 和 CI 分别由哪些文件或脚本负责。请用 4-6 个要点简洁总结。",
    description: "验证 Agent 能否从配置文件总结工程化能力。",
    expectation: {
      finalTextIncludesAny: [
        ["build", "构建"],
        ["test", "测试"],
        ["lint", "校验"],
        ["ci", "github actions", "workflow"],
      ],
      minToolCalls: 2,
      maxDiffs: 0,
      maxValidationRuns: 0,
    },
  },
  {
    id: "edit-constant",
    title: "修改固定常量",
    category: "edit",
    enabled: true,
    prompt:
      "在隔离副本中，仅修改 src/utils/token.ts 的 estimateTokens 函数，把英文字符的权重从 0.25 调整为 0.3。不要修改任何测试文件、配置文件或其他源码文件；如果验证失败，也优先继续修改同一文件，不要扩散修改范围。完成后确认构建或验证通过，并简要说明修改结果。",
    description:
      "第二阶段首个可执行任务：验证 Agent 是否能在隔离副本中完成单文件、小范围常量修改，并进入自动验证链路。",
    preconditions: [
      {
        path: "src/utils/token.ts",
        includes: ["0.25"],
        excludes: ["0.3"],
        reason:
          "该任务要求从 0.25 改到 0.3；如果基线文件里已经是 0.3，则本次运行无法再验证编辑能力。",
      },
    ],
    expectation: {
      minToolCalls: 2,
      maxDiffs: 1,
      minValidationRuns: 1,
      expectedModifiedFiles: ["src/utils/token.ts"],
      forbiddenModifiedFiles: [
        "src/agent/orchestrator.ts",
        "src/cli/index.ts",
        "src/utils/token.test.ts",
        "tsconfig.json",
      ],
      finalTextIncludesAny: [
        ["0.3", "0.30"],
        ["验证", "构建", "build"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "fix-readme-command",
    title: "修正文档命令示例",
    category: "edit",
    enabled: true,
    prompt:
      "在隔离副本中，仅修改 README.md 中一条错误的命令示例，使其与当前 CLI 用法保持一致。不要修改任何源码、测试或配置文件。完成后简要说明修改内容；如果没有必要，不要执行构建类验证。",
    description:
      "第二阶段可执行任务：在隔离副本中注入 README 错误命令基线，验证 Agent 是否只修改文档并避免误触发无关代码验证。",
    preconditions: [
      {
        path: "README.md",
        includes: ["npm run chat -- --resume <session-id>"],
        reason:
          "该任务依赖隔离副本中已注入一条故意写错的会话恢复命令示例；如果错误命令不存在或已提前修好，则当前 benchmark 基线不成立。",
      },
    ],
    expectation: {
      minToolCalls: 2,
      maxDiffs: 1,
      maxValidationRuns: 0,
      expectedModifiedFiles: ["README.md"],
      forbiddenModifiedFiles: [
        "src/cli/index.ts",
        "src/cli/interactive.ts",
        "package.json",
      ],
      finalTextIncludesAny: [
        ["README", "文档"],
        ["命令", "示例", "恢复会话"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "rename-local-symbol",
    title: "单文件局部符号重命名",
    category: "edit",
    enabled: true,
    prompt:
      "在隔离副本中，仅修改 src/agent/summary.ts 中指定局部符号的名称，将旧名字重命名为新名字。不要修改其他文件，不要改变函数行为，完成后进行最小必要验证，并简要说明结果。",
    description:
      "第二阶段可执行任务：在隔离副本中注入局部符号旧名字基线，验证 Agent 是否能在单文件内完成受限重命名并保持改动范围最小。",
    preconditions: [
      {
        path: "src/agent/summary.ts",
        includes: ["SUMMARY_FOCUS_KEYWORD_LIMIT"],
        excludes: ["SUMMARY_FOCUS_MAX_KEYWORDS"],
        reason:
          "该任务草案要求把局部符号从 SUMMARY_FOCUS_KEYWORD_LIMIT 重命名为 SUMMARY_FOCUS_MAX_KEYWORDS；如果基线中不含旧名字或已提前改好，则应跳过。",
      },
    ],
    expectation: {
      minToolCalls: 3,
      maxDiffs: 2,
      minValidationRuns: 1,
      expectedModifiedFiles: ["src/agent/summary.ts"],
      forbiddenModifiedFiles: [
        "src/agent/summary.test.ts",
        "src/cli/interactive.ts",
        "README.md",
      ],
      finalTextIncludesAny: [
        ["重命名", "rename"],
        ["验证", "build", "check"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "fix-interactive-resume-regression",
    title: "修复交互式恢复命令回归",
    category: "validate",
    enabled: true,
    prompt:
      "在隔离副本中修复一个交互式会话恢复命令的回归问题：用户输入 `/resume <id>` 时应该恢复会话，但当前实现有缺陷。请优先运行相关测试定位问题，并且只允许修改 `src/cli/interactive.ts`。如果验证失败，只能继续读取报错、重跑相关测试或继续修改这个目标文件；不要修改 README、测试、配置、依赖声明、benchmark 基础设施或任何其他文件。若遇到缺依赖或环境问题，请在最终说明中报告，而不是通过修改 `package.json`、`src/benchmark/*` 或其他文件绕过。完成后重新运行相关验证，并简要说明修复结果。",
    description:
      "更贴近真实开发场景的任务：在隔离副本中注入 `/resume <id>` 回归，验证 Agent 是否能通过现有测试定位交互命令缺陷、修复源码并重新验证通过。",
    preconditions: [
      {
        path: "src/cli/interactive.ts",
        includes: ['if (slashCommand === "/resume-session")'],
        excludes: ['if (slashCommand === "/resume")'],
        reason:
          "该任务依赖隔离副本中已注入 `/resume` 命令回归；如果错误分支不存在或已提前修好，则当前 benchmark 基线不成立。",
      },
    ],
    expectation: {
      minToolCalls: 4,
      maxDiffs: 2,
      minValidationRuns: 1,
      expectedModifiedFiles: ["src/cli/interactive.ts"],
      forbiddenModifiedFiles: [
        "src/cli/interactive.test.ts",
        "src/benchmark/index.ts",
        "src/benchmark/isolation.ts",
        "README.md",
        "package.json",
      ],
      finalTextIncludesAny: [
        ["/resume", "resume"],
        ["测试", "test", "vitest"],
        ["修复", "恢复", "regression"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "fix-failing-token-test",
    title: "修复失败的 token 估算测试",
    category: "validate",
    enabled: true,
    prompt:
      "在隔离副本中修复一个由源码回归引起的测试失败。请先运行与 token 估算相关的测试定位问题，并且只允许修改 `src/utils/token.ts`。再对源码做最小修改；不要改测试断言、README、配置、依赖声明、benchmark 基础设施或任何其他源码文件。若验证失败，只能继续读取报错、重跑相关测试或继续修改 `src/utils/token.ts`；如果发现缺依赖或环境异常，请在最终说明中报告，不要通过修改 `package.json`、`src/tools/command.ts` 或 `src/benchmark/*` 来绕过。完成后重新运行相关验证，并简要说明修复结果。",
    description:
      "更贴近真实开发场景的 fix-failing-test 任务：在隔离副本中注入 token 估算权重回归，验证 Agent 是否能基于现有单元测试定位失败原因、修复源码并重新跑测试通过。",
    preconditions: [
      {
        path: "src/utils/token.ts",
        includes: ["const ENGLISH_CHAR_WEIGHT = 0.6;"],
        excludes: ["const ENGLISH_CHAR_WEIGHT = 0.3;"],
        reason:
          "该任务依赖隔离副本中已注入 token 权重回归；如果错误权重不存在或已提前修好，则当前 benchmark 基线不成立。",
      },
    ],
    expectation: {
      minToolCalls: 4,
      maxDiffs: 2,
      minValidationRuns: 1,
      expectedModifiedFiles: ["src/utils/token.ts"],
      forbiddenModifiedFiles: [
        "src/utils/token.test.ts",
        "src/tools/command.ts",
        "src/benchmark/index.ts",
        "src/benchmark/isolation.ts",
        "README.md",
        "package.json",
      ],
      finalTextIncludesAny: [
        ["token", "estimateTokens", "权重"],
        ["测试", "test", "vitest"],
        ["修复", "通过", "fixed"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "fix-approval-policy-regression",
    title: "修复审批策略回归",
    category: "validate",
    enabled: true,
    prompt:
      "在隔离副本中修复一个命令审批策略回归：某个本应需要确认的项目脚本被错误地当成安全命令直接放行了。请优先运行与命令策略相关的测试定位问题，并且只允许修改 `src/tools/command.ts`。随后做最小源码修复；不要修改测试、README、配置、依赖声明、benchmark 基础设施或任何其他文件。若验证失败，只能继续读取报错、重跑相关测试或继续修改 `src/tools/command.ts`；如果遇到缺依赖或环境问题，请在最终说明中报告，而不是通过修改 `package.json`、`src/benchmark/*` 或其他文件绕过。完成后重新运行相关验证，并简要说明修复结果。",
    description:
      "更贴近产品行为的 benchmark 任务：在隔离副本中注入 run_command 审批策略回归，验证 Agent 是否能通过现有 command policy 测试定位安全边界缺陷并修复。",
    preconditions: [
      {
        path: "src/tools/command.ts",
        includes: ['  "chat",'],
        reason:
          "该任务依赖隔离副本中已注入审批策略回归；如果 `chat` 没有被错误加入安全脚本集合，则当前 benchmark 基线不成立。",
      },
    ],
    expectation: {
      minToolCalls: 4,
      maxDiffs: 2,
      minValidationRuns: 1,
      expectedModifiedFiles: ["src/tools/command.ts"],
      forbiddenModifiedFiles: [
        "src/tools/command.test.ts",
        "src/benchmark/index.ts",
        "src/benchmark/isolation.ts",
        "README.md",
        "package.json",
      ],
      finalTextIncludesAny: [
        ["审批", "confirm", "guard"],
        ["chat", "npm run chat", "script"],
        ["测试", "test", "vitest"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "fix-ts-type-error",
    title: "修复 TypeScript 类型错误",
    category: "auto_fix",
    enabled: true,
    prompt:
      "在隔离副本中修复一个预先注入的 TypeScript 类型错误。请优先根据构建或类型检查输出来定位问题，做最小修改，不要顺手重构无关代码。完成后重新验证并简要说明修复结果。",
    description:
      "第二阶段可执行任务：在隔离副本中注入稳定的 TypeScript 类型错误基线，验证 Agent 是否能利用 diagnostics 完成 失败验证 → 自动修复 → 再验证 的闭环。",
    preconditions: [
      {
        path: "src/types/agent.ts",
        includes: ["__BENCHMARK_TS_ERROR__"],
        excludes: ["__BENCHMARK_TS_FIXED__"],
        reason:
          "该任务依赖预先注入的 TypeScript 类型错误基线；如果错误标记不存在，说明当前工作区不适合直接运行该任务。",
      },
    ],
    expectation: {
      minToolCalls: 4,
      maxDiffs: 2,
      minValidationRuns: 1,
      minAutoFixes: 1,
      expectedModifiedFiles: ["src/types/agent.ts"],
      forbiddenModifiedFiles: ["package.json", "tsconfig.json", "README.md"],
      finalTextIncludesAny: [
        ["类型错误", "TypeScript", "TS"],
        ["修复", "验证通过", "build"],
      ],
      mustPassValidation: true,
    },
  },
  {
    id: "validate-build",
    title: "修改后自动构建验证",
    category: "validate",
    enabled: false,
    prompt:
      "在隔离副本中对一个已有 TypeScript 文件做小范围安全修改，并确认系统自动触发构建验证且最终通过。",
    description:
      "第二阶段草案：验证 Agent 修改后是否会进入自动验证链路。默认禁用，待接入隔离执行环境后启用。",
    expectation: {
      minToolCalls: 2,
      minValidationRuns: 1,
      mustPassValidation: true,
    },
  },
  {
    id: "auto-fix-type-error",
    title: "自动修复类型错误",
    category: "auto_fix",
    enabled: false,
    prompt:
      "在隔离副本中修复一个预先注入的 TypeScript 类型错误，要求经历至少一次失败验证后自动修复并最终通过。",
    description:
      "第二阶段草案：验证 Agent 是否能走通 失败验证 → 自动修复 → 再验证 的闭环。默认禁用，待接入隔离执行环境后启用。",
    expectation: {
      minToolCalls: 3,
      minValidationRuns: 1,
      minAutoFixes: 1,
      mustPassValidation: true,
    },
  },
];
