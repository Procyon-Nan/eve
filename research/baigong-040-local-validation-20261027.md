---
issue: "baigongapps 报告 180；eve 0.40 修复本地验证"
status: in-progress
last_updated: "2026-10-27"
---

# eve 0.40 修复本地验收记录

结论：当前本地构建和定向行为验证通过，R08 尚未完成，不具备发布或宣称业务无回归的条件。本轮没有修改生产源码，没有增加阶段计时。

## 基线

- 分支：`baigong/0.40-maintenance`，首轮生产源码基线 `2ad1e002`；首轮测试已提交为 `0e0db683`，第二轮新增测试尚待用户提交。
- 包版本：`0.40.0-baigong.2`，尚未更新到正式交付目标 `0.40.0-baigong.3`。
- Node `24.21.0`，pnpm `11.21.0`；core `5.0.0-beta.43`，world-local `5.0.0-beta.37`。
- 所有命令在仓库根目录执行，使用 WSL Node/pnpm。测试使用 tier config，从新生成的 compiled 加载，不提取压缩私有函数作为替身。
- 安装依赖已在 R01 完成，本轮未重复安装或访问生产服务。

## 首轮已执行

| 命令                                                                                                                                                                                      | 结果                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm --filter eve build:compiled`                                                                                                                                                        | 通过，依赖版本和补丁替换检查通过                           |
| `pnpm --filter eve build`                                                                                                                                                                 | 通过，包含生产声明生成、JS 打包、compiled 复制及版本替换   |
| `pnpm --filter eve exec vitest run --config vitest.unit.config.ts src/execution/ndjson-stream.test.ts src/execution/workflow-runtime.test.ts src/runtime/host-runtime/acceptance.test.ts` | 48/48 通过                                                 |
| `pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/runtime/host-runtime/acceptance.integration.test.ts`                                                         | 2/2 通过，真实受理并发所有权及未决状态冷启动               |
| `pnpm --filter eve exec vitest run --config vitest.scenario.config.ts src/execution/stream-lifecycle.scenario.test.ts`                                                                    | 9/9 通过，约 5 秒用例执行时间；scenario setup 另有打包时间 |
| `pnpm --filter eve exec tsc -p tsconfig.json --noEmit`                                                                                                                                    | 通过，包含本轮测试                                         |
| 定向 `oxfmt` / `oxlint`、`git diff --check`                                                                                                                                               | 通过                                                       |
| `pnpm guard:invariants`                                                                                                                                                                   | 修正文档日期、runtime 导入和工作区换行后通过               |
| `pnpm --filter eve typecheck`                                                                                                                                                             | 初次因 CRLF 输入校验失败；工作区换行修正后完整命令通过     |

`pnpm guard:invariants` 首次报告文档日期、测试 runtime 导入和六项扩展契约报告不匹配。已修正文档日期及导入；契约报告转换为 LF 后六项不匹配消失，完整规则检查通过。没有重生成契约或修改 epoch，这些报错不代表扩展 API 发生变化。

标准 typecheck 的阻断已独立定位：在临时目录运行同一模板生成器，当前生成结果与已提交模板仅有嵌入字符串中的 `\r` 差异，移除该差异后二者相同。原因是工作区 CRLF 源文件被生成器原样嵌入，不涉及本轮修改的文件。已将受影响的 tracked registry 源文件、模板输出和契约报告在工作区转换为 LF（共 123 个文件），Git 内容差异没有新增这些文件；未改生成器、契约内容或 epoch。随后标准 typecheck 完整通过。

构建目录指纹（非 tgz 哈希）：按相对路径排序，对每个文件追加 UTF-8 相对路径、NUL、该文件 SHA-256 原始 32 字节，再计算整体 SHA-256。

- `.generated/compiled`：436 文件，`f68f04731971af117f23597c29a96798d5c41b7b8556851e206640c64dafc536`。
- `dist`：3312 文件，`99435fbddfb1c2beadb5c77737571d1d383a71bb52b604f2a0de8e2a9517ba06`。

## 行为结果与审查

- 修正旧回执用例仍要求 `getRun().returnValue` 的断言；持久回执查询仍作为确认依据。
- 新增假时钟回归：30 秒截止后返回不确定，再推进 60 秒没有新增查询和遗留计时器；随后持久回执变为 ACCEPTED 时可恢复，提交仅一次。
- NDJSON 非法输入取消未结束源流；即使取消清理抛错，仍向消费者报告原始 SyntaxError，源 reader 锁释放。
- 尾索引 -1、0、9 各查询 20 次，无实时 reader 创建。
- 使用实际 compiled `getRun().getReadable()` 和 world-local reader，各执行 20 次非 EOF 取消。原生 pipeThrough 的上游取消异步传播后，文件轮询归零；再观察 250ms 无新增目录扫描、无重连，已打开源流全部解锁。没有把公共流 cancel 返回瞬间等同于整条 pipe 链清理完成。
- 初次连接与重连在取消后迟到，迟到源流解锁；后续观察无目录扫描或额外连接。
- 实际文件持久块按 first、second 顺序交付并结束于 EOF；注入 EIO/EACCES 时当前读取报错，不跳到后面的块。
- 100 和 1000 个只有实体的旧 hook 在启动准备后可查询；准备完成后连续查询缺失 token，不读取历史 hook 实体文件。
- 新增 5 个单测参数实例在 `b55fdd3d` 对应的修复前生产源码上均因预期旧行为失败：不取消源流、尾索引创建 reader、以 returnValue 代替持久回执。已恢复修复源码并重跑 48 项全部通过。
- 静态审查确认只添加行为测试、更新旧断言和文档，不增加产品开关、测试专用生产出口或额外监控机制。

## 第二轮：取消等待、跨进程轮询及 hook 生命周期

本轮没有改动生产源码。使用同一 compiled 制品，扩展 `stream-lifecycle.scenario.test.ts` 并新增 `hook-lifecycle.scenario.test.ts`。

- EOF 元数据查询尚未返回时取消；迟到的 `done: false` 不触发重连，源流已释放锁。
- reader 先进入磁盘轮询，再由独立 Node 进程写入 first、second 并关闭。正常路径顺序交付并 EOF；注入 EIO/EACCES 后报错并清除实际轮询定时器，后续 250ms 无目录扫描。子进程与 reader 之间没有同进程事件通知。
- tag 仅能读取自身及 untagged hook；即使另一 tag 已准备好 claim，也不能越界读取。
- 活动 run 不因最短保留期已过而失去 hook；终态 run 在保留期内仍可读取，过期后不恢复 claim。
- disposal 标记优先于保留期，不复活已处置 hook。
- 不同 owner 的现存 claim 阻止准备且原始内容不被覆盖；移除冲突后可重试，失败结果没有被缓存为就绪。
- 同 owner 但缺少 hookId 的旧 claim 补齐 hookId；不伪造 eventId。
- 两个独立 Node 进程对同一历史实体并发准备后得到同一 owner；第三个新进程重启读取结果一致。本用例验证并发准备，不代替业务 hook_created 并发竞争测试。

执行结果：

| 命令                                                                                                                                                                 | 结果                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm --filter eve exec vitest run --config vitest.scenario.config.ts src/execution/stream-lifecycle.scenario.test.ts src/execution/hook-lifecycle.scenario.test.ts` | 21/21 通过，其中流场景 13 项、hook 场景 8 项；用例约 7 秒，含 setup 总计约 19 秒 |
| `pnpm --filter eve typecheck`                                                                                                                                        | 通过；compiled 指纹未变，复用现有构建                                            |
| 对两个场景文件执行 `oxfmt`、`oxlint`，执行 `git diff --check`                                                                                                        | 通过                                                                             |

