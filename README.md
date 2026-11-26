# agy-native-bridge

在 Antigravity 中查看 Windows 本机和 101 Ubuntu 上的原生 Codex 及已配置的 DSH 会话，读取公开问答、派发任务或新建会话。101 默认通过 SSH 连接 Codex 桌面管道，每次工具调用结束后释放连接。审批、模型和思考强度由原窗口管理。

## 离线验收

在项目目录用 Node.js 22.13 或更高版本运行。首次准备依赖需要 npm registry 或事先缓存的 ws 包。

~~~powershell
npm ci --ignore-scripts
npm test
~~~

测试使用模拟的 Windows 管道、101 桌面管道和 Daemon WebSocket，并覆盖 MCP stdio、DSH Bridge 认证、Server酱请求、Sidecar 状态及 Markdown 渲染。

## 验收后安装

1. 用 PowerShell 7 执行 `pwsh -File .\scripts\install.ps1`。插件同步到 `%USERPROFILE%\.gemini\config\plugins\agy-native-bridge`，Antigravity 从 `mcp_config.json` 启动 stdio Server，Sidecar 提供「Codex 会话」侧栏看板。
2. Windows 本机与 101 均支持免 Hook 自动发现：Windows 直接扫描活动 `\\.\pipe\codex-app-tools-*` 管道与最新 rollout 会话，重载 Antigravity 后即可开箱即用。
3. **可选（多窗口固定提示）**：若同时开启多个 Codex 桌面窗口并希望按窗口写提示文件，可执行 `pwsh -File .\scripts\install-codex-hook.ps1`（合并用户级 `hooks.json` 并自动备份，用 `-Action Uninstall` 卸载），然后在 Codex 桌面端启用并信任该 Hook 即可写入 `win-codex-pipe.json`（若指向旧管道会自动回退到活动管道）。
4. 重载 Antigravity 后，可在右侧边栏「Codex 会话」或通过 `bridge_list`、`bridge_status`、`bridge_read` 查看双端会话；真机派发与中断只使用用户指定的专用测试会话。

