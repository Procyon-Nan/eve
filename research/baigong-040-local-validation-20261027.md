---
issue: "baigongapps 报告 180；eve 0.40 修复本地验证"
status: in-progress
last_updated: "2026-10-28"
---

# eve 0.40 修复本地验收记录

结论：当前本地构建和定向行为验证通过，R08 尚未完成，不能宣称完整业务无回归。.3 已于 2026-10-28 按用户要求作为 Agent 接入包发布 GitHub Release，业务验收仍待完成。第四轮修复关闭通知提前结束读取的问题；未增加阶段计时。

## 基线

- 分支：`baigong/0.40-maintenance`，首轮生产源码基线 `2ad1e002`；首轮测试已提交为 `0e0db683`，第二轮 `7a13231c`、第三轮 `b071061e`；第四轮 `3c71348f`；第五轮 `9008913e`；第六轮 `142a3e46`；第七轮 `a2199a59`；版本提交 `94d83626`。
- 前七轮行为验证使用包版本 `0.40.0-baigong.2`。当前源码版本已准备为 `0.40.0-baigong.3`，待手动提交后重新构建、打包并验证；不能将此前 dist 视为 .3 制品。
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

## 第四轮：混合进程写入时关闭前补读

基于 b071061e，新增同一 reader 接收本进程和独立 Node 进程各 20 块的场景。外部进程写入首块并通知就绪后，本进程开始写入；等待两个写入者完成后关闭流。断言共收到 40 块、各写入者内部顺序不变且无重复，不要求进程之间固定的调度顺序。

修复前：既有 14 项流场景通过，新增场景仅收到本进程的 20 块。原因是本地 close 事件直接调用 finish，跨进程已落盘的块尚未来得及被 100ms 轮询发现。

修复：world-local-stream-lifecycle.mjs 将 close 通知作为补读信号，只有读到持久 EOF 才正常结束。通知发生在磁盘读取期间时，当前读取完成后再补读。保留现有去重、取消与错误清理，不增加存储格式、轮询周期或公共接口。

执行结果：

- pnpm --filter eve build:compiled：通过，重新生成包含修复的 compiled。
- 按第三轮相同命令运行三个 scenario 文件：31/31 通过（流 15、Workflow 恢复 5、hook 11），用例约 10 秒，总计约 38 秒。
- pnpm --filter eve typecheck：通过。
- 两个代码文件定向 oxfmt / oxlint、git diff --check：通过。

本轮 compiled 指纹（算法同首轮）：436 文件，30c334a9545c4b7a11f5fcea18e366c3cb726d06cee1d2db0ead6264b14705bf。此前的 dist 指纹属于旧构建，不能用于本次修复交付；完整包和正式版本制品仍需重新生成。

静态审查确认原生 close 在持久 EOF 写入完成后才发送通知；补读复用现有 poll，读盘互斥、取消后禁止重启及失败清理继续有效。未发现阻止本批提交的问题。此项不代替全部调度组合、跨进程 hook 竞争或业务验收。

## 第五轮：跨进程 hook 创建与准备竞争

基于 3c71348f，仅扩展 hook-lifecycle.scenario.test.ts，未修改生产逻辑。

- 在父进程持有历史 token claim 锁、读取 claim 时暂停准备。
- 独立 Node 进程调用真实 compiled World 的 events.create，创建同 token、不同 owner 的 hook。
- 子进程观察真实 mkdir 锁操作的 EEXIST 后通知父进程；不模拟锁结果，不依赖固定睡眠制造竞争。父进程随后放行准备。
- 创建返回 hook_conflict，conflictingRunId 为原 run；hooks.getByToken 和持久 claim 均保留原 runId/hookId。
- gate 在 finally 中释放，并等待准备和子进程结算；子进程设 15 秒超时，World 和临时目录沿用现有清理。

验证结果：

- pnpm --filter eve exec vitest run --config vitest.scenario.config.ts src/execution/hook-lifecycle.scenario.test.ts：12/12 通过，用例约 1 秒，总计约 26 秒。
- pnpm --filter eve typecheck：通过，复用未变动的 compiled。
- 定向 oxfmt / oxlint、git diff --check：通过。

静态审查覆盖跨进程锁竞争的实际触发、所有权断言、子进程退出与门闩释放，未发现阻止提交的问题。本轮未重复运行流场景或完整构建；第四轮结果保留原执行边界。运行期 disposal/终态转换与查询交错仍待覆盖。

## 第六轮：查询与处置、终态转换交错

基于 9008913e，仅扩展 hook-lifecycle.scenario.test.ts，未修改生产逻辑。新增四组参数场景：实体查询/事件索引恢复分别与 hook_disposed/run_cancelled 交错。

查询已从磁盘读取旧实体或 hook_created 事件、尚未完成可用性检查时暂停；通过真实 events.create 提交处置或取消，再放行查询。事件索引场景仅删除 claim，保留可供处置操作使用的实体。断言：

