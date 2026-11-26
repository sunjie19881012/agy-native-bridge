# agy-native-bridge 工程规格书（Codex 施工基准）

> 本文档是 `agy-native-bridge` 的权威工程规格书，面向执行开发的本机 Codex（P1 → P4 分阶段实现）。所有协议细节、路径、工具契约、安全护栏和纪律均已核实并写明，请先通读后再动手编码。

---

## 一、项目定位与四条硬底线

**定位**：以 **Antigravity** 为日常调度中枢，通过极薄的原生直连插件打通 **Windows 本机 Codex** 与 **101 Ubuntu Codex**（P3 扩展 DSH），支撑“办公室下班前派活 → 101 迷你主机 24 小时无人值守执行 → 回家打开 Antigravity（或 RDP）随时续看/接手”。

**四条不可妥协的硬底线**（严禁退化为无头 `codex exec` 子进程）：

1. **原生窗口可见会话**：发出的指令必须进入目标客户端真实的原生会话，本机或 RDP 连 101 后在原窗口立即可见完整对话。
2. **原生窗口权限审批**：绝不代答审批、不偷偷放宽沙盒权限；触发人工审批时由原窗口正常弹窗，调度端仅感知并展示等待审批状态。
3. **沿用会话已生效的设置**：调用 `thread/resume`、`turn/start`、`turn/steer`、`send_message_to_thread` 等原生接口时，**严禁传模型、思考强度或覆盖性沙盒参数**，完全沿用该会话最后一次发送时保存并已生效的模型、思考强度与审批设置（仅在原窗口下拉框切换但尚未发送的修改不会自动生效；须在 `SKILL.md` 提醒）。
4. **零中心、零数据库、零常驻隧道**：不搭建中心服务端、不写 MySQL/SQLite 业务表、不维护 101 常驻连接器与 24h SSH 长隧道。101 Codex Daemon 自身即状态源；发完指令拿到 `turn.id` 回执即可断开，随时按需重连读取状态与结果。若真机验证发现 101 桌面关闭时短连接会导致会话卸载或审批丢失，允许在 101 侧拉起按单轮次、有时限的轻量守护进程维持订阅，轮次结束即退出且绝不代答审批。

---

## 二、既定拍板参数（老板已确认）

