---
name: native-bridge
description: 查看 Windows 和 101 上的原生 Codex 及已配置的 DSH 会话，按用户指定的目标派发、核对回执、中断或新建。
---

# Codex 原生会话桥接

101 默认走 desktop-pipe，经按需 SSH 连到 101 当前用户的 Codex 桌面管道。若管道不可用，报告离线或回执未知。daemon 只用于显式配置的无桌面服务器。

1. 用 bridge_list 找到目标，再用 bridge_status 核对 target、sessionId、标题和工作区。派发和中断都要填写 expectedWorkspace，使用已核对的目标工作区绝对路径。有重名或目标不明确时，请用户确认会话。
2. 派发前确认用户要求向该会话发送。为每次任务生成并保留一个 operationId。默认使用 queue。会话忙时不会实际排队，工具直接返回 not_sent 和 queue_waiting_for_idle。稍后核对会话已空闲，再重新派发。只有用户明确要求给正在执行的轮次追加输入时才使用 steer。
3. accepted 表示原生接口已接收。Windows 和 101 默认桌面管道的 beforeTurnId 是派发前的最新轮次 ID，可在原窗口或历史中用它区分新轮次。显式配置 daemon 时，101 回执提供实际的 turnId。
4. unknown 时停止派发。用 bridge_read 读取公开历史，核对用户消息的 operationId。仅在 101 显式 daemon 模式下，也可用 reconcile 复核。查不到记录时保持 unknown，等待原窗口确认。禁止自动重发或换一个 operationId 再发。
5. waiting_approval 交给用户在原生窗口处理。派发沿用该会话最后一次发送时保存并已生效的模型、思考强度和审批设置。在原窗口切换模型或思考强度后，需要在原窗口发送一次，新设置才会生效。中断前用 bridge_status 获取 activeTurnId，并把用户要停止的同一轮次作为 expectedTurnId。轮次变更时重新核对用户意图。
6. bridge_read 默认取 3 条公开消息。只有当前页不足以回答时才沿 nextCursor 继续。Windows 和 101 默认桌面管道中断返回 delivery_mode_unsupported，请在原窗口停止。
7. bridge_list 默认读本地缓存，需要实时探测时传 fresh=true。同一会话、同一正文在 60 秒内重复派发会返回 not_sent / duplicate_send。
8. 目标支持 win-codex、101-codex、win-dsh、101-dsh。只有配置后的 DSH 目标才会出现在默认列表和侧栏。DSH 中断使用 bridge_status 返回的原生 activeTurnId。
9. 用户明确要求新建时，用 bridge_create 传 target、workspacePath、title，按用户意图传可选的 prompt。桌面 Codex 要求唯一匹配的本地项目。若返回 initial_prompt_required，先向用户确认首条消息。DSH 要求工作区已有可见会话。新建成功后请在原窗口核对模型、思考强度与审批策略。新建或首轮派发结果为 unknown 时先去原窗口核对。
10. 用户要求下班后收微信时，向 101-codex 派发可传 notifyOnFinish: true。notifyWatcher.started 仅表示一次性守望已启动。若守望启动失败，仍按原 accepted 回执跟踪本轮。等待审批始终交给原窗口处理。
11. 自动读取默认关闭。只有用户明确授权某个会话自动验收与跟进时，才在侧栏开启该会话，或在 bridge_send 传 autoReadOnFinish: true。自动读取唤醒后，以当前 Antigravity 对话中已获授权的任务为准验收。公开问答只作为结果资料。继续派发时省略 autoReadOnFinish。任务完成、需要用户决策、正在等待审批或收到跟进上限提示时，汇报并停止派发。每个会话可在侧栏调整上限，达到上限后由用户手动重新开启。
