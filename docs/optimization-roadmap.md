# 优化路线图

> 适用仓库：`mini-code-agent` / `mini-claude-code`
>
> 目标：在现有本地代码 Agent CLI 的基础上，继续向 Claude Code 风格体验靠拢，重点提升工具精度、交互可见性、编辑可靠性、会话长期使用体验和质量门禁。

## 当前已完成能力

近期已完成的关键增强：

- Orchestrator 并行工具调用状态合并修复。
- 自动验证、diagnostics、命令策略支持项目级配置。
- `project_map` 大目录扫描上限、稳定排序、关键文件评分。
- session 数据版本、索引清理、latest 指针修复、焦点信息展示。
- smoke benchmark、CI benchmark job、release workflow benchmark、README quality gates。
- 交互模式新增 `/plan`、`/diff`、`/undo`、`/tasks`、`/status`。
- 多行输入支持 fenced block 与反斜杠续行。
- `glob_files` 工具，用于 Claude Code 风格“先 Glob 定位文件”。
- `read_file` 支持 `offset/limit` 分页读取长文件。
- `run_command` 支持 `outputOffset/outputLimit` 分页输出。
- `search_text` 支持 `regex` 与 `caseSensitive`。

---

## 总体方向

后续优化建议分为六条主线：

1. **工具层继续对齐 Claude Code 工作流**：Glob / Grep / Read / Edit / Bash 分工更清晰。
2. **编辑可靠性增强**：降低文本替换失败率，提高局部修改可控性。
3. **交互 CLI 体验增强**：状态、配置、计划执行、diff、会话检索更可见。
4. **会话与撤销能力增强**：支持长期会话、多轮 undo、更强历史检索。
5. **质量与 benchmark 覆盖增强**：把新增能力纳入 smoke/full benchmark。
6. **产品化与发布收口**：权限策略、审计、文档、发布门禁持续对齐。

---

## P0：建议优先推进

### 1. 新增 `replace_range` 编辑工具

#### 背景

当前已有 `replace_text`、`insert_after`、`append_text` 等局部编辑能力，但 `replace_text` 依赖完整文本精确命中，遇到格式变化、长代码块或重复片段时容易失败。

#### 目标

新增按行范围替换的 `replace_range` 工具，适合模型在 `read_file offset/limit` 后进行稳定局部编辑。

#### 建议设计

输入字段：

- `path`: 文件路径。
- `startLine`: 起始行，1-based。
- `endLine`: 结束行，1-based，包含该行。
- `content`: 替换后的文本。
- `confirmed`: 工作区外写入确认标记。

行为：

- 仅允许工作区内直接修改，工作区外仍走现有确认机制。
- 修改前走 backup / undo snapshot 现有链路。
- 返回 diff preview。
- 对非法行号抛出清晰错误。

验收：

- 增加 `filesystem.test.ts` 覆盖单行、多行、文件头、文件尾、越界。
- `npm test && npm run build` 通过。

---

### 2. 新增 `tree_files` 目录树摘要工具

#### 背景

`list_files` 只展示单层目录；`project_map` 偏代码符号分析。理解陌生项目时，需要一个轻量目录树视图。

#### 目标

新增 `tree_files`，用于快速展示目录层级、文件数量和截断信息。

#### 建议设计

输入字段：

- `path`: 起始目录，默认 `.`。
- `maxDepth`: 最大深度，默认 3。
- `maxEntries`: 最大条目数，默认 200。
- `includeFiles`: 是否展示文件，默认 true。
- `confirmed`: 工作区外路径确认。

输出：

- 类似 tree 的文本或结构化 JSON。
- 明确返回是否截断、跳过目录数量。
- 复用已有忽略目录：`node_modules`、`.git`、`dist`、`.backup`、`.imports`。

验收：

- `tree_files` 加入 read-only 与 parallelizable 工具集。
- 大目录截断有测试。
- 系统提示建议“理解目录层级时先 tree_files 或 project_map”。

---

### 3. 多步撤销 undo stack

#### 背景

当前 `/undo` 只能撤销 Agent 最近一次文件修改。连续多轮修改后，只能回退最后一轮，长期交互时不够安全。

#### 目标

将单次 `lastUndoSnapshots` 扩展为 undo stack，支持连续撤销多轮 Agent 修改。

#### 建议设计

- Orchestrator 内维护 `undoStack: UndoSnapshot[][]`。
- 每轮成功产生文件修改时 push 一组 snapshots。
- `/undo` 默认 pop 最近一组。
- `/status` 显示可撤销轮数。
- 后续可扩展 `/undo <n>`。

验收：

- 新增连续两轮修改、连续两次 undo 的测试。
- 保持现有 `/undo` 行为兼容。

---

### 4. `/plan` → `/execute` 计划执行流

#### 背景

已经支持 `/plan <task>` 只读规划，但规划结果还不能作为一个明确的待执行计划被复用。

#### 目标

新增 `/execute`，执行最近一次 `/plan` 对应的原始任务或整理后的计划。

#### 建议设计

- interactive 中保存 `lastPlanTask` 与 `lastPlanText`。
- `/execute` 无参数时执行最近计划。
- `/execute <task>` 可作为普通执行别名或覆盖计划。
- 执行前打印计划摘要，必要时二次确认可后续再做。