| 决策项 | 定稿值 |
|---|---|
| P1 首批接入范围 | **双端 Codex**：Windows 本机 Codex + 101 Ubuntu Codex（DSH 留到 P3） |
| Windows 本机管道发现 | **完全独立、零依赖旧协作台服务**的极简 Hook |
| 心跳默认节奏 | • 有 `active` 或 `waiting_approval` 任务：**30 秒**<br>• 全空闲：**5 分钟**<br>• 窗口 / 侧边栏激活：**15 秒防抖刷新**<br>• 连续探测离线退避：**10 分钟**<br>• 动作后（派活/中断/新建）：**即时 + 第 5 秒 + 第 15 秒补探** |
| 项目与插件命名 | `agy-native-bridge` |
| 源码目录 | `<workspace>/projects/agy-native-bridge/` |
| 插件安装目录 | `%USERPROFILE%\.gemini\config\plugins\agy-native-bridge\` |
| 本地状态目录 | `%USERPROFILE%\.gemini\config\agy-native-bridge\` |
| 分工模式 | 本机 Codex 按阶段编码 + 跑单测/离线自检；每个阶段结束后由用户与 Antigravity 验收，确认通过后再启动下一阶段 |

---

## 三、本机参考资产与连接规范（只读核对）

开始编码前，按以下连接规范与插件结构核对既有约束：

### 3.1 101 Codex 连接协议定稿（默认 A 路桌面管道，禁止自动抢写 B 路）
- **远端双后端真相（已真机实证）**：Linux 主机上若开启了桌面端（A 路，监听 `/tmp/codex-app-tools-<uid>/*.sock`），桌面端持有打开会话的 `active writer`；如果另外通过独立 `codex app-server --listen unix://`（B 路，`/home/user/.codex/app-server-control/app-server-control.sock`）去 `thread/resume`，会触发 `already has an active writer` 或抢走写锁导致桌面原窗口不可操作。
- **默认路由策略（`config.remote.transport = "desktop-pipe"`）**：
  - **默认只走 A 路（`desktop-pipe`）**：通过单条按需 `ssh -T` 自动发现远端当前用户存活的 `/tmp/codex-app-tools-<uid>/*.sock`（按当前 `id -u` 扫描并验证最新可用 `codex-app-tools` socket，无需在远端安装任何 Hook 或常驻服务），走与 Windows `win-pipe.mjs` 完全一致的 **4 字节小端长度头 + UTF-8 JSON-RPC** 协议；
  - A 路白名单包括 `list_threads`、`read_thread`、`send_message_to_thread`、`get_usage_limits`、`list_projects`、`create_thread`、`set_thread_title`。守望进程仅允许 `read_thread`；
  - **严禁自动回退到 B 路（`app-server-control.sock`）抢写**；B 路仅保留给显式手动配置 `config.remote.transport = "daemon"` 的纯无桌面服务器场景。
- **连接基线**：
  - B 路协议：`codex app-server` Unix Socket + WebSocket JSON-RPC；
  - A 路协议：Codex Desktop App-Tools 4 字节小端长度头 + UTF-8 JSON-RPC；
  - SSH 目标：默认别名 `codex-101`（走本机 `~/.ssh/config` 免密配置；支持 `remote.sshTarget` 覆写）；
  - **连接方式**：按需短连接（单条 `ssh -T` 拉起远端单次 Node/stdio Socket 桥接），完成调用拿到回执后立即关闭；Windows 自带 OpenSSH 不支持 `ControlMaster`，因此每轮心跳复用**单条** SSH 短连接一次扫完目标集合。
- **远端 `node` 路径与 B 路白名单**：
  - 若远端 Node 位于 nvm 目录（非交互 `ssh -T` 默认不加载 `.bashrc`），须支持 `config.remote.nodeBin` 显式配置，并在未配置时自动按 `PATH` → `~/.nvm/versions/node/*/bin/node` 回退探测。
  - 仅在显式配置 `daemon` 模式时使用 `thread/list`、`thread/loaded/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/resume`、`thread/start`、`thread/name/set`、`turn/start`、`turn/steer`、`turn/interrupt`、`account/rateLimits/read`。守望进程仅允许 `thread/read` 和 `thread/turns/list`。
- **已知实测坑点**：
  1. 远端 Codex Daemon（B 路）**不会**按 `clientUserMessageId` 自动去重；A 路 `send_message_to_thread` 同样应在未知回执时禁止自动重发，先调 `bridge_read` 核对；
  2. A 路 `bridge_send` 回传 `beforeTurnId`（派活前最新轮次 ID），`bridge_interrupt` 返回 `delivery_mode_unsupported`（与 Windows 管道一致），额度查询直接走 `get_usage_limits`（B 路走 `account/rateLimits/read`）；
  3. A 路通过 `tools/list` 匹配 `tool.namespace` 并使用 `callerSource: "codex"`。真机上 `list_threads` 和 `get_usage_limits` 的信封 `threadId` 必须是远端上真实存在的会话 UUID，随机 UUID 会返回 `-32000 Codex app tool request failed`。调用优先使用目标 `args.threadId`，其次使用 `remote.callerThreadId`，最后使用同一条 SSH 从 `$HOME/.codex/sessions` 最新修改的 rollout 文件名提取、经 stderr 回传的 UUID。

### 3.2 Windows 本机 Codex 协议与极简管道发现
- 核心适配器：`src/adapters/win-codex.mjs`、`src/adapters/win-pipe.mjs`、`src/adapters/desktop-codex.mjs`、`src/adapters/win-rollout.mjs`（大历史 `rollout-*.jsonl` 增量流式读取最终回答兜底）、`src/shared/conversation.mjs`（公开消息过滤、敏感字段脱敏、字符预算裁剪）。
- Windows 免 Hook 自动发现 + 可选 Hook 提示（无本地常驻网关依赖）：
  - **默认免 Hook 自动发现（`win-codex.mjs`）**：启动连接时直接扫描本机 `\\.\pipe\`，匹配 `app-tools` 管道正则 `^\\\\\.\\pipe\\codex-app-tools-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`（忽略大小写；不接受 `browser-use` 管道），并从 `win.sessionsRoot` 下最新修改的 `rollout-*-<uuid>.jsonl` 提取真实调用会话 UUID（也支持 `config.json` 可选配置 `win.callerThreadId`）；Codex 桌面端重启换管道后自动重连，无需强依赖 Hook。
  - **可选极简 Hook 提示（`codex-pipe-hook.mjs`）**：当存在多窗口并配置启用 Hook 时，在 `SessionStart` / `UserPromptSubmit` 校验 `process.platform === 'win32'`、`CODEX_APP_TOOLS_PIPE_PATH` 合法且 `session_id`（与可选 `CODEX_THREAD_ID`）匹配后，原子写入 `%USERPROFILE%\.gemini\config\agy-native-bridge\win-codex-pipe.json`（仅 `{ endpoint, callerThreadId, updatedAt }`，不含正文、prompt 或凭据；支持 `AGY_NATIVE_BRIDGE_HOME` 隔离）。若发现文件指向旧失效管道，自动跳过并选用活动管道；非桌面场景静默退出。
  - **协议与白名单**：4 字节小端长度头 + UTF-8 JSON-RPC，工具白名单与 101 桌面管道一致。

### 3.3 Antigravity 插件与 Sidecar 结构
- 插件清单、MCP 与 Hook：`plugin.json`、`mcp_config.json`、`hooks.json`
  - `mcp_config.json` 将高频工具 `bridge_list`、`bridge_status`、`bridge_read`、`bridge_send` 标记为 `"eager": true`（在 `mcpServers.<name>.tools` 下声明），避免每次对话先读取工具 schema。
  - Antigravity 内置 `mcp_config.json` 支持 `${PLUGIN_ROOT}` 占位符解析插件路径。
- Sidecar 侧边栏看板：`sidecars/native_bridge/sidecar.json`
  - 结构须包含 `command`、`args`、`has_web_ui: true`、`restart_policy: "always"`，以及 `ui_config.views[].entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE"`（`path: "/"`）。
  - Sidecar 启动时将本地监听地址/端口写入 `%USERPROFILE%\.gemini\config\agy-native-bridge\sidecar-runtime.json`（含 `port`、`pid`、`updatedAt`），供 MCP 发送 `/api/nudge`；通知失败静默降级，绝不影响派活主流程与返回结果。

