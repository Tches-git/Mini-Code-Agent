# Claude Code 对标差距分析

> 目标：让 `mini-code-agent` 从“可用的本地代码 Agent CLI”进一步演进为更接近 Claude Code 的工程助手。

## 当前已有基础

项目目前已经具备以下 Claude Code 风格能力雏形：

- CLI + 交互式 REPL 双入口
- 工具调用闭环（文件、搜索、命令、Git、diagnostics）
- 自动验证 / 自动修复
- 审批与安全边界
- 会话持久化与恢复
- benchmark / standalone / release 工作流

这说明它已经不是一个“纯聊天壳”，而是一个具备工程执行能力的本地代理原型。

---

## 一、与 Claude Code 的核心差距

### 1. 交互体验还不够像“日常开发终端助手”

当前项目有 REPL，但与 Claude Code 相比，仍缺少更强的交互能力：

- 多行输入体验不够强
- slash commands 数量和能力偏少
- 缺少更自然的 diff / patch / undo 工作流
- 会话搜索与历史切换能力较弱
- 工具事件展示已具雏形，但“沉浸式终端协作感”还不够强

### 2. 工具原语还不够接近 Claude Code

Claude Code 的核心不是“会用工具”，而是工具原语足够稳定、通用、细粒度。

当前项目已有：

- 文件读写
- 搜索
- 命令执行
- Git
- diagnostics

但还缺少更贴近 Claude Code 的能力组合：

- 更小粒度的 patch/edit 模式
- 更强的并行只读工具组合
- 更独立的 glob / grep 原语分层
- 子代理 / 子任务委派
- 上下文切换 / handoff
- 更强的 worktree / 分支隔离能力

### 3. 代理层更像“单代理循环”，而不是“会组织工作的代理系统”

当前 orchestrator 已经具备：

- 执行预算
- 工具调度
- 自动验证
- 自动修复
- 上下文裁剪

但和 Claude Code 相比，还缺：

- 显式 planning 阶段
- 将复杂任务拆分成子任务的能力
- 子代理并行处理
- 可恢复的任务树 / task graph
- 更强的长期记忆与焦点管理
- 不同模式（分析 / 编辑 / 重构 / 发布）的专门策略

### 4. 工程工作流还不够“默认现代化”

Claude Code 很强的一点在于它的默认工作流非常顺手。

当前项目虽已具备工程化能力，但仍可加强：

- 更接近 patch-first 的编辑体验
- Git worktree / branch sandbox
- 自动生成实施计划
- 变更后自动 summarization
- 更完善的操作撤销与恢复
- 更接近真实开发的默认命令集

---

## 二、建议分阶段演进

## Phase 1：先把“用起来像 Claude Code”

### 目标
让用户在终端中的主观体验更接近 Claude Code。

### 建议项

#### 1) 扩展 slash commands
建议新增：

- `/plan`：先只做计划，不直接修改
- `/diff`：展示本轮修改摘要
- `/undo`：撤销最近一次 agent 修改
- `/status`：展示当前工作区 / 会话 / 焦点信息
- `/focus`：展示当前摘要焦点文件与关键词
- `/tasks`：展示当前任务清单

#### 2) 支持更好的输入体验
- 多行输入
- 粘贴大段需求时更稳定
- 支持“先输入计划，再确认执行”模式

#### 3) 优化终端渲染
- 更明确的 thinking / tool / validation / fix 阶段视觉区分
- 更好的 diff block 渲染
- 更紧凑的审批卡片
- 更自然的 completion summary

#### 4) 增加撤销能力
- 记录 agent 自己的文件修改快照
- 支持 `/undo` 或“撤销上一轮修改”
- 区分 agent 修改与用户修改，避免误撤销

### 验收标准
- 交互模式下，用户可以通过 slash commands 完成计划、查看 diff、恢复会话、撤销修改。
- 终端输出比当前更接近“开发搭子”而不是“命令行日志”。

---

## Phase 2：把工具层做成 Claude Code 风格原语

