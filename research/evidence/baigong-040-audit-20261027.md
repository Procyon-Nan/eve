---
issue: "baigongapps 报告 180；2026-10-27 流与受理链核查"
status: evidence
last_updated: "2026-10-27"
---

> 调查材料归档。原文件：`/tmp/eve-stream-audit-20261027/findings.md`。
> 下文为用户指定核查文件的原文，所述生产查询和探针执行属于原调查，不表示本次编写方案重新执行了这些操作。原调查的探针仍在临时目录，最终验收必须另存可复现材料。
> 实施状态以[0.40 修复方案](../baigong-040-stream-lifecycle-repair.md)为准。

# Eve 0.40 消息流与受理超时核查报告

核查日期：2026-10-27。时间线均为北京时间。范围：用户提供的 Apps 故障报告、Agent 调用链、Eve 0.40 维护分支、实际安装依赖及 180 服务器的只读日志和元数据。

## 结论

原报告的核心缺陷成立：Workflow 把取消后的读取结束当成断流，重新建立无人持有的文件读取器。实际 world-local 临时目录验证了残留轮询，而非仅验证 cancel 被调用。

本次进一步确认尾索引查询也能触发该缺陷，并发现 NDJSON 异常清理、文件轮询错误处理、受理回执超时及缺失 hook 查询的额外问题。

生产超时请求已经按 queryId、数据库轮次和 acceptanceKey 关联到后续执行：14:21 返回 503，14:25 才确认接纳，随后执行完成。不能将受理超时解释为请求未执行。

尚不能把这一次约 300 秒等待全部归因于轮询泄漏。已有证据精确定位了受理链和延迟执行，但没有 Eve 内部各段耗时，无法量化文件扫描、工作流启动与队列等待分别占多少。

## 核查基线

- Eve：`baigong/0.40-maintenance`，`b55fdd3d`，`0.40.0-baigong.2`。
- 该源码声明 `@workflow/core@5.0.0-beta.43`、`@workflow/world-local@5.0.0-beta.37`。
- Eve 工作区残留 node_modules 实际为 core 5.2.0、world-local 5.1.0，不能用来证明 0.40 构建通过。本次没有安装或修改依赖，行为验证使用 Agent 已安装的 `0.40.0-baigong.2` 制品。
- 180：Agent `0.0.57`，release `/opt/baigong-agent/releases/0.0.57-d3acb86-20261026-005926`。
- 本地安装包与生产安装包的 core chunk、world-local bundle、NDJSON 模块 SHA256 相同。没有将此表述为本次独立比对了生产生成的整个 `_libs/eve+zod.mjs`。
- 生产服务已于 14:34:42 重启，仍为上述版本；不是本次调查执行的操作。原报告的 PID、CPU 和系统调用数字是重启前采样，不是当前持续指标。

| 文件（相对 Eve dist/src）                        | SHA256                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| compiled/_chunks/workflow/wait-until-BZHmJCAW.js | 3768e646f1f63c9976452512134e7d1bf4ccccfc232c88640dc35f6e4c5b4e53 |
| compiled/@workflow/world-local/index.js          | 36e8cb6bbb4d07fc49f4772cc544303ed033636c37b3d431bf72ddd50ae79963 |
| execution/ndjson-stream.js                       | 77c6c8aebf4c987cc4b98caf1cb9fd049366132417f5c1dc25a2e701c901d5a4 |

## 发现 1：取消后重新连接，留下文件轮询