### 3.4 微信通知与 DSH Bridge
- Server酱请求：POST `https://sctapi.ftqq.com/${SCT_KEY}.send`（表单字段 `title` / `desp` / `noip=1`，校验 `code === 0`），SendKey 由远端守望进程从本机读取。
- DSH Bridge 2.10 认证：通过 `GET /?auth=<bridgeToken>` 换取 `dsh_bridge_auth` Cookie 并携带 `X-Collab-Token` 访问 `/api/agent-collaboration`。

---

## 四、目标工程目录结构

```text
projects/agy-native-bridge/
├── SPEC.md                          # 本规格书
├── README.md                        # 安装、配置与日常使用说明
├── package.json                     # Node.js >=22.13 ESM；最小依赖（仅 ws）
├── plugin.json                      # Antigravity 插件元数据
├── mcp_config.json                  # Antigravity MCP 注册配置（${PLUGIN_ROOT}）
├── hooks.json                       # P2: Antigravity SessionStart 摘要注入 Hook
├── configs/
│   └── config.example.json          # P3: 多机与可选 DSH 配置模板
├── docs/
│   └── MULTI-MACHINE.md             # P3: 办公室、家里电脑和 101 的配置说明
├── skills/
│   └── native-bridge/
│       └── SKILL.md                 # 指导 Antigravity 正确派活、防重发、控上下文
├── src/
│   ├── shared/
│   │   ├── config.mjs               # 读写本地 config.json / 状态目录解析
│   │   ├── state.mjs                # 统一状态归一化（active/idle/waiting_approval/paused/offline/unknown）
│   │   ├── conversation.mjs         # 公开消息过滤、凭据遮盖、字符上限裁剪
│   │   └── errors.mjs               # 明确错误码（UNKNOWN_OUTCOME / PIPE_UNAVAILABLE / SSH_UNREACHABLE 等）
│   ├── adapters/
│   │   ├── win-codex.mjs            # Windows 本机 Codex 管道直连 + rollout 兜底
│   │   ├── remote-codex.mjs         # 101 Codex Daemon 按需 SSH 桥接直连 + reconcile
│   │   ├── remote-watcher.mjs       # P3: 通过单条 SSH 启动守望
│   │   ├── watcher-runtime.mjs      # P3: 101 上的只读轮询与微信通知
│   │   └── dsh.mjs                  # [P3] 本机 / 101 DSH Bridge 适配器
│   ├── hooks/
│   │   ├── codex-pipe-hook.mjs      # [P1] 给本机 Codex 装的极简管道发现 Hook
│   │   └── agy-session-start.mjs    # [P2] 给 Antigravity 注入 <100 Token 状态摘要
│   ├── mcp/
│   │   └── server.mjs               # [P1] stdio JSON-RPC MCP Server（6 个工具）
│   └── sidecar/                     # [P2]
│       ├── server.mjs               # 零 Token 心跳引擎 + 本地状态缓存 + HTTP UI 服务
│       ├── heartbeat.mjs            # 四级调度器（30s / 5m / 15s防抖 / 10m退避 / 5s+15s补探）
│       └── ui.html                  # 侧边栏状态看板（AUX_PANE）
├── sidecars/
│   └── native_bridge/
│       ├── sidecar.json             # [P2] Antigravity Sidecar 声明
│       └── entry.mjs                # [P2] 转调 ../../src/sidecar/server.mjs
├── scripts/
│   ├── install.ps1                  # [P1] 同步插件到 ~/.gemini/config/plugins/agy-native-bridge 并安装依赖
│   ├── install-codex-hook.ps1       # [P1] 安全地向本机 Codex hooks 注册/卸载管道发现 Hook（幂等、保留既有 Hook）
│   └── 101-turn-watcher.mjs         # [P3] 101 侧一次性完成/卡审批 Server酱提醒脚本
└── test/
    ├── state.test.mjs
    ├── conversation.test.mjs
    ├── codex-pipe-hook.test.mjs
    ├── win-codex.test.mjs
    ├── remote-codex.test.mjs
    ├── mcp-server.test.mjs
    └── heartbeat.test.mjs           # [P2]
```

