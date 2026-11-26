# 办公室与家里电脑配置

两台电脑分别配置本机 Codex、Antigravity 和 SSH。只要连接的是同一个 101 用户，两台电脑看到的是同一组 101 原生会话。Windows 会话、星标、隐藏和 Sidecar 缓存保存在各自电脑。

## 配置与安装

1. 在两台电脑各自的 `%USERPROFILE%\.ssh\config` 中配置相同别名。办公室可使用内网地址，家里使用已可达的远程内网（如 Tailscale / WireGuard）地址。首次连接请核对远端主机的 SSH 公钥指纹，并为各台电脑配置免密公钥认证。

   ~~~sshconfig
   Host codex-101
       HostName 192.0.2.101
       User your-linux-user
       IdentityFile ~/.ssh/id_ed25519
       IdentitiesOnly yes
   ~~~

2. 用 `ssh -T -o BatchMode=yes codex-101 true` 检查非交互登录。在 101 保持相同用户的 Codex 桌面进程运行。默认传输 `desktop-pipe` 会发现最新存活的桌面 Socket，并从该用户的 Codex 历史提取真实调用会话 UUID。
3. 在每台电脑的 `%USERPROFILE%\.gemini\config\agy-native-bridge\config.json` 中填本机配置。可以从 [配置模板](../configs/config.example.json) 复制并调整 `win.sessionsRoot`、`remote.sshTarget`。删除未使用的 DSH 配置项，也可省略整个 `dsh`。`workspaces` 按目标记录会话 ID 和对应的绝对工作区路径。
4. 待验收允许安装后，在各台电脑的项目目录运行 `pwsh -File .\scripts\install.ps1`，重载 Antigravity，再运行 `pwsh -File .\scripts\doctor.ps1`。远端的一次性守望程序由插件按需启动。

## 101 微信提醒

在 101 上用编辑器写入当前 SSH 用户的 `~/.sct-key`，只填 Server酱 SendKey，并用 `chmod 600 ~/.sct-key` 限制文件权限。守望程序优先读取非交互 SSH 进程已有的 `SCT_KEY`，其次读 `~/.sct-key`，最后才读可选的 `remote.notifyKeyPath`（101 上的绝对路径）。配置里只放可选路径。旧的 `SCTxxx...` 占位值会跳过。

对 `101-codex` 派发时可传 `notifyOnFinish: true`。`notifyWatcher.started` 表示后台守望已启动。实际能否推送还取决于 101 本机的 SendKey 和 Server酱连通性。守望每 15 秒只读检查目标轮次，等待审批时最多提醒一次，完成、失败、中断或超时时发最终状态并退出。`remote.watcherTimeoutMs` 默认 4 小时，上限 8 小时。微信内容只含状态及任务标识。

## 可选 DSH

每端独立配置 `baseUrl`（Bridge 根地址）、`id`（协作插件主机 ID）、`environmentId`、`token`（协作插件令牌，至少 32 字符）、可选 `bridgeToken` 和 `requestTimeoutMs`。启用了 Bridge 2.10 访问令牌时才填写 `bridgeToken`。实值只填各自电脑的用户配置。跨机连接宜使用受信 HTTPS。未配置的端不会出现在侧栏和 `bridge_list(target="all")` 中。

## 对话配对与本地接力

配对、短标签和自动读取偏好保存在各自机器。办公室与家里电脑可对同一原生会话建立不同的 Antigravity 配对。在要调度的窗口打开侧栏并绑定，再按「仅看当前对话」查看归属。自动读取已开启时，重新配对不会改变原唤醒目标。

如果实现和评审会话都运行在同一 Linux 主机，可以直接在那台主机上运行有界接力。见 [本地双会话接力](LOCAL-RELAY.md) 和 [平台分工](PLATFORM-BOUNDARY.md)。

## 排错

- 101 离线时先核对 SSH 别名、免密和进程归属。Node 不在远端非交互 `PATH` 时会搜索 nvm，也可用 `remote.nodeBin` 指定绝对路径。`remote.socketPath`、`remote.callerThreadId` 可显式固定；该 UUID 必须对应 101 上真实存在的会话。仅无桌面且明确配置 `daemon` 时才走旧控制 Socket。
- DSH 列表不可达时，检查 Bridge 根地址、协作插件是否加载以及主机、环境和两个令牌是否对应。`DSH_NOT_CONFIGURED` 表示本机用户配置缺少该目标。
- 新建 Codex 桌面会话时，请先在原窗口添加对应的本地项目。当前桌面工具若要求首条消息而未传 `prompt`，回执为 `not_sent / initial_prompt_required`。DSH 新建要求目标工作区有可见的原生会话作为定位依据。
- 收到 `unknown` 时，按回执给出的会话或操作标识去原窗口核对。守望启动失败时，原派发的 `accepted` 回执仍然有效。
