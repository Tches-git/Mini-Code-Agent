# Mini Claude Code

一个从零实现的本地 Code Agent CLI，具备完整的 LLM 工具调用闭环、多级安全策略和自动验证修复能力。

> 不是套壳聊天机器人，而是能真正完成"搜索 → 读取 → 修改 → 验证"开发流程的代码助手。

## 项目动机

市面上的 AI 编程工具大多是 IDE 插件或 Web 聊天界面，底层的 Agent 机制对开发者不透明。这个项目从第一行代码开始，独立实现了一个可在终端运行的 Code Agent，重点解决以下问题：

- **工具调用闭环**：不只是生成文本，而是让 LLM 自主调用文件操作、搜索、命令执行等工具，形成完整的任务执行链路
- **安全边界控制**：Agent 能执行命令、读写文件，如何在给予能力的同时守住安全底线
- **长会话上下文管理**：多轮对话中 token 预算有限，如何在裁剪历史时保留关键信息
- **修改后的自动验证**：代码改完不能靠 LLM 自己说"改好了"，需要自动跑验证并在失败时反馈修复

## 核心架构

```
src/
  cli/                 # CLI 入口与交互层
    index.ts             Commander 解析，单次执行 / 交互模式 / 审批日志查询
    interactive.ts       多轮对话 REPL（Spinner、实时事件流、斜杠命令、确认交互）
    approval-log.ts      审批日志的格式化输出与过滤
  agent/               # Agent 引擎（核心逻辑）
    orchestrator.ts      Agent Loop 主循环，调度 LLM 与工具
    prompts.ts           系统提示词
    approval.ts          审批管理器（命令确认、外部路径 / 文件确认、审计记录）
    validation.ts        代码修改后的自动验证计划生成与失败回灌
    summary.ts           长会话摘要压缩（基于焦点的上下文保留策略）
  llm/                 # LLM 通信层
    client.ts            OpenAI 兼容协议的流式 / 非流式调用封装
    env.ts               环境变量管理
  tools/               # 工具定义（10 个工具）
    filesystem.ts        8 个文件工具 + 外部文档提取引擎
    search.ts            文本搜索（ripgrep 优先，Node.js 遍历兜底）
    command.ts           命令执行（白名单 / 守卫 / 黑名单三级策略）
    create-tool.ts       工具工厂（zod 运行时校验 + JSON Schema 双重定义）
  types/               # 类型系统
    agent.ts             ChatMessage、ToolDefinition、AgentEvent 等核心类型
  utils/               # 基础设施
    token.ts             Token 估算与上下文窗口裁剪
    diff.ts              统一 diff 生成（LCS 算法 + 行内变更高亮）
    command-audit.ts     审批日志持久化（NDJSON 格式）
    logger.ts            终端输出（Spinner 动画、彩色 diff、事件日志）
```

**技术栈**：TypeScript · Node.js (ESM) · OpenAI SDK（兼容协议）· Commander · Zod · Vitest

## 关键设计决策

### 1. Agent Loop 与自适应执行预算

`orchestrator.ts` 实现了 LLM → 工具调用 → 结果回传 → 继续推理的核心循环。执行轮数不是固定值，而是根据任务类型动态调整：

- 写入 / 修复类任务：12 轮（改完即止）
- 只读分析任务：16 轮（需要更多探索）
- 外部文档分析：20 轮
- 外部项目 / 目录分析：24 轮

运行时还会检测实际行为：如果连续几轮都在调用只读工具，会自动上调预算，避免分析任务被过早截断。

```typescript
// orchestrator.ts — 运行时动态升级执行预算
const isReadOnlyExplorationTurn = toolNames.every((name) => READ_ONLY_TOOLS.has(name));
if (isReadOnlyExplorationTurn && !hasModifiedFiles && maxIterations < EXTERNAL_ANALYSIS_EXECUTION_ROUND_LIMIT) {
  maxIterations = upgradedBudget;
  steps.push(`执行预算已调整为 ${maxIterations} 轮（${budgetReason}）`);
}
```

### 2. 三级命令安全策略

