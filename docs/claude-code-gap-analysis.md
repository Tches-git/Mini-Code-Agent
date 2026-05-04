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

1. **任务树还偏记录型**：目前只是粗粒度状态展示，还缺少模型可显式创建/更新任务、任务依赖和阻塞原因。
2. **子代理还偏浅**：`task` 只读子代理目前只跑一轮 LLM，不能多轮使用工具深入探索，也没有结果缓存和并发预算。
3. **Sandbox 还未形成合并流**：能在 worktree 里跑任务，但还缺 diff 汇总、选择性 apply/merge、失败时保留排查指引。
4. **缺少模式化策略**：分析、编辑、重构、发布还没有不同的策略提示、工具偏好和执行预算。
5. **长期记忆仍弱**：session 有摘要，但还没有跨会话项目记忆、用户偏好和常用验证命令学习。
6. **没有真正 semantic finder**：现在是 glob/search/project_map，还没有语义级代码定位工具。

下一轮补齐建议按低风险顺序推进：

- 先补任务树显式更新工具和模式化策略提示。
- 再把子代理扩展为有限多轮只读探索。
- 然后补 sandbox diff 汇总与保留指引。
- 最后推进长期记忆和 semantic finder。

如果继续推进，建议下一步先做：

- `docs/claude-code-milestones.md`（里程碑拆分）
- `/plan` + `/diff` + `/undo`
- grep / glob / edit 工具分层