### 目标
让代理不是只有“能跑工具”，而是拥有足够稳定、细粒度、可组合的工具集合。

### 建议项

#### 1) 拆分并强化工具原语
建议演进到更接近以下模型：

- `Read`
- `Grep`
- `Glob`
- `Edit`
- `Create`
- `Bash`
- `Task`
- `Handoff`
- `LookAt`（图片/PDF/文档理解，可后置）

#### 2) 强化编辑能力
- 更小粒度的精确替换
- 支持 patch 级编辑
- 更好的 edit failure 提示
- 多文件编辑时提供更清晰的结果摘要

#### 3) 强化搜索能力
- 当前已有 `search_text` 和 `project_map`
- 可进一步拆分为 grep / glob / semantic finder 三层
- 让 agent 能更自然地组合：先 glob，再 grep，再 read

#### 4) 引入子任务委派
- 对复杂任务允许新建子代理
- 子代理只负责局部子问题
- 主代理汇总结果，避免上下文过载

### 验收标准
- 工具层可以稳定支撑“分析 → 搜索 → 编辑 → 验证 → 汇总”复杂流程。
- 单个工具职责更清晰，组合方式更接近 Claude Code。

---

## Phase 3：让代理真正“会组织工作”

### 目标
从单轮工具循环，升级到具备 planning / decomposition / execution orchestration 的代理系统。

### 建议项

#### 1) 显式 planning 模式
- 在复杂任务开始前，先输出计划
- 用户确认后再执行
- 支持 plan-only 与 execute-plan 两种模式

#### 2) 任务分解
- 将复杂任务拆成可跟踪的步骤
- 每步有状态：open / in_progress / done / blocked
- 执行中动态更新任务树

#### 3) 子代理并行
适用场景：

- 多目录只读分析
- 不同文件的独立改动
- 测试定位与代码修改解耦

#### 4) 模式化策略
按任务意图切换策略：

- 分析模式：优先读、搜、建图
- 编辑模式：优先最小变更
- 重构模式：优先计划、影响面分析、批量验证
- 发布模式：优先门禁检查、打包、benchmark

### 验收标准
- 复杂任务不再只是“模型想到哪做哪”，而是可解释、可追踪、可恢复。

---

## Phase 4：补齐工程与隔离工作流

### 目标
让项目更接近 Claude Code 在真实代码库中的安全与工程实践。

### 建议项

#### 1) Git worktree / 分支隔离
- 每个复杂任务可选独立 worktree
- 降低污染主工作区的风险
- 更适合 benchmark、自动修复、批量实验

#### 2) 更强的 Git 辅助
- 自动总结 diff
- 推荐 commit message
- 将“提交前检查”标准化
- 更细的 staged/unstaged 展示

#### 3) 自动回顾与总结
- 每轮结束时生成“本轮做了什么”摘要
- 对修改文件、验证结果、失败原因做结构化总结
- 便于恢复与 handoff

#### 4) 更真实的发布路径
- 结合现有 benchmark:smoke / pack:verify / standalone
- 让代理能主动识别“当前接近发版任务”并切换发布模式

### 验收标准
- 复杂任务可在隔离环境执行。
- Git / 发布工作流足够顺手，可支撑真实日常开发。

---

## 三、最值得优先做的 10 项

如果只做最有价值的前 10 项，建议顺序如下：

1. `/plan` 命令
2. `/diff` 与 `/undo`
3. 多行输入
4. task list / 任务树 UI
5. 更细粒度 edit/patch 工具
6. grep / glob / finder 分层
7. 子代理任务委派
8. worktree / sandbox 隔离
9. 更强的会话检索与 focus 展示
10. 发布模式（check / pack / benchmark / standalone）

---

## 四、如果要“看起来更像 Claude Code”

除了能力本身，还应注意外观和操作感：

- 默认输出更短、更像终端搭子
- 工具调用过程更透明但不啰嗦
- 关键动作前有明确确认
- 修改后总能给出 diff / 验证 / 下一步
- 历史、恢复、计划、任务、撤销这些能力必须足够顺手

Claude Code 的像不像，很多时候不只是技术能力，而是：

