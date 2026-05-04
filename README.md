# Mini Claude Code

一个本地运行的代码 Agent CLI。它可以在你的项目里搜索、读写文件、执行受控命令、查看 Git diff，并在修改后自动跑验证。

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

## 特性

- 交互式代码助手：`mini-claude-code -i`
- 单次任务执行：`mini-claude-code "修复这个测试"`
- 文件工具：读取、搜索、创建、替换、按范围修改
- 命令工具：执行安全命令，高风险命令需要确认
- Git 工具：查看状态、diff、log、暂存和提交
- 自动验证：根据变更自动运行 lint / test / build，并尝试修复失败
- 会话恢复：保存历史上下文，可按 ID 恢复
- 本地优先：工作区文件和会话数据保存在本机

## 安装

### 从源码运行

```bash
git clone https://github.com/Tches-git/Mini-Code-Agent.git
cd Mini-Code-Agent
npm install
npm run build
npm link
```

### 从 tarball 安装

```bash
npm install -g ./mini-claude-code-0.1.0.tgz
```

也可以在 GitHub Releases 下载 standalone 可执行文件。

## 配置

在目标项目目录初始化：

```bash
mini-claude-code init
```

编辑生成的 `.env`：

```bash
OPENAI_API_KEY=your-api-key
# OPENAI_BASE_URL=https://api.openai.com/v1
# MODEL_NAME=gpt-5.4
```

检查环境：

```bash
mini-claude-code doctor
mini-claude-code doctor --ping
```

## 使用

```bash
# 进入交互模式
mini-claude-code -i

# 对当前目录执行一次任务
mini-claude-code "分析项目结构并指出可以改进的地方"

# 指定工作区
mini-claude-code --cwd ~/work/my-project -i
mini-claude-code --cwd ~/work/my-project "修复 TypeScript 错误"
```

交互模式常用命令：

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看帮助 |
| `/plan <task>` | 只生成计划，不修改文件 |
| `/execute [task]` | 执行最近计划或指定任务 |
| `/diff [--staged] [path]` | 查看 diff |
| `/status` | 查看当前状态 |
| `/config` | 查看配置 |
| `/tasks` | 查看上一轮步骤 |
| `/undo` | 撤销 Agent 最近一次文件修改 |
| `/sessions` | 查看会话列表 |
| `/resume <id>` | 恢复会话 |
| `/approvals` | 查看审批记录 |
| `/clear` | 清空上下文 |
| `/exit` | 退出 |

## 项目结构

```text
src/
  cli/        CLI 入口、交互模式、sessions、approvals、benchmark
  agent/      Agent 编排、审批、验证、会话、摘要
  tools/      文件、搜索、命令、Git、diagnostics 工具
  llm/        OpenAI 兼容客户端和环境配置
  benchmark/  内置 benchmark 任务
  utils/      logger、diff、path、token 等基础工具
```

## 开发

```bash
npm test
npm run build
npm run lint
npm run check
```

发布相关：

```bash
npm run pack:verify
npm run build:standalone
npm run benchmark:smoke
npm run release:check
```

## 安全说明

Mini Claude Code 默认只在当前工作区内操作。访问工作区外路径、安装依赖、推送代码等高风险动作会请求确认，并写入审批日志。

## License

MIT