- **Location**：`@workflow/core` 的 `createReconnectingFramedStream`；可读依赖源码 `core/dist/serialization.js:646`，连接在 661 行，取消在 832 行附近。实际制品对应 `core-bundled.js` 的 `dc`。Eve 触发点另见 `packages/eve/src/execution/workflow-runtime.ts:245`。
- **Problem**：没有终止状态。取消正在等待的 read 会产生 done，pull 随后按断流重连；取消发生在初次连接或重连尚未返回时，也不会清理稍后到达的新 reader。实际测试一次取消残留一个轮询，五次取消残留五个。仅查询尾索引后 cancel 也留下一个轮询。
- **Recommended Change**：由帧流持有单一终止状态，在取消开始时设置；连接、读取、元数据检查与重连的 await 返回后均遵守该状态。迟到的 reader 立即取消并释放。保持真正断流的游标恢复。尾索引查询改用纯元数据能力，避免为查询元数据创建读取流；通过 Workflow 公开接口或在依赖层补齐接口，不在 Agent 绕过框架读取文件。
- **Expected Benefit**：退出读取后资源确实释放；历史查询不再额外启动无用读取；避免资源数量随操作累加。
- **Risk Level**：High。
- **Confidence**：High。真实文件轮询复现，且直接取消原始 world-local 流与正常 EOF 均能清理，故问题明确位于重连包装层。

Agent 配置的 `streamReconnectPolicy: { reconnect: false }` 只控制 HTTP 客户端重连，不关闭 Eve 服务端 Workflow 的这层重连。

## 发现 2：文件轮询错误可静默丢块，并缺少终止清理

- **Location**：`@workflow/world-local` 的 `streams.get()`；可读依赖源码 `world-local/dist/streamer.js:300`、453、464、487。实际制品对应 `world-local-bundled.js` 的 `pi`。
- **Problem**：初始化读取失败后没有执行 teardown，遗留监听器。轮询把带 code 的文件错误全部吞掉，持续错误时消费者一直等待。更严重的是先将块加入 deliveredChunkIds 再读文件，单次读取失败后该块永久被跳过。
- **Recommended Change**：统一初始化、取消、正常结束和读取异常的终止清理；不可恢复的文件错误向上报告并停止轮询。区分“正在读取”和“成功交付”状态，失败不得留下已交付标记，同时保留同进程事件与磁盘轮询的去重约束，不能简单移动一行后引入重复交付。
- **Expected Benefit**：避免静默丢事件及永久挂起，明确错误后的资源归属。
- **Risk Level**：High。
- **Confidence**：High。两个独立进程使用实际 world-local：写入 first、second，给 first 的文件读取注入一次 EIO，随后恢复；最终仅收到 second 并正常 EOF。另验证初始化失败残留两个监听器，轮询持续失败仍有一个定时器和两个监听器。

这些是隔离注入错误后的确定行为，未发现证据证明本次生产故障已经出现磁盘 EIO 或同类丢块。

## 发现 3：NDJSON 解析失败只释放锁，未关闭源流

- **Location**：Eve `packages/eve/src/execution/ndjson-stream.ts:62`。
- **Problem**：JSON.parse 抛错后只调用 controller.error 和 reader.releaseLock；释放锁不等于取消读取源。异常输出流无法代替应用清理底层仍在运行的文件流。
- **Recommended Change**：在解析/交付异常路径取消仍活动的源 reader，随后释放锁；避免清理错误覆盖原始解析错误。正常 EOF 与调用者取消继续沿用明确生命周期。
- **Expected Benefit**：坏帧导致当前读取失败后不再遗留后台工作。
- **Risk Level**：Medium。
- **Confidence**：High。实际 NDJSON 模块接实际 world-local，非法 JSON 导致解析失败后仍残留一个轮询和两个监听器。

该问题独立于发现 1：探针直接连接原始 world-local，没有经过 core 重连包装层。

## 发现 4：受理回执超时后，底层 returnValue 查询仍继续

- **Location**：Eve `packages/eve/src/runtime/host-runtime/acceptance.ts:87`、167；core `dist/runtime/run.js:255` 的 `#pollReturnValue()`。
- **Problem**：Promise.race 只让调用方停止等待，未停止 Run.returnValue 内部轮询。之后代码又开启另一路有期限的状态查询。原 returnValue 查询会继续到工作流终态或异常；若工作流长期停留运行态，轮询也长期存在。
- **Recommended Change**：复用已有持久回执状态读取，合并为一条有截止时间的等待链，取消超时后无人持有的 returnValue 等待；或者依赖提供真正可取消的等待接口。停止的是等待资源，不是擅自取消已经受理的业务执行。
- **Expected Benefit**：超时后没有多余后台状态查询，也减少重复等待与错误分支。
- **Risk Level**：Medium。
- **Confidence**：High。实际 Run.returnValue 配合可计数的运行态元数据，调用方超时时已查 3 次，超时之后仍新增 7 次。探针将轮询间隔缩短为 10ms，未用该数字推算生产负载。

