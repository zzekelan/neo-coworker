# 本地 Server-Client 运行说明

这份文档对应 2026-03-09 server-client milestone 的本地单机运行方式。

## 1. 启动独立 Server

独立 server 进程负责：

- 持有 SQLite 状态
- 接收 HTTP API 请求
- 通过 SSE 推送实时事件
- 在服务端执行 runtime、工具调用和权限流程

最小启动方式：

```bash
export LLM_PROVIDER=openai
export LLM_API_KEY=your-key
export LLM_MODEL=gpt-5

export AGENT_SERVER_HOST=127.0.0.1
export AGENT_SERVER_PORT=3100
export AGENT_SERVER_DB_PATH="$PWD/.agents/server.sqlite"

bun run server
```

如果使用 `openai-compatible`，还需要：

```bash
export LLM_PROVIDER=openai-compatible
export LLM_API_KEY=your-key
export LLM_MODEL=your-model
export LLM_BASE_URL=https://your-endpoint.example/v1
```

启动成功后，进程会输出两行：

```text
server.started http://127.0.0.1:3100
server.storage /absolute/path/to/.agents/server.sqlite
```

默认值：

- `AGENT_SERVER_HOST`: `127.0.0.1`
- `AGENT_SERVER_PORT`: `3100`
- `AGENT_SERVER_DB_PATH`: `<server 启动目录>/.agents/server.sqlite`

## 2. 让 CLI 连到这个 Server

CLI 在设置了 `AGENT_SERVER_URL` 后，会走 server-client 路径，不再本地自启临时 server。

`AGENT_SERVER_URL` 只接受根地址，例如 `http://127.0.0.1:3100`，不接受带路径、query 或 hash 的值。

```bash
NO_PROXY=127.0.0.1,localhost \
AGENT_SERVER_URL=http://127.0.0.1:3100 \
bun run src/main.ts run "Read README.md and summarize it"
```

继续同一个 session：

```bash
NO_PROXY=127.0.0.1,localhost \
AGENT_SERVER_URL=http://127.0.0.1:3100 \
bun run src/main.ts run --session session_xxx "Continue the last discussion"
```

说明：

- 这里显式加 `NO_PROXY=127.0.0.1,localhost`，是为了避免本机代理错误拦截 loopback 请求。
- `run` 命令仍然支持 `--session` 和 `--`，自由文本 prompt 不会继续被当作 flag 解析。

## 3. SQLite 状态文件在哪里

有两种本地运行形态：

- 独立 server 模式：状态文件在 `AGENT_SERVER_DB_PATH`，默认是 `<server 启动目录>/.agents/server.sqlite`
- 直接 CLI 本地模式：不设置 `AGENT_SERVER_URL` 时，CLI 会走本地嵌入式 server/client 路径，状态文件在 `<workspaceRoot>/.agents/agent.sqlite`

当前 milestone 的 durable source of truth 是 SQLite，不是 SSE。

## 4. `session`、`run`、`message`、`part` 的关系

- `session`: 长生命周期会话容器，绑定工作目录和历史上下文
- `run`: session 内一次用户触发的执行尝试；一条新 prompt 对应一个新 run
- `message`: run 内的一条用户、assistant 或 synthetic 消息
- `part`: message 内最小的结构化片段，比如 `text`、`tool_call`、`tool_result`、`error`
- `permission_request`: 绑定到某个 run 的服务端权限工作流对象，不只是 CLI 临时提示

层级关系：

```text
Session
  -> Run
    -> Message
      -> Part
```

## 5. 常见错误长什么样

常见 operator/developer 失败场景会返回明确错误，不会只给一个泛化异常：

- 缺少 session：`404 not_found`, 例如 `Unknown session: session_missing`
- 缺少 run：`404 not_found`, 例如 `Unknown run: run_missing`
- 缺少 permission request：`404 not_found`, 例如 `Unknown permission_request: permission_missing`
- session 已有活跃 run：`409 invalid_state`, 例如 `Session <id> already has active run <runId>`
- 数据库初始化或迁移失败：直接报错 `Failed to initialize storage at <path>: ...`

## 6. 当前验证到的恢复边界

已经验证：

- 已持久化 session 在进程重启后仍可读
- 同一个 session 的两次 run 以及完整 transcript 在重启后仍可见
- `completed` run 在重启后仍然是 `completed`
- `failed` run 在重启后不会被错误显示成 `completed`
- `cancelled` run 在重启后不会被错误显示成 `completed`

仍然要明确说明的 phase-1 风险和边界：

- SSE 只负责实时事件，不做历史回放。客户端重连后必须重新拉取 `session`、`run`、`transcript`
- 进程重启后，如果某个 run 之前停在 `waiting_permission`，旧的活跃 runtime 已经不存在，权限回复会返回 `invalid_state`
- active-run enforcement 目前是“每个 session 同时只允许一个活跃 run”
- 这份 milestone 只覆盖本地单机、单用户，不包含远程多用户部署
