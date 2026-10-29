---
issue: local/2026-10-28-eve-replay-startup-handoff
status: proposed
last_updated: 2026-10-29
---

# 跨版本修复：Agent 与 Apps 接入交付方案

本文件是待实施合同，尚无新的可安装修复包。总方案及进度入口：[跨版本重放、启动恢复与失败收敛](baigong-040-replay-startup-repair.md)。不得把本文用于直接操作生产数据。

## 1. 接入结果

兼容的活动 `.2/.3` 会话升级后继续；此次已经 failed 的会话只保留历史、不续聊、不自动新建替代会话。Agent 与 Apps 必须展示一致终态，不再等待已失败的执行。

eve 将交付新不可变 tgz、版本与源码 SHA、SHA256、兼容清单、存量 B 检查/收敛工具。Agent 固定该包并完整重建；当前 `.3` 不具备下述新接口。

## 2. 拟新增 eve 接口

`GET /eve/v1/session/:sessionId/status`：

```ts
type SessionExecutionStatus = {
  sessionId: string;
  executionStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
  finishedAt: string | null;
  errorCode: string | null;
};
```

读取持久 Run，不打开消息流、不启动工作流。failed 的 finishedAt 为持久失败时间；404 仅表示确实不存在。401/超时/存储异常不能当作 failed。无原始异常内容、输入与密钥。

Agent 已有 eve-stream token 增加同 session 的 STATUS 只读权限；run/control token 不获得额外权限。eve 的状态 SDK、Channel 分层和接口测试由 eve 侧交付。

本次仅将主会话 failed 映射业务 FAILED。running 不表示模型正在生成；完成/取消沿用已有业务合同，不能自行按字面改写已成功会话。

## 3. Agent 改动表

以下路径相对 baigong-agent 根目录。

| 任务 | 文件/模块                                                                             | 实现要求                                                                                                          |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A01  | `src/server/eve/request-scope.ts`、`agent/channels/eve.ts` 相关测试                   | 新增 STATUS 精确路径，复用同 session 的 stream token，只读授权不越界                                              |
| A01  | `src/server/eve/client.ts`、`src/server/conversations/types.ts`                       | getSessionExecutionStatus，透传 signal，校验响应身份/状态/失败时间，不使用 returnValue 等待                       |
| A01  | `conversations/session-tail.ts`、`session-settlement.ts`、`session-termination.ts`    | 持久 failed 补足只看流尾的缺口；复用真实失败时间；不对 failed 继续安排 reset                                      |
| A02  | `event-view-reader.ts`、`event-view-reducer.ts`、`event-view/state.ts`、`snapshot.ts` | 完整历史前缀读完后应用独立终态归约；保留正文和已完成轮次，清当前交互，原 cursor 不变                              |
| A02  | `projection-checkpoints.ts` 的调用方、快照分页                                        | 刷新 context 让已有终态检查使旧 checkpoint 失效；旧分页票据不复用到新终态                                         |
| A02  | `src/server/eve/streams.ts`                                                           | 现有 15 秒 heartbeat 顺序查询执行状态；failed 后取消 owned reader 并结束，不发假游标事件；终态快照不再持续 follow |
| A02  | `runtime-references/reconciliation.ts`、`lifecycle.ts`                                | 持久失败确认后收敛业务终态；确认配套执行已收敛，再按现有事务释放 ROOT/SPECIALIST 引用及临时快照                   |
| A03  | 维护入口、`request-recovery.ts` 回归                                                  | 按 E05 清单处理；保留 Turn/queryId/eveTurnId；空 eveTurnId 不补造、不走 deleteUnsentTurn、不重新发送              |

数据库不新增 Turn outcome 列。显示状态由事件归约加权威终态生成；不得把会话失败等同于全部历史 Turn 失败。

`releaseRuntimeReferenceInTransaction` 会清除 Turn.runtimeReferenceToken 并删除运行引用、运行期记忆快照，复用其检查。它不会凭空恢复已缺失的执行坐标；缺少 eveTurnId 的行继续保留空值。清理结果必须区分已释放和关联证据不足。

业务 API 保留 V2 schema、snapshotCursor、events.after、queryId、权限隔离、原始错误以及已确认受理恢复语义。不要改 request-recovery 的 ACCEPTED 为“执行成功”；已受理后失败仍属于已受理请求。

## 4. Apps 改动表

先走 Apps OpenSpec 流程。改动局限 `src/features/native-agent/NativeAgent.tsx` 及相关测试；协议和 BFF 权限不扩张。