## 发现 5：新受理标识查询会全量顺序读取历史 hook 文件

- **Location**：world-local `dist/storage/hooks-storage.js:111` 的 `findHookByToken()`；Eve `packages/eve/src/runtime/host-runtime/acceptance.ts:38`。
- **Problem**：新 acceptanceKey 没有 token claim 文件，立即进入旧数据恢复路径，枚举并顺序读取全部 hook JSON；查不存在的标识也要做全量扫描。首次受理必经查询，因此历史 hook 越多，新请求固定前置工作越多。调查时生产约有 1027 个 hook 实体。
- **Recommended Change**：以现有 token 索引/claim 为正常查询路径，将旧数据恢复放到明确、受控的索引重建流程；处理好首次升级和跨进程创建的一致性，不得直接将 claim 缺失等同业务不存在而破坏幂等。
- **Expected Benefit**：新请求不再随全部历史记录增加而增加串行文件读取，降低与事件轮询争用文件系统的开销。
- **Risk Level**：Medium。
- **Confidence**：High。100 个有效历史 hook 的临时目录，查询新 token：第一次读 200 个 hook 文件（包括索引初始化），再次查询仍读 100 个。

已证实扫描复杂度；未将此单独认定为生产数分钟等待的全部原因。

## 发现 6：Agent 提交没有显式等待期限，最终等待到 HTTP 默认约五分钟

- **Location**：Agent `src/server/eve/client.ts:92`、109、115；Eve `packages/eve/src/client/session.ts` 的请求 fetch；Eve acceptance.ts:119 的 hook 等待。
- **Problem**：创建、继续和补充输入不传入明确的 signal/deadline。Eve 的局部 30 秒检查不约束全部调用，也不截断正在 await 的单次存储操作。Agent 最终依赖 Node HTTP 客户端默认响应头超时。
- **Recommended Change**：修复底层后确定明确的受理等待预算，并由提交链一致传递；网络失败继续作为受理状态不确定，通过原 requestId/acceptanceKey 恢复。记录安全的底层错误分类与关键子阶段耗时，不能只留下 ApplicationError。不要把缩短超时当作取消 Eve 执行，不要失败后换新编号自动重发。
- **Expected Benefit**：等待时间由业务合同定义，超时原因可定位，同时保留幂等与延迟受理恢复。
- **Risk Level**：Medium。
- **Confidence**：High（当前行为）。生产历史那次请求的具体底层错误类型未被日志保留，不能追认它一定是同一种错误。

实际安装 Eve SDK 连接本地“收到请求但不发送响应头”的 HTTP 服务，沿用 Agent 无 signal 的调用方式，300697ms 后失败，cause 为 UND_ERR_HEADERS_TIMEOUT。180 的 Node 内置 Undici 源码默认 headersTimeout 为 300000ms，与该机制一致。

## 生产超时请求的完整关联时间线

标识：

- HTTP requestId：`9c9d834e-3b60-4259-b326-cad292fffe3d`
- queryId / conversation_turns.request_id：`69f1bf89-5956-4bb7-aa40-a45dc8f62a03`
- Agent turn：`e9315c58-7533-4baa-9288-bb6f7212754a`
- acceptanceKey：`root:e9315c58-7533-4baa-9288-bb6f7212754a`
- acceptance run：`wrun_01M5Y08WN5EBMY932QGSTQ3768`
- session run：`wrun_01M5Y0GSFFTJ2435274D8SBJ8D`
- turn run：`wrun_01M5Y0J7ZVES281J1A34FDE4VZ`