> **用户是否感觉自己在和一个“会组织工作的终端工程助手”协作。**

---

## 五、建议的下一步落地顺序

### Milestone A：交互对齐
- `/plan`
- `/diff`
- `/undo`
- 多行输入
- completion summary 优化

### Milestone B：工具对齐
- grep / glob / edit 原语增强
- 更强的 patch 能力
- 结果聚合更清晰

### Milestone C：代理对齐
- planning
- task graph
- 子代理并行
- handoff

### Milestone D：工程对齐
- sandbox/worktree
- Git workflow 增强
- 发布模式

---

## 六、结论

当前项目已经具备了 Claude Code 的几个关键基础：

- agent loop
- tools
- validation
- session
- approval
- benchmark

要让它**更像 Claude Code**，最关键不是继续堆功能，而是围绕这四件事持续收敛：

1. **更强交互**
2. **更像样的工具原语**
3. **更会组织工作的代理层**
4. **更真实的工程隔离与发布工作流**

## 七、主要短板解决方案

当前最主要的短板可以按以下顺序解决：

1. **任务树 / Task Graph**：先在 orchestrator 外挂一个轻量任务状态模块，记录 `todo` / `doing` / `done` / `blocked`，并让交互模式的 `/tasks` 展示更细的任务状态。
2. **子代理 / Subtask**：新增只读型 `task` 工具，让主 Agent 可以把“分析某个目录”“定位某类问题”等子任务委派给独立上下文；第一阶段只允许只读工具，避免修改风险。
3. **Worktree 隔离**：新增 `--sandbox` 或 `run-in-worktree` 流程，让复杂修改先在临时 Git worktree 中执行和验证，通过后再提示用户合并回主工作区。

建议落地顺序：先做任务树，再做只读子代理，最后做 worktree 隔离。每一步都补充 focused tests、benchmark smoke，并保持 `npm test && npm run build` 通过。

## 八、当前剩余短板

三大短板已有第一版能力，但还需要继续补齐：

1. **长期项目记忆已有第一轮智能化**：`project_memory` 已支持跨 session 读写、敏感信息过滤、带来源/置信度/过期时间的事实、每轮结束后从摘要/修改文件/验证命令自动提取候选记忆，并在新任务开始时注入简短上下文；交互模式下自动候选会先展示 diff，用户可确认、拒绝或编辑画像后再保存。后续还缺更强 LLM 摘要和记忆衰减评分优化。
2. **Semantic finder 已从轻量路径/符号打分升级到 AST + embedding 信号版**：`semantic_find` 已结合路径、符号、依赖、引用、函数调用、注释关键词和可选 embedding provider 解释相关性；也支持本地 project map 缓存、provider 向量相似度 rerank、按候选文本哈希复用的向量缓存，以及导入函数/命名空间属性调用边解析到跨文件目标。后续可继续增强动态调用解析。
3. **Sandbox 自动合并更安全但还不完整**：已有 patch 产物、apply/check、patch 摘要、脏工作区拒绝和失败时保留 patch 提示；后续还缺交互式选择 apply、冲突分步处理、分支/PR 流程。
4. **子代理治理已有第一轮结构化**：`task_batch` 已有最大并发、结构化 done/failed/truncated、失败隔离和只读结果缓存；后续还缺全局 token/输出预算配置、缓存过期策略和更细重试建议。
5. **任务树更高阶能力已有恢复、重试与 timeline 入口**：已持久化并支持 `dependsOn` / `blockedReason` / 失败次数 / 历史记录展示，`/execute-task <id>` 可继续指定任务，`/retry-task` 可自动重试第一个依赖已满足的阻塞任务，`/tasks timeline` 可查看任务状态时间线；后续还缺更主动的自动 retry 调度。
6. **专项 benchmark**：新能力有单测/构建通过，但还缺专门 smoke benchmark 覆盖真实 agent 使用路径，尤其是 memory、semantic finder、task_batch、sandbox patch。

下一轮补齐建议按低风险顺序推进：