- 进行中的查询返回 HookNotFoundError。
- 随后的独立查询仍返回 HookNotFoundError。
- claim 与实体文件均不存在，没有被查询恢复。

首次事件索引处置用例因同时删除实体而在处置操作处返回 HookNotFoundError，未进入目标竞争窗口；已调整为只删除 claim。该失败属于测试前置条件，不作为产品缺陷。

验证结果：

- pnpm --filter eve exec vitest run --config vitest.scenario.config.ts src/execution/hook-lifecycle.scenario.test.ts：16/16 通过，用例约 1 秒，总计约 16 秒。
- pnpm --filter eve typecheck：通过，compiled 未改动。
- 定向 oxfmt / oxlint、git diff --check：通过。

静态审查覆盖暂停位置、失效事件真实提交、门闩 finally 释放及查询结算，未发现阻止提交的问题。验证范围为上述四个交错窗口；不代表所有指令级交错，也未新增生产锁或重复校验。未重复运行未改动的流场景及完整构建。

## 第七轮：waiting 后取消观察与游标续接

基于 142a3e46，修改测试和测试初始化入口，未修改生产逻辑。

核查发现集成测试原先通过 @workflow/world-local 创建 World，没有加载本仓库 world-local 补丁。workflow-setup.ts 现改为 #compiled/@workflow/world-local/index.js；Workflow core 仍通过现有内部 runtime 入口加载。此前集成测试结果仅证明原测试环境行为，不作为 patched World 已验收的依据；之前的生命周期 scenario 本身直接使用 compiled World，不受此问题影响。

新增真实 workflowEntry 对话用例：首轮到达 session.waiting 后记录尾索引，取消并释放观察 reader；通过 dispatchContinuation 向同一 session 发送第二条消息，再从 tail + 1 订阅。验证第二轮包含对应回复并再次到达 session.waiting；没有首轮事件 ID、没有重复事件 ID。该用例验证观察流取消不取消业务会话，并保持续读游标语义。

执行结果：

- 原入口下先运行既有续聊、事件回读 2 项：通过，用于确认现有用例可运行。
- 改为 compiled World 后执行：
  pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/execution/workflow-entry.integration.test.ts -t 'parks in conversation mode and resumes via runtime delivery|stamps every stream event with an id that survives a rewind|resumes from the tail after cancelling'
  结果 3/3 通过、18 项未选中；用例约 12 秒，总计约 54 秒。
- pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/runtime/host-runtime/acceptance.integration.test.ts：切换入口后复验 2/2 通过，用例约 5 秒，总计约 31 秒。
- pnpm --filter eve typecheck：通过，复用未变动的 compiled。
- 两个测试文件定向 oxfmt / oxlint、git diff --check：通过。

静态审查覆盖观察取消与业务取消的区别、尾游标读取、旧事件排除、reader 清理及测试 World 来源，未发现阻止提交的问题。测试使用模拟模型和本地 Workflow 处理器，没有通过 Apps/Agent HTTP 链，也没有调用真实模型。构建输出包含依赖 gray-matter 的 eval 警告和构建插件耗时提示，命令成功退出。

## 版本提交准备

已将源码版本更新为 0.40.0-baigong.3，补齐根及包级 changelog、六项 prerelease changeset 消费记录及交付状态。版本与 changeset 一致性检查、git diff --check、直接执行 node scripts/guard-invariants.mjs 均通过，静态审查未发现阻止提交的问题。

pnpm guard:invariants 因 manifest 变化先触发自动依赖同步，已中止该步骤并改为直接执行同一规则脚本；锁文件仍仅保留原先四行 deprecated 元数据变更，不纳入版本提交。未执行本版本完整构建、打包、安装或发布。待手动提交后再生成绑定实际提交 SHA 的制品。

## 2026-10-28 制品验证补充

版本已提交为 94d83626，.3 完整构建、tgz 生成及隔离安装检查已完成，详见[制品验证报告](baigong-040-package-validation-20261028.md)。此前“版本提交准备”段落为历史记录；当前剩余边界以本节及下表为准。

## 尚未完成

- 本地 waiting 续接已验证；HTTP 链取消验证并入下方 Apps → Agent → eve 业务验收。
- eve .3 tgz 隔离安装已完成；Agent Nitro 制品验证、Agent A01/A02 等待预算与错误处理仍待实施。
- Apps → Agent → eve 的真实取消、延迟受理恢复、租户及现有业务矩阵、固定负载 30 分钟观察。没有执行部署。
- 仓库规则检查结果单独记录；不得跳过失败或更新契约 baseline 来替代修复。

第七轮及版本已提交，.3 包级检查完成；Agent 接入和业务验收继续保持待办，不关闭 R08。
