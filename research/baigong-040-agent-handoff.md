---
issue: "baigongapps 报告 180；eve 0.40 修复配套交付"
status: planned
last_updated: "2026-10-28"
---

# baigong-agent 接入 eve 0.40 修复包

本文件供 Agent 侧直接实施，与[eve 修复方案](baigong-040-stream-lifecycle-repair.md)配套。eve 源码修复及本地分项验证已完成，0.40.0-baigong.3 已提交为 `94d83626`，tgz 及隔离安装验证已完成，并已沿用 .2 渠道发布 GitHub Release。Agent A01–A04 尚未实施或验收；收到明确版本、提交和包哈希后再接入。Apps 无须修改业务接口。

## 进度

| 编号 | 工作                          | 实现/静态审查             | 手动提交 | 最终验收 |
| ---- | ----------------------------- | ------------------------- | -------- | -------- |
| A01  | 提交链统一等待预算及 signal   | 待执行                    | —        | 待验证   |
| A02  | 保留原始错误与不确定受理恢复  | 待执行                    | —        | 待验证   |
| A03  | 更新 eve 包、锁文件、版本断言 | 制品已就绪；待 Agent 接入 | —        | 待验证   |
| A04  | 最终构建、业务及资源验证      | 待执行                    | —        | 待验证   |

每项完成后静态审查、由用户手动提交；所有测试和验收留到最后。不得将本方案标记为已经修复。

## A01：一个提交预算贯穿调用链

本方案取 **90 秒提交等待上限**，覆盖新建、继续消息和补充输入，匹配 Apps 当前默认提交上限。预算在 Agent 请求入口创建一次，结合 `request.signal`；用户断开或 Apps 较短预算到期时，观察等待更早结束。各阶段消费剩余时间，不各自重新计时。90 秒不是业务执行时限，也不保证不可取消的数据库调用被强行中止。