> 运行时与工程文件分离：本地用户配置 `config.json`、管道发现缓存 `win-codex-pipe.json`、状态快照 `state.json` 全部放在 `%USERPROFILE%\.gemini\config\agy-native-bridge\`，不得污染插件安装目录或 Git 工作区。

---

## 五、MCP 工具精确契约（共 6 个工具）

MCP 协议遵循 stdio JSON-RPC（兼容 `2024-11-05` / `2025-03-26` / `2025-11-25`）。

### 5.1 统一目标标识（`target`）
- P1 支持：`'win-codex'` | `'101-codex'`（`bridge_list` 另外支持 `'all'`，默认 `'all'`）。
- P3 扩展：`'win-dsh'` | `'101-dsh'`。
- DSH 每端独立配置。未配置的目标不参加 `bridge_list(target="all")`、Sidecar 心跳和侧栏展示。显式调用时返回 `DSH_NOT_CONFIGURED`。

### 5.2 工具清单与输入输出规范

#### 1. `bridge_list`（只读）
- **输入**：`{ target?: 'all' | 'win-codex' | '101-codex' | 'win-dsh' | '101-dsh', fresh?: boolean, limit?: number }`
- **行为**：列出目标端最近/已加载原生会话。`fresh !== true` 时优先读 Sidecar 本地缓存（缓存有效上限为 **2 个当前心跳周期且最多 10 分钟**；P1 尚无 Sidecar 时直接实探）；`fresh === true` 强制实探并更新缓存。单端默认上限 30 条。
- **返回字段**：`{ sampledAt, cacheAgeMs, stale, targets: { [target]: { reachable, error?, sessions: [{ target, sessionId, title, workspacePath, state, activeTurnId, activeFlags, updatedAt }] } } }`

#### 2. `bridge_status`（只读）
- **输入**：`{ target, sessionId }`（均为必填）
- **行为**：实时探测单个原生会话当前状态（`active` / `idle` / `waiting_approval` / `paused` / `offline` / `unknown`）、`activeTurnId`、`activeFlags`、最新一轮 `latestTurn: { id, status }` 及标题/工作区；P2 可附带 101 Codex 剩余额度摘要（A 路调 `get_usage_limits`，显式 B 路调 `account/rateLimits/read`）。
- **注意**：在按需短连接模式下，识别 `waiting_approval` **仅依赖 `thread.status.activeFlags`**（匹配 `approval|input`），短连接不保留历史服务端推送的待审批通知。

#### 3. `bridge_read`（只读）
- **输入**：`{ target, sessionId, limit?: number, cursor?: string, maxChars?: number }`
- **默认上限**：`limit` 默认 `3`（最多 `20`），`maxChars` 默认 `12000`（硬上限 `24000`），保护 Antigravity 上下文窗口。
- **行为**：分页拉取公开问答（仅 `userMessage` 与 `phase` 为 `commentary`/`final_answer` 的 `agentMessage`），过滤系统指令、内部思考和冗长工具调用，对明显凭据字段做遮盖，标明 `pageTruncated`、`nextCursor` 和 `sampledAt`。
- **兜底**：本机 Codex 若当前管道摘要缺失最终文本且轮次已 `completed`，按 `codex-rollout.mjs` 增量读取本地 `rollout-*.jsonl` 补齐。

#### 4. `bridge_send`（写操作）
- **输入**：`{ target, sessionId, expectedWorkspace, prompt, mode?: 'queue' | 'steer', operationId?: string, notifyOnFinish?: boolean, autoReadOnFinish?: boolean }`（`expectedWorkspace` **必填**）
- **行为**：
  1. 发送前先 `inspect` 目标会话当前状态，**强制核对 `sessionId` 与真实 `thread.cwd` 必须匹配调用方传入的 `expectedWorkspace`**（归一化路径比较，不符直接返回 `not_sent` / 身份不匹配，防止抄错会话 ID 发串会话）；
  2. 不传入任何模型、思考强度或沙盒覆盖参数，沿用该会话最后一次发送时保存并已生效的设置；
  3. 仅在状态允许时发送（`win-codex` 与 101 默认 A 路 `desktop-pipe` 均调 `send_message_to_thread`，若 `mode === 'queue'` 且当前 `active`，**并不在本地或远端实际排队，而是直接返回 `not_sent / queue_waiting_for_idle`**，由调用方稍后重派或等 Sidecar 提示空闲后再发，并在 `SKILL.md` 写明；仅在显式配置 B 路 `remote.transport = "daemon"` 时在 `idle` 调 `turn/start`、在 `active` 且 `mode === 'steer'` 调 `turn/steer`）；发送内容前置可追溯标记 `[AGY_BRIDGE_OP:<operationId>]`；
  4. **必须等待原生接口返回确认回执**：`desktop-pipe`（Windows 与 101 默认 A 路）回传 **`beforeTurnId`**（派活前读取到的最新轮次 ID），以便后续区分本次新产生轮次；显式 B 路 `daemon` 须含 `turnId` 后才返回 `result: 'accepted'`；
  5. 若发生超时或连接中途断开，**必须返回 `result: 'unknown'` 并提示先调 `bridge_read`（B 路可用 `reconcile`）核对，严禁内部自动重试**；P2 另加 60 秒同 `sessionId + prompt` 防手抖重投保护；
  6. 若 `Sidecar` 已启用（P2），发送成功后读取 `sidecar-runtime.json` 触发 `/api/nudge`（即时 + 5s + 15s 补探），通知失败静默忽略，不影响派活返回；
  7. 仅在 `101-codex` 派发获原生 `accepted` 且 `notifyOnFinish === true` 时，单条短 SSH 在 101 脱离启动一次性守望。回执额外报告 `notifyWatcher: { started, reason? }`，守望失败不改变原派发结果。守望沿原传输只读检查目标轮次，每 15 秒探测，审批等待提醒最多一次，完成、失败、中断或超时提醒后退出。默认 4 小时，配置上限 8 小时。SendKey 仅在 101 从 `SCT_KEY`、`~/.sct-key` 或 `remote.notifyKeyPath` 依次读取，微信内容只含状态及任务标识。
  8. DSH 使用协作插件原生操作，写入前核对目标主机、工作区和会话。只有明确鉴权拒绝才可换取 Bridge 2.10 Cookie，写入回执不明时返回 `unknown`。
  9. 收到 `accepted` 后在 nudge 带上宿主环境提供的对话 ID、项目 ID 及可选 `autoReadOnFinish`。显式设为 `true` 时为该会话开启自动读取。处于熔断状态的会话只能从侧栏重新开启。

#### 5. `bridge_interrupt`（写操作）
- **输入**：`{ target, sessionId, expectedWorkspace, expectedTurnId }`（全部必填）
- **行为**：先实探确认目标真实 `cwd` 匹配 `expectedWorkspace`（不符返回 `not_sent`），且当前 `state === 'active'`、`activeTurnId === expectedTurnId`。桌面 Codex 返回 `delivery_mode_unsupported`。显式 B 路 `daemon` 和已配置的 DSH 分别使用原生轮次 ID 和执行 ID 做条件中断。

#### 6. `bridge_create`（写操作）
- **输入**：`{ target, workspacePath, title, prompt? }`
- **行为**：桌面 Codex 先用 `list_projects` 唯一匹配归一化的本地项目，再调用 `create_thread`。没有唯一匹配返回 `not_sent`。如果原生工具声明必需首条消息但未提供 `prompt`，返回 `not_sent / initial_prompt_required`。101 显式 daemon 使用 `thread/start`。DSH 在同工作区定位现有会话后调用 `create`，校验 `hostId`、`workspacePath`、`nativeTaskId`、`independent`。全程不覆盖模型、思考强度和沙盒。
- **回执**：`{ result: 'created', target, sessionId, workspacePath, title, reminder }`。`reminder` 为「请在原窗口核对新会话的模型、思考强度与审批策略。」显式 daemon 和 DSH 可返回独立的首轮派发回执。创建回执不明时去原窗口核对，不自动重试。创建成功后尽力通知 Sidecar。

---

## 六、Sidecar 零 Token 心跳引擎规范（P2）

1. **零大模型开销**：心跳、diff、文件写入和侧边栏展示全部由本地 Node.js Sidecar 完成，**0 次 LLM 调用**。
2. **心跳探测范围（只盯三类，单条 SSH 一次扫完）**：
   - ① `state.json` 中记录的“经插件派过活且尚未完成”的会话；
   - ② 本地 `config.json` 中固定关注的会话；
   - ③ 101 当前活跃会话：默认 A 路（`desktop-pipe`）在单条短 SSH 内调 `list_threads` 实时拉取桌面会话状态，并对上述跟踪/固定/活跃会话按需补 `read_thread(turnLimit: 1, includeOutputs: false)`；仅在显式配置 B 路 `daemon` 时，才改用 `thread/loaded/list` + `thread/read` + `thread/turns/list`。
   - 每轮心跳对 101 只建立**一条**短 SSH 连接一次拉完上述集合，不逐个会话建连，也不把 B 路 `thread/list(useStateDbOnly: true)` 当作实时运行态数据源。
3. **四级触发**：
   - 启动同步：Sidecar 进程拉起后延迟 2s 首次探测；
   - 窗口/侧边栏激活：`ui.html` 监听 `document.visibilitychange`（切为可见）和 `window.focus`，调 Sidecar `/api/refresh?reason=focus`，Sidecar 内强制 **15 秒防抖**；
   - 自适应定时：任一目标存在 `active` 或 `waiting_approval` 会话 → **30 秒**；全空闲 → **5 分钟**；目标连续不可达（如远程网络断连）→ 退避至 **10 分钟**；
   - 动作触发：MCP `bridge_send` / `bridge_interrupt` / `bridge_create` 成功后读取 `sidecar-runtime.json` 并调本地 Sidecar `/api/nudge`（失败静默降级），触发即时 + 5s + 15s 三次轻量刷新。
4. **超轻探针**：心跳绝不拉取消息正文或工具输出，单次探测只拉会话元数据与最新轮次摘要（A 路 `read_thread(turnLimit: 1, includeOutputs: false)`；B 路 `thread/read(includeTurns: false)` + `thread/turns/list(limit: 1, sortDirection: 'desc', itemsView: 'notLoaded')`）。
5. **状态跃迁提醒**：
   - `active` → `completed` / `failed`：侧边栏标绿/红并可选触发 Windows 桌面通知；
   - `active` → `waiting_approval`：侧边栏强提醒并置顶“等待原窗口审批”。
6. **`SessionStart` Hook 条件注入（`hooks.json`）**：
   - 每次新开 Antigravity 对话时读取本地 `state.json`；**仅当存在 `active`、`waiting_approval` 或“刚完成尚未查看”的任务时**注入不超过 100 Token 的单段摘要；全空闲、无未读或文件过期/缺失时**不输出任何内容**，避免在无关对话中混入噪音；超时上限 ≤ 2 秒。
7. **P2 顺带增强项（参考 `Koala973/antigravity-lead-codex` 可复用经验与真机体验修补）**：
   - 每 5 分钟顺手调用 `get_usage_limits`（A 路）/ `account/rateLimits/read`（B 路）在侧边栏右上角展示 Codex 5h/7d 剩余额度；
   - 侧边栏支持星标置顶（持续纳入心跳盯梢、空闲超 15m 不消失）、“已隐藏”软折叠抽屉（可随时「恢复显示」）、“近期空闲会话”折叠抽屉（默认前 20 条）、0-Token 本地模糊搜索框（支持多关键词与顺序模糊匹配，搜索时突破 20 条抽屉限制）、未监控历史目录会话标为“未加载”（区分已派发任务的“待确认”），以及 60 秒同内容防手抖重投；
   - Sidecar 放行回环代理端口（`127.0.0.1` / `localhost` / `[::1]` / `*.localhost`）的 `Host`/`Origin`，入口捕获 `stdout`/`stderr` 的 `EPIPE`，避免 Antigravity 宿主代理报错或反复重启；
   - 新增一键环境体检脚本 `scripts/doctor.ps1`（检查 Node >=22、Windows 桌面管道、101 SSH 与 Socket 连通性、MCP stdio `initialize` 握手）。

---

## 七、分阶段交付与严格边界（P1 → P5）

### 阶段 1（P1）：双端 Codex 原生直连核心 + 独立 Hook + 极简 MCP
- **交付范围**：
  - `win-codex.mjs`、`remote-codex.mjs`（含按需 SSH 直连 101 Unix Socket 与 `reconcile` 核对）、`codex-pipe-hook.mjs`、`mcp/server.mjs`（5 个核心工具可用，`bridge_create` 占位）、`skills/native-bridge/SKILL.md`、`install.ps1` / `install-codex-hook.ps1`、`README.md`。
- **必须覆盖的离线测试（`npm test`）**：
  - 状态机测试（`active` / `idle` / `waiting_approval` / `paused` / `unknown`）；
  - 公开消息过滤、凭据脱敏与字符预算裁剪；
  - Windows 管道正则校验、非法身份拒绝、原子写状态文件、普通会话静默退出；
  - 模拟 Windows 命名管道通信（含 `send`、`read`、rollout 兜底）；
  - 模拟 101 Daemon WebSocket JSON-RPC（`turn/start` 拿到 `turnId` 后立刻断开、重连读回、超时返回 `unknown` 绝不重发、`reconcile` 查重、`expectedTurnId` 不匹配拒绝中断）；
  - MCP Server stdio 协议握手与工具调用边界。
- **P1 真机联调前置门禁（3 场景矩阵已实测通过）**：
  - 2026-11-25 已在 101 专用测试会话（`/home/user/work/task`）经 A 路桌面原生管道 `/tmp/codex-app-tools-<uid>/*.sock` 实测通过全部 3 种状态：
    1. **S1（101 桌面窗口打开且正停在该测试会话）**：派发后立即断开，重连读回已完成轮次；原窗口实时可见且模型/思考强度保持。
    2. **S2（101 桌面窗口切到别的会话）**：派发 20s 任务后立即断开，6s 后重连抓到 `active / inProgress`，22s 后重连读回 `completed`（耗时约 25 秒）；原窗口可正常操作、无锁死；同期实测 `get_usage_limits` 返回可用周额度数据。
    3. **S3（关闭 RDP 窗口，101 桌面 Codex 在后台运行）**：派发 20s 任务后立即断开，6s 后重连抓到 `active / inProgress`，22s 后重连读回 `completed`（耗时约 26 秒）；无会话卸载。
  - **P1 最终收尾条件（已完成）**：已补齐 101 默认 `desktop-pipe`（A 路）自动发现与 Windows 免 Hook 自动发现、`npm test` 通过并完成双端真机只读与写回验收，进入 P2。

### 阶段 2（P2，已完成并上线）：零 Token Sidecar 心跳引擎 + 侧边栏看板 + `SessionStart` 条件摘要 + `doctor.ps1`
- **交付范围**：`sidecars/native_bridge/`、`src/sidecar/`（四级心跳调度器、三类会话+星标单 SSH 批量扫描、自适应 30s/5m/10m 调频、15s 防抖激活刷新、`sidecar-runtime.json`、AUX_PANE 看板 + 额度圆环 + 模糊搜索 + 星标/软隐藏 + 最近一轮摘要、桌面通知、60s 防手抖重投）、`src/hooks/agy-session-start.mjs`、`hooks.json`、`scripts/doctor.ps1`、完整心跳/UI 状态机单测（67 项全过、`doctor.ps1` 4/4 全过）。

### 阶段 3（P3）：微信提醒、DSH、新建会话、多机配置与 Markdown
- **交付范围**：`scripts/101-turn-watcher.mjs`、`src/adapters/dsh.mjs`、四端 `bridge_create`、`configs/config.example.json` 和 `docs/MULTI-MACHINE.md`。侧栏「最近一轮」用 DOM 渲染 Markdown，原始 HTML 按文字显示，仅 HTTP(S) 链接可点击，MCP 公开问答结构保持一致。
- **离线验收**：覆盖守望状态跃迁、超时、密钥脱敏与启动失败降级，DSH 认证、四端新建、未配置静默、写入回执不明和 Markdown 的常见语法及 XSS 防护。
- **按会话自动读取**：默认关闭。侧栏开启时依次使用当前 Antigravity 对话 ID、最近派发记录、Sidecar 环境变量。缺少有效对话时返回 400。绑定只用于对应会话，未隐藏的启用会话纳入心跳监控。会话跃迁到完成、失败或中断后，Sidecar 按轮次读取脱敏的公开问答，构建不超过 4,000 字符的消息，并异步调用宿主 `agentapi send-message`（30 秒超时）。消息包含目标、会话 ID、标题、预期工作区、轮次 ID 和计数。Antigravity 按已获授权的原任务验收，遇到完成、审批或需用户决策时停止派发。
- **去重和上限**：终态推送按 `turnId` 去重，间隔不少于 30 秒。等待审批时每轮只推送一次提醒，正文读取和轮次计数均跳过。上限取会话 `prefs.sessions[key].autoReadLimit`，其次取 `config.sidecar.maxAutoReads`，默认 5，范围 1 到 20。控件只在开启后出现。最后一轮提示停止派发并将开关关闭、落盘。手动重新开启时归零，保留已推送轮次记录。原生读取或宿主调用失败在卡片显示简要错误，心跳继续运行。

### 阶段 4（P4）：101 本地双会话自动接力脚本 + 平台分工收口
- **交付范围**：101 本地串行接力模板（不跨公网/内网、有最大返工轮次上限、完成发微信后退出），以及与既有协作服务的清晰分工文档。
- **多窗口并行配对标识**：记录 Antigravity 对话 ID 与 Codex／DSH 会话的关联。在卡片上展示所属对话标题或自定义短标签，切换 Antigravity 窗口时自动高亮「当前对话」关联的会话，并提供「仅看当前对话」筛选。
- **本地偏好**：`prefs.sessions[key]` 按会话记录 `pairedConversationId`、`pairedConversationTitle`、`pairLabel`、`pairedAt`。派发、新建及开启侧栏自动读取时自动关联，也支持在 `/api/prefs` 手动绑定、取消绑定或编辑标签。标题与标签清理控制字符并遮盖凭据，分别最多 80 和 32 字。宿主地址及令牌可用时，异步读取本机 `ConversationService/GetConversation`，3 秒超时，失败时显示标签或短 ID。手动配对独立于已授权的自动读取唤醒目标。
- **默认分工**：已有配对或用户指定协作窗口时，Codex／DSH 执行代码改动和自测，Antigravity 负责澄清、设计、派发、审查与验收。仅当用户明确要求本端直接动手时，Antigravity 在本端改代码。SessionStart 按当前对话注入一行简短的目标与分工提示，自动读取唤醒和技能同步提示。
- **本地双会话接力**：`scripts/101-local-relay.mjs` 在同一 Linux 主机校验两个独立原生会话的工作区，使用本机 Unix Socket，保持选定的桌面或显式 daemon 路径。串行派发和核对轮次，明确通过、达到返工上限、需审批、失败、中断、回执不明或超时时停止。默认最多 3 次返工，允许 1–10 次。单轮默认 15 分钟、上限 1 小时，总时限默认 2 小时、上限 8 小时。可选复用 Server酱，退出前最多通知一次。见 [本地双会话接力](docs/LOCAL-RELAY.md) 和 [平台分工](docs/PLATFORM-BOUNDARY.md)。
- **离线验收**：覆盖配对与标签、标题查询降级、当前对话 UI、SessionStart 分工提示、自动读取委派提示、本地接力通过与返工、审批停机、轮次及时间上限、参数校验与模拟微信通知。

### 阶段 5（P5）：侧边栏 UI 视觉重设计与交互打磨
- **设计主导分工（强制）**：凡涉及视觉与审美任务（设计图、UI、网页布局、图片布局、视频剪辑等），先由 Antigravity 输出完整设计样式、CSS 视觉令牌、布局结构与交互状态规范（必要时附静态预览稿经用户确认），再派发给 Codex／协作窗口严格按稿实现与补测，协作窗口不得自行发挥或替换视觉样式。
- **现状痛点**：
  1. 现有浅/深色灰绿配色与实线边框偏旧，与 IDE 宿主侧栏融合度不足；
  2. 卡片内高频与低频操作（星标、隐藏、复制引用、最近一轮、自动读取、跟进轮数、绑定/解绑、标签输入框）平铺堆叠，窄侧栏下容易折成多行“按钮墙”；
  3. 顶栏、工具条与搜索条垂直占比过大，首屏有效会话数偏少；
  4. 状态反馈与当前对话高亮层次偏弱，配对编辑输入框常驻占位。
- **重设计范围（零外部框架，保持纯 DOM 安全渲染）**：
  1. **插件与侧栏图标（`logo.svg`）**：由 Antigravity 设计简洁高辨识度的矢量品牌图标 `logo.svg`，接入 `plugin.json`（`"logo": "logo.svg"`）、同步更新 `scripts/install.ps1` 安装文件清单，并在侧边栏标题／页面 favicon 中统一复用；
  2. **现代 IDE 视觉令牌**：重构亮/暗双主题中性表面层级、细腻描边、圆角与低饱和语义色，统一字体、字号、字重与间距节奏；
  3. **紧凑顶栏与单行筛选**：精简标题与同步状态指示，紧凑呈现 5h/7d 额度胶囊，将刷新/暂停/通知收拢为轻量化图标/紧凑按钮，搜索框与「仅看当前对话」并入高密度筛选条；
  4. **卡片信息分层与低频收纳**：突出状态语义点（运行呼吸态、待审批醒目侧边色条、终态新回复标识）、精炼标题、单行截断工作区（hover 显示完整路径）与紧凑配对芯片；主排仅保留高频操作（最近一轮、复制引用、自动读取），将星标、隐藏、绑定/解绑、编辑短标签与跟进轮数配置改为按需展开或轻量更多菜单，消除常驻输入框占位；
  5. **摘要阅读与窄屏适配**：打磨 Markdown 摘要内的代码块、表格、引用与角色分隔样式；保障 260px 窄侧栏不溢出、键盘导航与 ARIA 语义完整。
- **离线与真机验收**：保留全部既有 Sidecar API、状态机、配对筛选、自动读取与防 XSS 断言，补充新 UI 结构与窄屏交互回归测试；真机在 Antigravity 亮/暗主题与窄/宽侧栏下目视验收。

---

## 八、施工与安全纪律

1. **作用域隔离**：只允许在 `agy-native-bridge` 仓库目录内新增/修改文件；严禁修改其他项目、中心服务、业务数据库或既有插件（安装脚本需由用户确认后再运行）。
2. **禁止擅自提交**：写完代码后**严禁执行 `git commit` 或 `git push`**，必须等待用户 review 确认。
3. **真机安全红线**：
   - 未经用户明确授权，**严禁向任何正在使用的 Codex 正式业务会话发测试消息**；
   - 联调测试优先使用本地 Mock Server 跑通 `npm test`；需要真机联调时，先列出计划验证命令请老板指定专用测试会话。
4. **回报格式要求**：每个阶段停下时，必须如实报告：
   - 新增/修改的文件清单；
   - `npm test` 的精确运行命令与实际通过/跳过结果；
   - 已验证项 vs 尚待真机验证项；
   - 对老板和 Antigravity 的简明验收指引。