`command.ts` 对所有命令执行请求做策略评估，返回 `allow` / `confirm` / `block` 三种决策：

| 层级 | 策略 | 示例 |
|------|------|------|
| **白名单** | 直接放行 | `ls`, `cat`, `git status`, `npm run build` |
| **守卫** | 需用户确认后执行 | `git push`, `npm install`, `node script.js` |
| **黑名单** | 直接拦截 | `rm -rf`, `sudo`, `curl\|sh`, shell 链式语法 |

在此基础上，还有三层额外防护：

- **环境变量扩展**：通过 `RUN_COMMAND_ALLOWLIST` / `GUARDLIST` / `BLOCKLIST` 自定义规则
- **Shell 语法拦截**：禁止 `&&`、`|`、`;`、`$()` 等链式 / 管道 / 命令替换语法，杜绝注入
- **审计日志**：所有审批决策（含自动验证触发的命令）持久化到 NDJSON 文件，支持按时间 / 类型 / 路径查询

### 3. 自动验证与自动修复

当 Agent 修改了代码文件后，系统不依赖 LLM 自行判断正确性，而是：

1. **分析修改范围**：根据变更文件类型（源码 / 测试 / 配置 / 文档）决定需要运行哪些验证脚本
2. **自动执行验证**：依次运行 `lint` → `test` → `build`（仅运行项目中实际存在的脚本）
3. **失败时自动修复**：如果验证失败，将错误摘要（stdout/stderr，截断到 2000 字符）回灌给 LLM，要求它定位问题并修复，最多尝试 2 轮

```
代码修改 → 检测变更类型 → 选择验证脚本 → 执行验证
                                            ↓ 失败
                                    截取错误摘要 → 回灌 LLM → 修复代码 → 重新验证
                                                                        ↓ 仍失败
                                                                   第 2 轮修复 → 最终报告
```

文档文件（.md / .txt / .rst）的变更会自动跳过验证，避免不必要的构建。

### 4. 上下文管理：摘要压缩 + 焦点保留

长会话中旧消息会被裁剪，但不是简单丢弃，而是经过两步处理：

1. **结构化摘要**：被移除的消息按类型生成摘要行（如 `文件操作: write_file src/index.ts`、`命令结果: npm run build -> exit 0`）
2. **焦点评分**：维护一个动态更新的"焦点"（当前任务涉及的文件路径、搜索关键词），摘要行超出上限时，按与焦点的相关性打分排序，优先保留与当前工作相关的线索

这确保了 LLM 在后续轮次中仍然知道"之前做过什么"，而不是完全失去上下文。

### 5. 外部文档处理引擎

不只是操作工作区内的代码文件，还能安全地分析工作区外的各类文档：

| 格式 | 提取方式 |
|------|----------|
| `.docx` / `.doc` / `.odt` / `.rtf` | macOS `textutil` 原生转换 |
| `.xlsx` / `.xlsm` / `.xltx` | 解压 OOXML → 解析 sharedStrings.xml + sheet.xml → 重建表格 |
| `.ods` | 解压 → 解析 OpenDocument content.xml → 还原行列结构 |
| `.pptx` / `.pptm` | 解压 → 逐页解析 slide.xml → 提取文本段落 |
| `.odp` | 解压 → 解析 draw:page → 提取页面文本 |
| `.pdf` / `.key` / `.numbers` / `.pages` | macOS Spotlight (`mdls`) 或 `strings` 兜底 |

所有外部文件先缓存到工作区内的 `.imports/` 目录，提取结果保存为纯文本，后续可直接用 `read_file` 继续分析。

### 6. Diff 预览

文件修改使用自实现的 LCS diff 算法生成标准 unified diff 格式，包含：

- `a/` / `b/` 文件级 patch header
- 标准 `@@ -m,n +m,n @@` hunk header
- 对成对修改的行，额外生成 `? old inline:` / `? new inline:` 行内变更提示

## 工具清单