验收：

- `/plan` 不修改文件。
- `/execute` 调用 `agent.run()`。
- 无计划时提示先运行 `/plan <task>`。

---

## P1：交互体验与可见性增强

### 5. 新增 `/config` 配置可见性

#### 目标

让用户能快速看到当前运行配置，减少排查成本。

#### 建议展示

- 工作区路径。
- 用户数据目录。
- `.env` 是否加载。
- 模型相关环境变量是否存在，不展示密钥明文。
- validation command / diagnostics command。
- command policy 配置来源。
- 当前 package.json `miniClaudeCode` 配置摘要。

验收：

- 不泄露 `OPENAI_API_KEY` 等敏感值。
- 配置缺失时给出 init / doctor 提示。

---

### 6. Git / diff 体验增强

#### 可做项

- `/diff <path>`：查看指定文件 diff。
- `/diff --staged`：查看 staged diff。
- `/status` 中展示 staged / unstaged / untracked 分类数量。
- 变更预览中对超长 diff 做分页或截断提示。

验收：

- `interactive.test.ts` 覆盖 path 与 staged 参数解析。
- 保持现有 `/diff` 兼容。

---

### 7. `/sessions <query>` 会话检索

#### 背景

目前 `/sessions` 只展示最近会话。随着长期使用，会话数量增加后需要检索。

#### 目标

支持按关键词过滤会话标题、摘要、最近用户消息。

#### 建议设计

- `/sessions`：现有行为。
- `/sessions auth`：过滤包含 `auth` 的会话。
- 后续可支持 `after:`、`before:`、`limit:`。

验收：

- `sessions.test.ts` / `interactive.test.ts` 覆盖过滤逻辑。
- 空结果提示清晰。

---

## P2：工具层继续增强

### 8. `search_text` 结果质量增强

已完成：

- `regex`。
- `caseSensitive`。
- 多 query 搜索。
- `includeLineNumbers` 控制。
- 搜索结果按文件聚合。
- 返回总命中数与截断信息。
- 正则错误信息更友好。

已完成：

- 搜索结果按文件/行号稳定去重。
- 多 query 搜索时支持 `matchMode: any | all`。
- `resultOffset` + `maxResults` 结果分页。

---

### 9. 命令工具进一步分页与复查

已完成：

- `run_command outputOffset/outputLimit`。
- `read_command_output` 单独读取上一次命令输出的后续页，避免重跑命令。
- 对失败命令自动提取关键错误段 `errorSummary`。

已完成：

- 对 stderr 优先展示策略：失败时返回 `preferredStream/preferredOutput`。
- 命令超时后返回部分输出与 `failureReason`。

---

### 10. 二进制/图片/PDF 只读摘要

#### 背景

目前文档导入已支持部分 Office/PDF 文本抽取，但工具层仍缺少统一的“文件摘要/类型识别”。

#### 目标

已新增轻量 `inspect_file` 工具：

- 返回文件大小。
- 返回 MIME/扩展名。
- 判断是否可能是文本。
- 对 PNG/JPEG/GIF/WebP 返回尺寸。
- 对 PDF 返回页数。
- 对二进制文件提示使用 import/extract 路径。

后续可继续做：

- 支持 HEIC 等更多图片格式尺寸识别。

---

## P3：benchmark 与质量矩阵

### 11. 为新增能力补 benchmark smoke 任务

已新增覆盖：

- `glob_files` 定位文件。
- `search_text regex/caseSensitive/resultOffset/matchMode`。
- `read_file offset/limit`。
- `run_command outputOffset/outputLimit/errorSummary/preferredOutput`。
- `inspect_file` 与 `read_command_output`。
- `/status`、`/config`、`/diff --staged`、`/sessions <query>`、`/execute` 交互状态。
- `replace_range`、`tree_files`、`/execute` 等 P0 能力。

验收：

- benchmark smoke 不显著增加 CI 时间。
- 新能力有至少一个回归任务覆盖。

---

### 12. 发布门禁继续收口

当前基础已具备，后续继续保持：

- 开发门禁：`npm test`、`npm run build`。
- 发布候选门禁：`npm run check`、`npm run pack:verify`。
- 正式发布门禁：standalone build、smoke benchmark、关键 CLI 回归。

已补充：

- `docs/release-checklist.md`。
- CI job 总结说明。
- benchmark 成功阈值说明。

---

## 建议执行顺序

建议按低风险、高收益顺序推进：

1. **`replace_range`**：直接提升编辑成功率。
2. **`tree_files`**：提升陌生项目理解体验。
3. **undo stack**：提升交互修改安全性。
4. **`/execute`**：完善 plan workflow。
5. **`/config`**：提升配置可见性和排障体验。
6. **Git / sessions 交互增强**：完善日常使用体验。
7. **benchmark 覆盖新增能力**：把能力沉淀为质量门禁。

---

## 每次改动的最小验收

常规代码改动：

```bash
npm test
npm run build
```

涉及 CLI、发布、benchmark 或 package 行为时，额外建议：

```bash
npm run check
npm run pack:verify
npm run benchmark:smoke
```

涉及 standalone 发布链路时，额外建议：

```bash
npm run build:standalone:gha
```