- 继续增强 `project_memory` 的 LLM 自动摘要、记忆冲突合并、衰减评分和用户审查命令。
- 继续增强 `semantic_find` 的属性调用和动态调用解析。
- 补 sandbox 交互式 apply、冲突处理、分支/PR 流程。
- 为 `project_memory`、`semantic_find`、`task_batch`、sandbox patch 补稳定 smoke benchmark。

## 九、高阶能力补齐计划

### 1. 智能长期记忆

目标：让 `project_memory` 从手动读写升级为自动沉淀项目画像。

计划：

- 已完成：在每轮任务结束时，从 final summary、修改文件、验证命令中提取候选记忆。
- 已完成：增加敏感信息过滤，避免保存 API key、token、邮箱等隐私内容。
- 已完成：为记忆增加来源、置信度、更新时间和过期时间，支持过期过滤与同文本高置信覆盖。
- 已完成：在新任务开始时，把项目画像、用户偏好、常用验证命令和事实注入为简短上下文。
- 已完成：自动生成轻量项目画像摘要，补足没有手动 overview 时的项目记忆入口。
- 已完成：支持 `/memory` 查看、`/memory remove <id>` 删除事实、`/memory overview <text>` 编辑画像、`/memory clear` 清空记忆。
- 已完成：记忆事实带稳定 id，便于用户审查和删除。
- 已完成：交互模式下自动记忆候选保存前展示 diff，并支持确认、拒绝或编辑项目画像后保存。
- 待增强：用 LLM 生成更高质量的项目画像摘要。
- 待增强：增加更细的记忆衰减评分策略。

验收：

- 不保存密钥和明显隐私信息。
- 恢复或新开任务时能读到项目偏好和常用命令。
- focused tests 覆盖提取、去敏、去重、过期和上下文注入。

### 2. 更强 Semantic Finder

目标：让 `semantic_find` 从轻量路径/符号打分升级为更接近“按概念找代码”。

计划：

- 已完成：扩展 AST 索引，加入函数调用、类方法调用和注释关键词。
- 已完成：结合导入导出链路、符号引用、依赖、角色返回“为什么相关”的解释。
- 已完成：生成本地 project map 缓存，避免重复查询时每次全量扫描。
- 已完成：可选接入 embedding provider，支持自然语言概念 token 扩展和向量相似度 rerank。
- 已完成：持久化向量缓存，按 provider + 候选文本哈希复用 entry embedding，避免 vector 模式重复嵌入未变化候选。
- 已完成：将导入函数和命名空间属性调用边解析到跨文件目标，进一步提升行为级定位。
- 待增强：继续增强动态调用解析。

验收：

- 能定位“session restore”“approval policy”“auto validation”等行为相关文件。
- 大仓库下使用缓存，避免明显变慢。
- benchmark smoke 覆盖真实 agent 使用路径。

### 3. Sandbox 交互式合并

目标：让 worktree sandbox 不只是生成 patch，而是形成安全合并工作流。

计划：

- 已完成：增加 `sandbox:apply` 命令，展示 patch 摘要后应用。
- 已完成：支持 `--check` 预检 patch 是否可应用。
- 已完成：目标工作区存在未提交改动时默认拒绝应用，可通过 `--allow-dirty` 显式覆盖。
- 已完成：冲突或 apply 失败时保留 patch 和失败原因，提示手动检查。
- 已完成：支持通过 `sandbox:apply --path <file>` 选择性应用 patch 中的部分文件。
- 已完成：支持通过 `sandbox:apply --hunk <n>` 选择性应用 patch 中的部分 hunk，也支持 `--interactive` 列出 hunks 后输入序号。
- 已完成：支持 `sandbox:branch <patch> <branch>` 从 patch 创建隔离分支 worktree，便于检查、提交或准备 PR。
- 待增强：交互式 hunk 选择 UI。
- 待增强：自动生成 PR 描述和远端推送/开 PR 流程。

验收：

- patch 可预检、可应用、失败时有清晰提示。
- 不自动覆盖用户本地未提交改动。
- focused tests 覆盖 patch 生成、apply check、失败路径。