| 工具 | 功能 | 安全机制 |
|------|------|----------|
| `list_files` | 列出目录内容 | 工作区外需确认 |
| `read_file` | 读取文件 | 工作区外需确认 |
| `create_file` | 新建文件（不覆盖已有） | 工作区外需确认 |
| `write_file` | 整文件写入 | 自动备份到 `.backup/` |
| `append_text` | 末尾追加 | 自动备份 |
| `insert_after` | 锚点后插入 | 自动备份 |
| `replace_text` | 局部文本替换 | 自动备份 |
| `search_text` | 全文搜索（ripgrep 优先） | 支持后缀 / glob / 上下文行数过滤 |
| `import_external_file` | 导入外部文档并提取文本 | 需确认 + 缓存到 `.imports/` |
| `run_command` | 执行命令 | 三级策略 + 审计日志 |

## 快速开始

```bash
npm install
cp .env.example .env   # 配置 API Key 和模型

# 单次执行
npm run dev -- "分析当前项目结构"

# 交互式多轮对话
npm run chat

# 查询审批日志
npm run dev -- approvals --decision rejected --after 7d
```

### 交互模式

```
  ╔══════════════════════════════════════╗
  ║     Mini Claude Code · 交互模式      ║
  ╚══════════════════════════════════════╝

  > 在 src/utils/token.ts 里找到 estimateTokens 函数，把中文权重从 2 改成 1.5

  ⚙ search_text {"query":"estimateTokens","path":"src/utils/token.ts"}
  ✓ search_text → [{"path":"src/utils/token.ts","line":15,...}]
  ⚙ read_file {"path":"src/utils/token.ts"}
  ✓ read_file → export const SUMMARY_MESSAGE_PREFIX...
  ⚙ replace_text {"path":"src/utils/token.ts","oldText":"count += 2","newText":"count += 1.5"}
  ✓ replace_text → 已完成局部替换: src/utils/token.ts
  📝 文件已修改: src/utils/token.ts
  🔍 自动验证: npm run build
  ✓ run_command → {"exitCode":0,...}

  Assistant:
  已将 estimateTokens 中中文字符的 token 权重从 2 改为 1.5，构建验证通过。
```

| 斜杠命令 | 说明 |
|----------|------|
| `/help` | 显示可用命令 |
| `/clear` | 清空上下文，开始新会话 |
| `/approvals [过滤]` | 查看审批日志 |
| `/exit` | 退出 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | API Key（必填） |
| `OPENAI_BASE_URL` | API 端点（可选，用于兼容端点） |
| `MODEL_NAME` | 模型名称，默认 `gpt-4o` |
| `RUN_COMMAND_ALLOWLIST` | 额外允许的命令规则，`;` 分隔，支持 `*` 前缀匹配 |
| `RUN_COMMAND_GUARDLIST` | 额外需确认的命令规则 |
| `RUN_COMMAND_BLOCKLIST` | 额外阻止的命令规则 |
| `MAX_CONTEXT_TOKENS` | 上下文窗口上限，默认 100000 |
| `MAX_EXECUTION_ROUNDS` | 默认执行轮数上限，默认 12 |

## 设计取舍

| 选择 | 原因 |
|------|------|
| 用 OpenAI 兼容协议而非绑定特定模型 | 可以灵活切换底层模型，不依赖单一供应商 |
| 禁止所有 shell 链式语法 | 安全优先；单条命令覆盖绝大多数场景，链式执行可以通过多轮工具调用替代 |
| 自实现 LCS diff 而非调 `diff` 命令 | 纯 Node.js 实现，无外部依赖，且可以添加行内变更提示等自定义功能 |
| 外部文件先缓存再分析 | 工作区边界清晰，避免 Agent 静默读写用户任意目录 |
| Token 估算用启发式而非 tiktoken | 够用于窗口管理，避免引入大体积 WASM 依赖 |
| 搜索 ripgrep 优先 + Node.js 兜底 | 大项目性能好，没装 rg 的环境也能用 |

## 测试

```bash
npm test              # 运行全部测试
npm run test:watch    # watch 模式
```

覆盖了命令策略评估、token 估算与裁剪、diff 生成、审批管理器、验证计划生成等核心模块。
