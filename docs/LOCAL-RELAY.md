# Linux 本地双会话接力

在运行 Codex 原生会话的 Linux 主机上，使用同一系统用户和 Node.js 22.13 或更高版本运行。选两个自己有权限调度的独立会话，先在原窗口确认工作区、模型、思考强度和审批设置，并让两端空闲。接力进程通过本机 Unix Socket 与原窗口通信。可选微信提醒会在结束时单独访问 Server酱。

## 配置与运行

将以下模板保存为用户自己的 JSON 文件，替换两个示例 UUID 和工作区。`prompt` 是用户明确授权给实现会话的任务。配置里只放任务和描述，凭据另行保存。

~~~json
{
  "implementer": {
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "workspacePath": "/home/user/work/task"
  },
  "reviewer": {
    "sessionId": "00000000-0000-4000-8000-000000000002",
    "workspacePath": "/home/user/work/task"
  },
  "prompt": "实现已确认的改动，运行适用的离线测试并报告结果。",
  "passMarker": "REVIEW_PASS",
  "maxReworkRounds": 3,
  "turnTimeoutMs": 900000,
  "totalTimeoutMs": 7200000,
  "transport": "desktop-pipe",
  "notifyOnFinish": false
}
~~~

在项目目录准备好 Node 依赖后运行：

~~~bash
node scripts/101-local-relay.mjs ./relay.local.json
~~~

| 字段 | 默认与约束 |
|---|---|
| `implementer`、`reviewer` | 两个不同的原生 Codex 会话 UUID，各自填写绝对工作区路径 |
| `prompt` | 必填，最多 8,000 字符 |
| `passMarker` | 默认 `REVIEW_PASS`，最长 80 字符。评审的真实目标轮次须在公开最终回复的最后一行独占该标记 |
| `maxReworkRounds` | 默认 3，允许 1–10。首次实现和首次评审在返工轮数之外 |
| `turnTimeoutMs` | 默认 15 分钟，范围 1 秒至 1 小时。含派发、等待和读取结果 |
| `totalTimeoutMs` | 默认 2 小时，上限 8 小时，至少等于单轮预算 |
| `transport`、`socketPath` | 默认 `desktop-pipe`，按当前用户发现桌面管道，也可指定绝对路径。纯无桌面主机可显式选 `daemon` 并填写其本机 Socket 绝对路径 |
| `notifyOnFinish`、`notifyKeyPath` | 默认关闭。开启后从 Linux 主机上的 `SCT_KEY`、`~/.sct-key` 或可选绝对路径读取 SendKey，只尝试通知一次 |

流程为实现 → 评审 → 按评审意见返工。每次交接使用原任务和已脱敏的对应轮次公开最终回复。评审通过立即结束。遇到待审批、失败、中断、超时、未知回执、目标非空闲、缺少可核对的最终回复或用尽返工次数时，脚本停止并输出状态 JSON。通过时退出码为 0，停止时为 1，配置或用法有误时为 2。

接力不调用 SSH、中心服务或数据库。每次派发都核对会话及工作区，沿用原会话生效的设置。审批交给用户在原窗口完成。回执未知或超时后，请按输出中的 `operationId` 回原窗口核对。脚本不会自动重发、代答审批或在桌面连接失败时切换到 daemon。请避免启动针对同一批会话的并行接力。

微信通知只带状态和返工次数。通知失败时，输出中的 `notified` 为 `false`，接力结果仍可在本地查看。读密钥和最后一次通知合计最多再等 16 秒。