1. 正常流 EOF 且视图未终态：对当前 conversation/scope/generation 重新取一次既有 snapshot，不重复提交请求。
2. 终态快照整体更新，清 acceptedTurnId、busy、输入问题和取消等待，保留消息、知识来源及调用链历史。
3. 初次打开已经终态的会话，显示历史和终态，不反复开启 follow。
4. 一次刷新仍非终态，保留断流提示与手动重连。查询失败显示实际错误，不转为成功/失败执行结论。
5. 切换会话、院校、用户或权限撤销后旧响应作废，沿用现有 generation 和 signal。

`native-protocol.ts` 继续严格检查终态快照。`src/server/nativeAgentBridge.ts` 继续使用原 snapshot/events 代理，无新增路由或放宽鉴权的要求。测试覆盖 NativeStreamRevalidation、NativeAgentSnapshot、NativeSubmissionRecovery 和院校隔离。

## 5. 存量维护顺序

1. 获取修复包与已验收的 E05 工具，确认输入数据目录和业务数据库对应同一部署。
2. 停止旧写入进程，备份当前数据库和 eve 数据；不恢复升级前旧备份覆盖当前记录。
3. eve inspect 输出精确失败清单；apply 保持主 Run failed，取消精确配套活动任务、关闭遗留流，输出每项结果。
4. Agent 维护入口按清单的 sessionId 关联真实租户/会话，写 FAILED 和持久失败时间；引用按现有生命周期释放。无需把原始 token、用户内容传给维护报告。
5. 未成功清理的目标单列，不删除、不重新执行、不伪装成功。工具重跑跳过已完成工作。
6. Agent 新制品、Apps 修复版切换后验证旧会话历史/终态和新会话业务。生产操作另行授权。

## 6. 接入验收回执

| ID  | 验收                                                          | 状态 | 证据 |
| --- | ------------------------------------------------------------- | ---- | ---- |
| H01 | tgz 版本/摘要与 Agent 最终构建内嵌修复一致                    | [ ]  | —    |
| H02 | status 鉴权：同 session 可读，其他 session/写操作拒绝         | [ ]  | —    |
| H03 | `.2/.3` 活动会话可继续，不重复已完成模型/工具执行             | [ ]  | —    |
| H04 | failed 无 session.failed 消息、已有/无 EOF 都输出正确终态快照 | [ ]  | —    |
| H05 | 旧会话保留历史、禁止发送；新会话正常                          | [ ]  | —    |
| H06 | 有/无 eveTurnId、ROOT/SPECIALIST 引用按事实收敛               | [ ]  | —    |
| H07 | 在线失败、普通断流、权限撤销、切换会话均符合方案              | [ ]  | —    |
| H08 | 受理超时、原 queryId 恢复、补充输入、附件、知识模式不回退     | [ ]  | —    |
| H09 | E05 重复执行无重复 EOF/取消，未处理项有明确结果               | [ ]  | —    |
| H10 | Apps OpenSpec、所需测试/构建/覆盖率及三方联调完成             | [ ]  | —    |

回执须填写实际 SHA、命令、制品、时间和输出位置；不得仅填“已检查”。正式交付时补充版本、下载 URL、SHA256、最终配置参数和真实维护命令。

E04a 接口已实现：`GET /eve/v1/session/:sessionId/status`；客户端为 `client.sessions.attach(sessionId).getExecutionStatus({ signal })`。返回四个字段：sessionId、executionStatus、finishedAt、errorCode。接口不读取或修改消息流，404 仅表示 Run 不存在，存储读取错误返回 500。尚未完成统一构建与运行验收；Agent 的该路由授权仍需按本文接入。

E04b 补充决策 A：在线失败状态立即可读，但取消 Run 不是写入者退出确认。存在未完成步骤/turn/子会话时，eve 报告清理未完成，不强制关闭主流；Agent 必须按持久 status 结束客户端等待，不能只等待 EOF。停写后使用 E05 完成对应本地执行的取消及 EOF。清理报告 `scope=local-workflow`，不得据此释放远程执行器的运行引用；远程引用必须使用其自身终态合同。

E05 已实现 `eve repair-replay inspect` / `apply`（尚待统一验收）。在当前数据备份上运行 inspect；停写并备份当前 Agent 数据库及 eve 目录后，持清单运行 apply。Agent 读取报告的 `sessions`（ID、失败时间、错误码）及 `results`（本地处理结果），不读取/信任用户提供的跨租户 SQL。存在 `errors` 或 `unresolvedRunIds` 时命令退出非零，不得视作全部资源已释放。旧 failed Session 不恢复、不替换；接口完整接入及业务验收仍由 Agent/Apps 实施。