Codex 用户级 Hook 的文件路径和信任流程见 [Codex Hooks 文档](https://developers.openai.com/codex/hooks)。

## 本机配置

状态目录默认是 %USERPROFILE%\.gemini\config\agy-native-bridge。设置 AGY_NATIVE_BRIDGE_HOME 时，Hook 和 MCP 进程需使用同一个目录。目录中的 config.json 可省略。下面列出可覆盖的字段，workspaces 用于固定指定会话的工作区。

~~~json
{
  "win": {
    "sessionsRoot": "C:/Users/YourWindowsUser/.codex/sessions",
    "requestTimeoutMs": 15000
  },
  "remote": {
    "sshTarget": "codex-101",
    "transport": "desktop-pipe",
    "requestTimeoutMs": 15000
  },
  "workspaces": {
    "win-codex": {},
    "101-codex": {}
  }
}
~~~

Windows 的 `sessionsRoot` 默认取 `CODEX_HOME` 下的 `sessions`，省略 `CODEX_HOME` 时取用户目录下的 `.codex/sessions`。可选填写 `win.callerThreadId` 指定固定调用会话 UUID；未填写且无 `win-codex-pipe.json` 时，自动扫描 `\\.\pipe\codex-app-tools-*` 与 `sessionsRoot` 下最新 `rollout-*.jsonl` 提取会话 UUID。

101 需要免密 OpenSSH 和已信任的主机密钥。`sshTarget` 可填 `~/.ssh/config` 中的主机别名。可用 `remote.nodeBin` 指定 Node 的绝对路径。省略时先查非交互 SSH 的 `PATH`，再从 `~/.nvm/versions/node` 中选取最新可运行版本。默认用 101 的最新 rollout 文件名取真实会话 UUID 来查询会话列表和额度，也可把 101 上已存在的会话 UUID 填入 `remote.callerThreadId`。

省略 remote.transport 或设为 desktop-pipe 时，SSH 从 /tmp/codex-app-tools-当前用户UID/ 中按修改时间降序选用第一个能连接的 .sock。也可以用 remote.socketPath 固定桌面管道绝对路径。连接失败时直接报告，只有无桌面服务器显式设置 remote.transport 为 daemon 才连接 Daemon。旧配置若留有 app-server-control.sock，切到桌面模式时请移除 remote.socketPath，使其自动发现桌面管道。

显式 daemon 模式下，remote.socketPath 默认取 /home/user/.codex/app-server-control/app-server-control.sock。

## 工具

| 工具 | 使用方法 |
|---|---|
| bridge_list | target 省略时返回全部已启用目标。单端默认 30 条。缓存有效期为两个心跳周期，最多 10 分钟。fresh=true 强制实探。实探失败时若回显旧列表，结果带 stale=true 和 cacheAgeMs。 |
| bridge_status | 传 target 和 sessionId，实时查看状态、当前轮次、待审批标记和工作区。有可用的额度缓存时附带 rateLimits。 |
| bridge_read | 传 target 和 sessionId，默认读取最近 3 条公开消息，上限 20 条及 24,000 个字符。用 nextCursor 继续，pageTruncated 表示本页内容存在裁剪。 |
| bridge_send | 必填 expectedWorkspace。默认 queue，会话忙时直接返回 not_sent / queue_waiting_for_idle。Windows 和 101 默认桌面管道回传 beforeTurnId。显式 daemon 模式的 steer 绑定当前轮次，成功后返回 turnId。 |
| bridge_interrupt | 必填 expectedWorkspace 和 expectedTurnId。显式 daemon 模式能停止仍处于 active 且匹配的轮次。Windows 和 101 默认桌面管道返回 delivery_mode_unsupported。 |
| bridge_create | 传 target、workspacePath 和 title，可选 prompt。桌面 Codex 需要唯一匹配的本地项目，部分版本要求首条消息。DSH 需要同工作区已有会话。新建后在原窗口核对模型、思考强度和审批策略。 |

目标为 `win-codex`、`101-codex` 和已配置的 `win-dsh`、`101-dsh`。默认列表包含全部已启用目标。显式调用未配置的 DSH 目标会返回 `DSH_NOT_CONFIGURED`。DSH 中断与显式 daemon 模式一样需要确认当前轮次。

派发返回 unknown 时保留 operationId，用 bridge_read 在同一会话的用户消息中查找 [AGY_BRIDGE_OP:operationId]。显式 daemon 模式的历史若提供 clientId，会映射为 operationId。该模式也可在项目目录用以下只读命令核对：

~~~powershell
@'
import { RemoteCodex } from './src/adapters/remote-codex.mjs';
import { readConfig } from './src/shared/config.mjs';
const [sessionId, operationId] = process.argv.slice(2);
console.log(await new RemoteCodex(await readConfig()).reconcile(sessionId, operationId));
'@ | node --input-type=module - '专用测试会话的 ID' '派发返回的 operationId'
~~~

reconcile 只在原生用户消息中查找完全相同的 clientId。历史未命中仍属于 unknown，请在原窗口确认。派发超时和中途断开均只提交一次。

`101-codex` 派发可传 `notifyOnFinish: true`。收到原生 `accepted` 后，插件在 101 后台启动一次性只读守望。`notifyWatcher` 单独报告启动结果，派发回执仍然有效。守望读取 101 本机的 Server酱 SendKey。多机配置、微信提醒和 DSH 排错见 [办公室与家里电脑配置](docs/MULTI-MACHINE.md)。

## 按会话自动读取与跟进

所有会话默认关闭「自动读取」。请在要接收结果的 Antigravity 对话中打开侧栏，点指定会话卡片的「自动读取」。明确授权时也可在 `bridge_send` 传 `autoReadOnFinish: true`。侧栏启用时优先绑定当前对话，其次使用最近一次桥接派发的对话，最后使用 Sidecar 环境中的对话 ID。

会话完成、失败或中断后，Sidecar 把该轮脱敏的公开问答（含上下文最多 4,000 字符）送给绑定对话验收。只有启用的会话可能唤醒 Antigravity。终态推送按轮次去重并至少间隔 30 秒。等待审批时只提醒到原窗口处理，每轮一次，不读正文也不增加计数。

默认连续跟进上限为 5 轮。打开后可在开关旁把会话上限调为 1 到 20 轮，优先于 `sidecar.maxAutoReads`。达到上限会发送最后一条结果并关闭开关。需继续时手动开启，计数从零开始。暂时隐藏的会话停止自动读取，恢复显示后可继续监控新的状态变化。

## 多窗口配对与分工

在 Antigravity 打开对应对话后，可用侧栏卡片的「···」菜单绑定、取消绑定或保存短标签。成功派发、新建与启用自动读取也会建立配对。当前对话有一个或多个未隐藏的关联会话时，侧栏默认聚焦这些会话。「仅当前 (N)」可切换到全部，手动选择按对话保留到侧栏重新加载。有其他待审批会话时，工具栏下方会提示并提供查看全部的入口。配对和标签保存在该电脑的本地偏好。

常驻 MCP 缺少对话 ID 时，Sidecar 使用近 10 分钟内最近一次由侧栏报到的对话。首次读取可关联尚未配对的会话。手动解绑后，读取和心跳不会重新关联，主动派发、新建、开启自动读取或手动绑定可再次关联。历史自动读取配置首次加载时会补齐尚未记录的关联。

存在配对或用户指定协作窗口时，由 Codex 或 DSH 改代码和自测，Antigravity 负责需求、设计、派发、审查和验收。只有用户明确要求 Antigravity 直接动手时，才在本端改代码。手动配对只更新侧栏归属。如需改变自动读取的唤醒目标，在目标 Antigravity 对话里关闭再开启自动读取。

## Linux 本地接力

在同一 Linux 主机上可从命令行串联实现与评审会话。接力使用本机 Unix Socket，按返工次数、单轮时限和总时限停止，微信通知可选。配置与运行见 [本地双会话接力](docs/LOCAL-RELAY.md)，与中心化协作服务的适用范围见 [平台分工](docs/PLATFORM-BOUNDARY.md)。

## 侧栏与体检

顶栏铃铛右侧的主题按钮支持跟随系统、深色和浅色，默认跟随系统。主题保存在本机侧栏偏好中，重新打开时先使用本地缓存，随后与 Sidecar 同步。

重载 Antigravity 后，在辅助侧栏打开「Codex 会话」。侧栏监控插件刚派发的任务、`workspaces` 中固定的会话、当前活动会话以及已星标会话（空闲超过 15 分钟仍持续跟踪）。顶部模糊搜索框支持按标题、工作区路径或 `sessionId` 过滤（支持空格多关键词与顺序模糊匹配），搜索时会自动展开 20 条默认上限之后的近期历史会话。

历史目录中未打开加载的会话显示为「未加载」，已派发待核对的任务显示为「待确认」。卡片支持：
- **星标**：收藏置顶并纳入心跳长期盯梢；
- **隐藏 / 恢复显示**：纯本地软隐藏（保存在 `prefs.json`），点隐藏后可在该端底部的「已隐藏」抽屉随时点「恢复显示」放回；
- **复制引用**：左键复制引用 JSON，包含 `target`、`sessionId`、`expectedWorkspace`，有当前轮次时附带 `expectedTurnId`。右键复制自然语言提示词开头，粘贴到对话框后可继续补充需求。
- **读取会话**：按需拉取最近一轮的公开问答，展开后可点「收起内容」。终态卡片显示「新回复」，查看对应轮次、用 `bridge_read` 读取公开消息或自动读取成功转发后恢复为普通状态标签。审批始终显示「等待原窗口审批」。侧栏支持标题、列表、引用、代码、表格和 HTTP(S) 链接等 Markdown 内容，原始 HTML 按文字显示。

心跳空闲时每 5 分钟同步，运行或等待审批时每 30 秒同步，窗口或侧栏激活强制 15 秒防抖，同一台主机连续两次不可达后自动退避到 10 分钟。暂停心跳时仍可手动刷新，桌面通知默认关闭。

每个 MCP 进程在 60 秒内拦截对同一目标、同一会话、同一正文的重复提交。明确返回 `not_sent` 的尝试可按原因修正后再次提交。回执未知时先查原会话。

在项目目录运行以下只读体检命令，检查 Node.js、Windows 桌面管道、101 SSH 与桌面管道及 MCP stdio 握手：

~~~powershell
pwsh -File .\scripts\doctor.ps1
~~~