静态审查覆盖子进程超时与退出、临时目录清理、reader 锁释放、spy 恢复和断言边界，未发现阻止提交的问题。未重复运行此前已通过且未变动的 48 个单测、2 个集成测试及完整构建；本轮不把这些结果冒称为新执行。

## 第三轮：游标恢复、监听器清理与 hook 创建竞争

基于第二轮提交 `7a13231c`，本轮仅修改测试，继续使用实际 compiled Workflow 和 world-local；没有增加生产计时、日志或其他运行逻辑。

- 经 `getRun().getReadable()` 读取完整首帧，在第二帧内第 2 字节（帧头）或第 6 字节（载荷）断流，再连接从完整帧游标 1 重读；结果为 first、second，各源 reader 释放锁。
- 负索引 -1 保持单连接行为，不查询 EOF 元数据。
- 经 `getRun().returnValue` 反序列化 raw/framed-v1 字节流，在初次连接未完成时取消；迟到源流仅取消一次并释放锁。此项只覆盖连接期间取消，不代表字节流全部读写行为。
- Workflow 和 World 各执行 20 次非 EOF 取消，同时验证 chunk/close 监听器从 1 回到 0、定时器归零及源锁释放；观察窗口内没有额外目录扫描。
- 暂停已有块的磁盘读取，同时写入下一块并关闭流；恢复后 first、second、EOF 顺序交付，无重复。
- 暂停历史实体准备，同时发起竞争 owner 的 hook_created；准备完成后返回原 owner 对应的 hook_conflict，原 claim 不被覆盖。
- 删除真实 hook_created 生成的实体和 claim，可通过 token 事件索引恢复；真实 hook_disposed 后不能复活。
- 查询过的 hook 在真实 run_cancelled 事件后不可再读取。