| 时间                       | 持久记录/日志                                                             |
| -------------------------- | ------------------------------------------------------------------------- |
| 14:16:08.887               | Agent 预留轮次                                                            |
| 14:20:28.754               | 受理工作流创建/启动                                                       |
| 14:20:30.637               | 受理 hook 创建                                                            |
| 14:21:10.083               | Agent 返回 503 / EVE_ACCEPTANCE_UNAVAILABLE；eve_acceptance 耗时 300269ms |
| 14:24:47.740               | 主会话工作流创建/启动                                                     |
| 14:24:57.871、14:25:01.530 | 主会话 hooks 创建                                                         |
| 14:25:08.667               | 受理工作流收到 hook                                                       |
| 14:25:12.134—14:25:15.132  | 受理状态写入步骤                                                          |
| 14:25:16.419               | 受理运行元数据更新，状态 ACCEPTED                                         |
| 14:25:17.403               | 受理工作流完成                                                            |
| 14:25:35.229—14:26:39.692  | 本轮子工作流执行并完成                                                    |

该时间线来自数据库关联、工作流事件与受理属性，不以时间接近代替关联。子工作流完成不等于已证明浏览器成功恢复和展示了全部回复；本次没有以真实用户身份操作页面。

从请求预留到受理工作流创建、从受理 hook 到主会话创建都存在数分钟空隙。现有证据无法再将这些空隙分配到具体函数，需要受理子阶段计时。

## 已验证的正确路径与保护

- Agent 有界历史读取会 abort HTTP fetch、cancel 未使用的响应体，并在结束时调用 iterator.return；本次没有证据支持再加一层 Agent cancel 包装。
- 正常 EOF 后真实 world-local 轮询归零；直接取消原始 world-local 流也归零。
- 正常可恢复断流的隔离控制用例按游标 0、1 续读，依次交付 first、second，没有重复。
- 取消发生在重连返回前时，新 reader 仍未取消；重复取消外层也不能补救。
- 会话进入 waiting 后仍可继续交互，流没有最终 EOF 是合法状态，不能为消除轮询而伪造 EOF。
- Agent 已有受理幂等和状态恢复，应保留。网络断开、页面退出与业务执行取消是不同操作。

## 修复顺序与交付边界

1. 先处理 Eve/Workflow 读取生命周期和文件错误交付问题（发现 1—3），覆盖等待中取消、初始化/重连中取消、错误、EOF、游标恢复与真实文件清理。
2. 简化受理回执等待并处理缺失 hook 的全量扫描（发现 4—5），保持持久幂等记录及旧数据可读。
3. 加入最小受理阶段计时，和 Agent 明确等待预算/错误分类（发现 6）。超时数值属于接入合同决策，本次没有擅自设值。
4. 从匹配 0.40 的锁文件重建 Eve 依赖；修复进入可复现的源码/依赖补丁与 vendoring 构建流程，再发布 Eve 包。
5. Agent 更新包与锁文件并重新构建，验证最终运行制品，而非只验证 package.json。Agent 的 npm overrides 不能替换 Eve 已经打包进 compiled 的代码。
6. 部署后按同口径复测真实会话、断连和重复读取、CPU/文件扫描以及受理时延。重启只能清除进程内存量泄漏。

本次不需要 Apps 改动业务协议。后续若改变受理响应合同，则须另行讨论；这里不建议用 Apps 自动重发或延长页面超时规避问题。

## 验证材料与范围

同目录保留独立探针：probe.mjs、error-probe.mjs、runtime-probe.mjs、hook-probe.mjs、poll-read-error-probe.mjs、reconnect-probe.mjs、acceptance-timeout.mjs，以及已保存的 JSON 输出。core/world-local 目录是对应版本的可读依赖源码，*-bundled.js 是安装制品的格式化副本。

实际执行：源码与制品核对、SHA256 对照、独立文件流/错误/重连/超时探针、生产只读日志与指定请求元数据关联。真实文件探针全部使用临时目录并清理。

未执行：完整 Eve 构建/测试套件、生产压力测试、线上修复/部署、生产会话提交、用户界面端到端恢复验证。没有修改两个仓库的源码、锁文件、工作流数据或服务配置。SSH 会话已退出。

本报告及探针位于 /tmp，未纳入仓库；属于调查材料，不代表修复完成。