### 4. 子代理治理

目标：让 `task_batch` 从简单并发升级为可控的子任务调度层。

计划：

- 已完成：增加子任务调度预算：最大并发数、最大轮数和最大输出长度。
- 已完成：每个子任务返回结构化状态：done / failed / truncated，并包含 roundsUsed、error、cached。
- 已完成：子任务失败不影响整批结果，主 Agent 能看到失败原因。
- 已完成：增加只读结果缓存，重复分析可复用最近结果。
- 已完成：增加整批 token 预算、缓存 TTL、失败重试建议和跨批次耗用统计。
- 已完成：增加批次取消参数、逐任务 progress、startedAt/finishedAt/durationMs，便于展示子代理进度 trace。
- 待增强：更精确的 tokenizer 统计和更主动的自动重试调度。

验收：

- 批量子任务中单个失败不会拖垮整批。
- 输出包含每个子任务状态和耗用轮数。
- tests 覆盖成功、失败、截断、缓存命中。

### 5. 任务树高级能力

目标：让任务树从状态展示升级为可恢复的执行计划。

计划：

- 已完成：增加任务依赖字段：`dependsOn`。
- 已完成：增加结构化阻塞原因：`blockedReason`。
- 已完成：支持 `/tasks` 展示依赖和阻塞原因。
- 已完成：支持恢复会话后执行指定任务：`/execute-task <id>`。
- 已完成：支持 `/retry-task` 自动重试第一个依赖已满足的阻塞任务。
- 已完成：长任务中自动把 completed / blocked 状态写入 session。
- 已完成：执行任务前自动检查依赖是否已完成。
- 已完成：记录每个任务的执行历史、失败次数和重试建议，并在 `/tasks` 中展示摘要。
- 已完成：支持 `/tasks timeline` 查看任务状态变化时间线。
- 待增强：更主动的自动 retry 调度。

验收：

- 恢复会话后任务树完整可见。
- 可选择一个未完成任务继续执行。
- tests 覆盖依赖、阻塞、恢复后继续执行。

### 6. 专项 Benchmark 与发布门禁

目标：把新能力纳入持续质量门禁。

计划：

- 已完成：增加 `memory-smoke`，覆盖 `project_memory` 读取、记忆动作、安全过滤、事实元数据和上下文注入。
- 已完成：增加 `semantic-finder-smoke`，覆盖 `semantic_find` 自然语言概念定位、AST 信号、缓存、调用边和 embedding fallback。
- 已完成：增加 `subtask-batch-smoke`，覆盖并发只读子任务、结构化状态、token 预算、缓存 TTL 和重试建议。
- 已完成：增加 `sandbox-patch-smoke`，覆盖 sandbox patch 生成、apply 预检、选择性路径应用、脏工作区保护和 branch worktree。
- 已完成：将上述稳定 smoke 纳入 `benchmark:smoke`，避免发布时回退。

验收：

- 已完成：`npm run benchmark:smoke` 已覆盖核心高阶能力；该脚本也被 CI 和 release workflow 调用。
- 已完成：release checklist 包含 `npm run benchmark:smoke` / `npm run release:check` 门禁。
- 已完成：benchmark 报告已按任务输出 passed/skipped/failureType，CI 可据此定位失败任务和失败类型。
- 已完成：benchmark 结果会追加写入 `.history.json`，用于长期趋势和成功率 delta 对比。

如果继续推进，建议下一步先做：

1. **Memory 审查体验增强**：继续完善自动记忆的逐条编辑/选择性保存。
2. **Semantic finder 动态调用解析**：继续增强变量别名和更复杂动态调用边。
3. **任务 timeline 与主动 retry**：补更细的任务时间线 UI，以及无需手动 `/retry-task` 的主动 retry 调度。
4. **Subagent 更主动调度**：在现有取消/progress trace 基础上补更精确 tokenizer 和主动 retry。
5. **Benchmark 趋势可视化**：在 `.history.json` 基础上生成更易读的趋势摘要或 CI 注释。