| 文件/范围                                                                                 | 改动                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/conversations/submission-timing.ts` 的 `handleSubmissionRoute` 及三个提交路由 | 让统一入口向操作提供合并后的提交 signal，使用一个可清理的 90 秒定时器；请求结束清理定时器和监听。路由继续现有鉴权及 queryId 校验。                                     |
| `src/server/conversations/types.ts`                                                       | 给 `EveGateway.startTurn`、`continueTurn`、`respondToInput` 增加可选 signal。                                                                                          |
| `src/server/conversations/creation.ts`、`continuation.ts`、`submit-turn.ts`               | 发送闭包及重复提交恢复、pending 恢复均传同一 signal，包含已有检查与附件准备。派发前检查是否已经终止。                                                                  |
| `src/server/eve/client.ts`                                                                | 调用 `client.sessions.create({ message, signal })`、`session.send(message, { signal })`、`session.respond(responses, { signal })`。SDK 已支持 signal，不新增 SDK API。 |
| `src/server/conversations/submission-acceptance.ts`                                       | 内联恢复查询使用同一 signal；预算耗尽不再发新的恢复 HTTP 请求。                                                                                                        |

保留 `request-recovery.ts` 的独立恢复接口及现有 `REQUEST_RECOVERY_TIMEOUT_MS=30_000`。这是后续查询请求，不占用已结束提交的 signal。Apps 对恢复请求的预算与 Agent 内部查询约束保持现状。

不能用 `Promise.race` 只截断外层等待而让 fetch 继续运行。验收要确认最终 Next.js HTTP 服务收到断开后确实传播 signal；即使部署适配器未及时传播断开，入口 90 秒上限仍生效。

## A02：超时不等于没有受理

已有生产证据：同一请求返回 503 后数分钟才接纳并执行。因此必须保持以下规则：

- 明确尚未发送的准备失败可沿用既有拒绝路径；发送开始后的 abort、网络错误和回执查询失败都不能据此 `rejectSubmission()`，不能释放仍供执行使用的引用。
- 预算内发送失败时，沿用原 requestId/acceptanceKey 查询已有受理状态。若已接受，返回现有恢复结果；只有持久回执明确 `NOT_ACCEPTED` 才沿用拒绝路径。
- 预算耗尽或调用方断开时，不再追加内联恢复等待；保留 reservation，通过现有 `EVE_ACCEPTANCE_UNAVAILABLE` 和 queryId 表达未确认。HTTP 已断开时不承诺客户端收到这个响应。
- 后续由现有请求恢复入口查询。不得换新 queryId 自动重发，不取消已受理 Session，不因本轮 HTTP 结束而关闭持久消息流。
- 修改 `submit-turn.ts` 的错误路径以及 `submission-timing.ts` 的记录：同时保留首次发送失败分类、恢复结果和恢复失败分类。恢复成功记为恢复成功，不能将最终结果误记为失败。
- 日志仅保留受控 error name/code、HTTP 状态、有界 cause 分类、queryId/runId。禁止打印 token、消息、附件内容及原始请求/响应体；对外错误格式保持不变。

## A03：更新实际运行代码

2026-10-28 交付：源码提交 `94d83626bc993e3cbdf63a66dc76b1da4a1d00fb`，本地包 `.output/baigong-0.40.0-baigong.3/eve-0.40.0-baigong.3.tgz`（相对 eve 仓库根目录），SHA256 为 `36ef3fd7fcbde8dcd741c23ba5424170810592d6b8e9d2b23f6637f08503d896`。该目录被 Git 忽略。已发布 [GitHub Release](https://github.com/Procyon-Nan/eve/releases/tag/eve-v0.40.0-baigong.3)，沿用 .2 的 Release 附件分发方式，不使用 npm registry 发布。Agent 应使用下列固定下载地址更新依赖：

```text
https://github.com/Procyon-Nan/eve/releases/download/eve-v0.40.0-baigong.3/eve-0.40.0-baigong.3.tgz
```

SHA256SUMS 随 Release 一并提供。详见[包级验收记录](baigong-040-package-validation-20261028.md)。

交付方提供 eve tgz、版本、SHA256、提交 SHA 和验收记录后再执行：

1. 更新 `package.json`、`package-lock.json` 的 eve 精确依赖。目标为 `0.40.0-baigong.3`；以实际交付版本及地址为准。Agent 使用 npm，不生成 pnpm 锁文件。
2. 更新 `scripts/verify-eve-runtime-contract.ts` 中目前固定为 `0.40.0-baigong.2` 的 `EXPECTED_EVE_VERSION`。
3. 使用 `npm ci` 和现有 `npm run build` 生成完整制品，再执行 `npm run artifact:verify`。不能只更新依赖声明而复用旧 `.output`。
4. 验证安装包 compiled 及 Nitro 最终 `_libs` 包含修复行为。压缩函数名会变化，不以 `dc$2` 或 `pi$1` 是否存在判断成功；保留可复现行为验证结果与制品哈希。
5. 不通过 npm overrides 替换 Workflow：eve 已内嵌该代码，必须消费重新构建的 eve 包。

## A04：最终检查与交付

最后统一执行 `npm run quality:check`、`npm run test:eve:contract`、`npm run test:submission:database`、`npm run test:submission:http`；按实际影响执行历史、附件和业务相关检查。数据库与 HTTP 用例使用独立测试环境。沿用现有 gateway-stream、submission-acceptance、submission-timing、conversation-submission、conversation-streams 测试文件补齐场景。

必须覆盖：

- 创建、继续、补充输入均受共享预算约束；发送中 abort 后 fetch 结束，内联恢复不能再消耗一整段新预算。
- 同一请求晚于 HTTP 超时才受理，后续恢复得到原会话/轮次，只执行一次；已有拒绝和已接纳结果保持原行为。
- 原始发送失败与恢复失败均能定位，日志无敏感内容。
- 真实 HTTP 打开/取消流、历史前缀读取及尾索引查询各重复至少 20 次，eve 的 reader、监听器和轮询归基线。
- 新建/续聊、主助手与专业 agent、附件、工具、补充输入、取消/归档、刷新重连、历史及租户隔离正常；V2 水位和 `state.canSend` 不变。

在最终生产制品上完成 30 分钟连续运行观察，确认不存在随已结束读取次数增长的目录扫描、轮询和内存占用，并在验收端记录实际提交与恢复请求的耗时。只通过 health 接口或重启后暂时 CPU 降低不算通过。

交付物：Agent 实际提交及版本、eve 版本及哈希、完整 Agent 制品及哈希、检查记录、业务与资源验收记录、上一 release 回滚位置。版本最后更新，部署按现有流程另行执行；SIT/UAT/生产使用同一份已验证制品。
