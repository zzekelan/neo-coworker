# Neo Coworker

[English](README.md) · **简体中文**

**Neo Coworker** 是我用来处理一些日常工作的 file-system based Agent，拥有 tool-use，兼容标准 agent skills，权限审批，subagent，包括自动/手动 compact 在内的上下文管理，以及以文件夹为隔离的 workspace 等特性。

## 快速开始（桌面端）

- 在项目根目录执行以下命令，会自动安装依赖，并启动 Electron 桌面应用：
  ```bash
  bun run desktop:start
  ```

- 首次启动时，可以直接在桌面端设置界面里填写 LLM 参数。如果项目根目录存在 .env，它们会作为设置界面的初始默认值。

## Why Neo Coworker?

- **Because I love building it, dude.**

- **为什么不选择各大厂商的网页服务？**
  - 厂商提供的网页服务通常无法直接访问电脑的文件系统，需要手动搬运文件和改动
  - 工具调用被限制在厂商内置的沙箱里，无法调用本机命令、脚本或本地服务
  - 代码、笔记、私有数据需要传到第三方


- **为什么不选择各大厂商的 Agent？**
  - 各大厂商的 Agent 以 coding agent 居多，prompt 的优化几乎都是针对 coding 场景下的，且是针对自家模型的优化
  - 模型、价格、速率等被厂商绑定
  - **我能根据自己的需求做优化，而不用忍受一些傻逼设计**

## 环境要求

- [Bun](https://bun.sh/)
- 暂时仅支持 Linux, MacOS, Windows 建议使用 WSL。


## 运行时路径

Neo Coworker 区分 app-state root 和 workspace execution root。独立 server DB、桌面端 state、桌面端 settings，以及相邻的 `models.dev.json` cache 属于 app-state，使用 XDG 路径：

- config root：`$XDG_CONFIG_HOME/neo-coworker`，回退到 `~/.config/neo-coworker`
- data root：`$XDG_DATA_HOME/neo-coworker`，回退到 `~/.local/share/neo-coworker`

Workspace runtime 和 session storage 仍然保存在 workspace 本地 `.ncoworker` 下，包括 `workspaceRoot/.ncoworker/agent.sqlite`。Deep Research artifacts 是 workspace-local plain files，路径是 `.ncoworker/research/<topic>/`；MVP 不包含 research UI、source viewer 或 artifact viewer。

Skills 的加载优先级是 workspace `.ncoworker/skills`，user-global XDG config skills，然后是 materialized built-in skills，路径为 `$XDG_DATA_HOME/neo-coworker/builtin-skills/`。Skill create、patch、delete 只影响 workspace `.ncoworker/skills/**`。Built-in 和 user-global skills 仅可加载。

## 其它脚本

| 脚本 | 说明 |
| --- | --- |
| `bun run dev chat` | 启动 CLI 入口 |
| `bun run server` | 启动 HTTP/SSE 应用服务 |

## 文档

- 架构：`docs/ARCHITECTURE.md`
- 开发：`docs/dev/`