本轮发现并修正测试就绪条件：仅观察一个定时器不能证明底层 World reader 已创建，因为 Workflow 包装层自身也有轮询。现在先确认底层 get 调用和监听器注册，并在断言失败时也取消、释放 reader，避免后续用例被残留读取污染。

| 命令                                                                                                                                                                                                                         | 结果                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm --filter eve exec vitest run --config vitest.scenario.config.ts src/execution/stream-lifecycle.scenario.test.ts src/execution/workflow-stream-recovery.scenario.test.ts src/execution/hook-lifecycle.scenario.test.ts` | 30/30 通过：流生命周期 14 项、Workflow 恢复 5 项、hook 生命周期 11 项；用例约 9 秒，总计约 32 秒 |
| `pnpm --filter eve typecheck`                                                                                                                                                                                                | 通过；compiled 已是最新，复用构建                                                                |
| 三个场景文件定向 `oxfmt` / `oxlint`，`git diff --check`                                                                                                                                                                      | 通过                                                                                             |

静态审查覆盖实际 runtime 入口、完整帧游标断言、真实文件事件交错、所有权冲突及取消清理；未发现阻止本批提交的问题。没有重跑未变动的单元、集成测试和完整构建；前两轮结果保留各自执行边界。

## 尚未完成

- 多写入者并发交错、waiting 后续接及其余端到端取消组合；本轮已覆盖半帧、负索引、两种字节流连接期间取消、磁盘与同进程事件交错和监听器清理。
- 跨进程 hook_created 与准备竞争、运行期 disposal/终态转换与查询并发交错；本轮覆盖同进程创建与准备竞争，以及先后发生的 disposal/终态转换和事件索引恢复，不代表所有并发组合。
- 正式版本 tgz 安装与 Agent Nitro 制品验证、Agent A01/A02 等待预算与错误处理实施。
- Apps → Agent → eve 的真实取消、延迟受理恢复、租户及现有业务矩阵、固定负载 30 分钟观察。没有执行部署。
- 仓库规则检查结果单独记录；不得跳过失败或更新契约 baseline 来替代修复。

第三轮测试可单独手动提交；后续按剩余验收项继续，不因本地场景通过关闭 R08。
