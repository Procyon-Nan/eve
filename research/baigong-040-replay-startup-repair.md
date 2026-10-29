---
issue: local/2026-10-28-eve-replay-startup-handoff
status: proposed
last_updated: !!str 2026-10-29
---

# eve 0.40 跨版本重放、启动恢复与失败收敛修复方案

本方案基于三方本地源码核查，尚未实施。目标：兼容升级不破坏活动会话；启动恢复按容量派发；已经因本次升级失败的旧会话保留历史、停止续聊，并收敛资源及页面状态。不是生产操作授权，也不是验收报告。

## 1. 已确定的决策与边界

- Q1=A：eve 持久步骤使用独立于包发布号的合同身份，显式兼容经过核验的 `.2/.3` 旧标识；不维护多版本执行服务，不全局删除第三方步骤版本。
- Q2=B：本次已 failed 的会话不复活、不重新执行，不自动创建替代会话；保留原会话、Run、消息和执行历史。新会话由用户通过原有入口创建。
- 未失败的兼容 `.2/.3` 会话仍需支持升级后续聊，B 不等于放弃跨版本兼容。
- 不增加重试分类、重试策略、日志限流、常驻性能计时、数据库服务或通用迁移平台。
- 不用修改 `run.status`、删除失败事件或恢复生产旧备份来实施 B；不覆写已发布 `.3` 包。
- 每项实现完成后静态审查并准备独立提交，由用户执行签名提交；构建、测试、资源测量和验收统一放在实现完成之后。
- 默认并发数是验收测量后冻结的发布参数，不把未经测量的数值写成已验证结论。

## 2. 核查基线与事实

| 项目          | 本地 HEAD                                                              | 本轮范围                                             |
| ------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| eve           | `cac5043aba04d13dc5004a52b3383640c4c19136`，`baigong/0.40-maintenance` | 构建身份、vendored Workflow、World 初始化、流接口    |
| baigong-agent | `9f85402c19d3d3315f3e67b0d0aa74623b3c047a`                             | eve 网关鉴权、会话受理、历史投影、运行引用及状态维护 |
| baigongapps   | `e340cff9aa5780e010a2e7e308829ab1f97cad33`                             | NativeAgent 页面、V2 快照/事件协议、BFF 转发         |

eve 的 `pnpm-lock.yaml`、`.codegraph-wsl/` 及 Agent 已有未跟踪调查文件不属于本方案变更。现场 287 个主会话 failed、287 个超时工作流 running 等数量引用交付报告，本轮未访问生产重新统计。不能把代码核查写成生产数据验收。

### 2.1 源码证据

以下 eve 路径相对本仓库；Agent/Apps 路径相对各自仓库。Workflow 依赖核查版本为 core `5.0.0-beta.43`、world-local `5.0.0-beta.37`、world `5.0.0-beta.28`；正式修改进入 vendoring 补丁和 eve 源文件，不编辑依赖目录及 compiled 成品。

| 证据入口                                                                                                                 | 已确认行为                                                                                      | 修复含义                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| eve `internal/workflow-bundle/workflow-builders.ts: resolveModuleSpecifier`、`workflow-transformer.ts`                   | Step 使用 `${base}@${pkg.version}`；指定 Workflow 使用稳定名称                                  | 发布号变化直接改变 Step 身份                             |
| core `dist/step.js`、`dist/private.js`、`dist/runtime/step-executor.js`、`dist/serialization/reducers/step-function*.js` | 历史 Step 名严格比较；执行和反序列化还要查注册表                                                | 兼容需覆盖比较、注册、执行、函数引用复活，不能只加别名   |
| eve `workflow-builders.test.ts`                                                                                          | 测试明确要求 Workflow 去版本、Step 留版本                                                       | 替换错误合同测试，增加真实包升级验收                     |
| `.2` tag 至 `.3` 源码提交 `94d83626` 的 diff                                                                             | 本地检索到的 32 个含 `use step` 的源文件无文件变更；该统计含内部测试支持模块                    | 支持优先建立限定桥；不等同于传递依赖和序列化合同全部验收 |
| world `dist/recovery.js`                                                                                                 | 分页列 pending/running，逐项 await 入队                                                         | 入队不是执行完成，也不是容量背压                         |
| world-local `dist/queue.js`                                                                                              | 默认并发 1000；每条消息启动异步循环；acquire 等待没有关闭信号；槽位覆盖重试/timeoutSeconds 睡眠 | 需要修正调度生命周期，不仅降低数字                       |
| eve `internal/application/compiled-artifacts.ts: createWorkflowWorldPluginSource`                                        | 模块初始化 setWorld 后直接 await world.start                                                    | 有界恢复不能阻塞后续 handler 注册/监听，否则形成启动互等 |
| eve `internal/nitro/host/configure-nitro-routes.ts`、`internal/workflow/development-world-server.ts`                     | direct handler 注册与 dev 父进程 World 有不同就绪顺序                                           | 生产与开发都要设置真实派发就绪门槛                       |
| world-local `storage/events-storage.js`                                                                                  | run_failed 写终态标记、事件、Run 状态，清理 Hook/Wait；没有关闭流和取消独立超时 Run             | 需要 Workflow 外的收敛入口                               |
| eve `execution/session-timeout-control.ts`、`session-timeout-steps.ts`                                                   | 超时 Run ID 来自 startSessionTimeoutStep 输出；输入 token 是主会话 command token                | 可用持久关联定位，不按时间猜测                           |
| Agent `src/server/eve/client.ts`                                                                                         | 尾读取只读流事件；follow 明确关闭 SDK reconnect                                                 | EOF 能结束连接，但不能证明业务成功或失败                 |
| Agent `session-tail.ts`                                                                                                  | 只有 session.completed/session.failed 被分类为终态                                              | 底层失败但流尾仍是 waiting 时，当前分类无法识别          |
| Agent `runtime-references/reconciliation.ts`                                                                             | 只扫描业务已终态的 ROOT_TURN，再要求流尾终态                                                    | 当前后台维护无法自行发现“底层失败、业务未终态”           |
| Agent `db/schema/conversations.ts`                                                                                       | Turn 保存 requestId/eveTurnId/runtimeReferenceToken，没有 outcome 字段                          | Turn 终态必须在投影中处理，不能写不存在的列              |
| Agent `runtime-references/lifecycle.ts`                                                                                  | 现有释放函数清 Turn 引用、删除引用及临时记忆快照                                                | 复用此入口，不另写批量 DELETE                            |
| Agent `event-view-reducer.ts: checkpoint.restore`                                                                        | 已比较 context 的 terminalOutcome/terminatedAt，变化后拒绝旧 checkpoint                         | 复用已有失效逻辑，重点更新读取 context，不再另建缓存机制 |
| Apps `native-protocol.ts: parseNativeSnapshot`                                                                           | 终态不允许 canSend=true、activeTurnId/pendingInput 非空                                         | Agent 要输出一致的终态快照                               |
| Apps `NativeAgent.tsx: select`                                                                                           | 流正常结束仅标记 disconnected，不重新查询快照                                                   | 增加一次有界快照刷新才能识别无业务终态消息的失败         |
| Apps `nativeAgentBridge.ts`                                                                                              | 已允许 snapshot/events，快照经过 V2 校验，原消息与权限边界保留                                  | 不新增 Apps 对 eve 的直连，也不放宽协议校验              |

## 3. 进度与提交边界

标记：`[x]` 已完成；`[ ]` 未完成。实现、审查提交、验收分开记录，禁止以审查通过替代运行验收。

| ID  | 工作项                                  | 实现/产出                            | 审查提交 SHA                     | 最终验收 |
| --- | --------------------------------------- | ------------------------------------ | -------------------------------- | -------- |
| P00 | 三方源码核查、方案及交付合同            | [x] 本文件及配套交付                 | 待确认/提交                      | 不适用   |
| E01 | 步骤合同清单、稳定身份和 `.2/.3` 兼容桥 | [x] 初版 51 项，待最终包级验收       | `8a5152dc`                       | [ ]      |
| E02 | 队列执行槽位、背压、延迟唤醒和关闭      | [x] 调度器及 vendoring 接入          | `431fd32c`                       | [ ]      |
| E03 | 启动恢复分页生产及服务就绪衔接          | [x] 生产及开发启动接线               | `d4cf2239`                       | [ ]      |
| E04 | eve 执行状态只读接口与底层失败收敛      | [x] E04a 状态接口；E04b 本地失败清理 | E04a `fa28177f`；E04b `49313a40` | [ ]      |
| E05 | 本次失败会话的离线检查/收敛工具         | [x] inspect/apply 与关联清理         | `7ff2cf5c`                       | [ ]      |
| A01 | Agent 接口鉴权、状态读取与会话终态      | [ ]                                  | —                                | [ ]      |
| A02 | Agent 历史投影、在线等待与运行引用收敛  | [ ]                                  | —                                | [ ]      |
| A03 | Agent 存量清单处理及请求恢复语义核对    | [ ]                                  | —                                | [ ]      |
| W01 | Apps OpenSpec 与 EOF 后快照刷新         | [ ]                                  | —                                | [ ]      |
| V01 | 统一构建、定向测试、包级跨版本验收      | [x] 源码及正式 tgz 隔离验收通过      | `96606a25`；版本待签名           | [x]      |
| V02 | 574 规模调度、资源及三方业务验收        | [ ] eve 调度测量完成；三方业务待接入 | `96606a25`                       | [ ]      |
| R01 | 版本、CHANGELOG、不可变 tgz 及最终交付  | [ ]                                  | —                                | [ ]      |
| D01 | 生产备份、停写、存量收敛和切换          | [ ] 另行授权执行                     | —                                | [ ]      |

顺序：E01 → E02 → E03 → E04 → E05；A01—A03/W01 按 E04 合同接入；全部实现完成后 V01/V02，版本最后统一更新并用正式包复核。每个功能单元完成后审查并交用户签名提交，不执行 git commit。

## 4. E01：稳定步骤身份与限定兼容

### 4.1 实现

新增 eve 自有的步骤合同清单，例如 `internal/workflow/step-contracts.ts`（拟新增）。每项包含精确的源码归属、导出函数/方法身份、稳定 Step ID、允许的旧完整 Step ID。稳定 ID 使用明确合同代号，不取 `package.json.version`。

覆盖 workflowEntry、turnWorkflow、sessionTimeoutWorkflow、taskRunWorkflow、hostRuntimeAcceptanceWorkflow 可达的持久 Step，包括内置辅助步骤。根据实际构建 manifest 生成审查清单，内部 testing 模块不因目录扫描被自动列为业务兼容项。

1. 构建转换器在 workflow/step/client 三种模式使用同一合同清单；只对清单中的 eve 步骤稳定化。
2. 新事件使用稳定 ID。旧 `.2/.3` 事件文件原样保留；重放比较时仅把白名单中的完整旧 ID 与对应稳定 ID 认作同一合同。correlationId 校验原样保留。
3. Step registry 同时注册经过核验的旧名称，确保旧持久 stepName 队列派发、getStepFunction、序列化 Step 函数引用均解析到正确实现。成员方法转换路径同样检查。
4. 对 step.js 的消费者比较通过 core vendoring 补丁注入同一清单；不得只改错误文本或抑制 ReplayDivergenceError。
5. 不匹配清单的包、版本、函数和方法仍拒绝。无名的通用去版本正则禁止使用。
6. 后续代码改变执行顺序、入参/出参、Hook 调用或序列化合同时必须重新评审合同；稳定 ID 不代表任意代码修改兼容。新增不兼容合同不得冒用旧身份。

### 4.2 必须交付的证据

- 新旧完整 ID 对照及每个兼容项的源码/依赖差异说明。
- 真 `.2`、真 `.3` 创建的活动会话，在修复包下继续；已完成模型/工具步骤不再次执行。
- 主会话、专业 agent、补充输入、受理、超时、取消；拒绝错误 correlationId、未知版本与错误 Step ID。
- 不复活已经 failed 的记录。文档中的升级夹具必须从尚未被 `.3` 标 failed 的基准副本启动。

## 5. E02/E03：有界恢复与队列生命周期

### 5.1 调度单位

执行槽只覆盖一次实际 handler 派发及响应体读取。响应要求延迟再次派发、传输退避或 workflow 已挂起后，先释放槽，再安排后续唤醒。不能让等待用户输入或睡眠中的 workflow 长期占槽。

保留现有投递次数、重试分类和退避语义，不增加重试策略。修复“等待占槽”和“无容量仍创建执行 Promise”即可。

### 5.2 调度实现约束

- 扩展现有 world-local queue，限制实际派发 `C` 和恢复来源的已就绪等待项 `B`。恢复扫描只有获得入队容量后才取下一项；不先对全部存量调用 queue 并积累 acquire Promise。普通业务消息沿用现有接纳语义，本次不增加“请求已持久化后因恢复队列满而拒绝”的行为。
- 普通请求与恢复项分来源、公平选取；恢复不能占满所有派发容量。父工作流发出的子执行沿用普通派发路径，不能等待一个被父执行占满的恢复池。
- 已就绪列表保存消息描述，不为每个等待项挂一个 acquire Promise。到期等待保存必要描述，由到期调度器推进；不要把每个长期 sleep 保持为一个活跃异步派发循环。
- 明确资源边界：`C/B` 限制活跃派发和恢复 ready backlog；持久 Run/Wait、延迟描述和普通业务待派发项仍随工作量增长，不宣称整个内存恒定。验收分别统计 recovery-ready、normal-ready、delayed、active，不能把 delayed 或普通队列从统计中隐藏。本次容量承诺针对启动恢复，不冒充全服务的业务过载治理。
- 原有 Run/Wait 是重启恢复依据，不新增消息数据库。重启后恢复挂起的 workflow，由原有持久 sleep/Hook 语义重新建立唤醒；不跳过所有 running。
- 关闭依次阻止新入队、取消分页生产、取消容量等待/到期定时器、停止派发并释放 transport。直接 handler 的执行结束与外部请求取消分别记录，不把 close() 返回等同于远端副作用回滚。
- 成功、失败、取消都释放槽位及去重记录。保留同一队列消息的幂等语义和真实传输错误，不将入队失败当作已恢复。

E02 实现：`local-queue-scheduler.ts` 统一持有待派发描述、活跃派发和一个到期定时器；恢复项最多使用 `max(1, floor(C/2))` 个执行槽，普通项与恢复项轮换选取。`queueRecovery` 在容量可用时入队，关闭唤醒被阻塞的生产者。当前参数默认值沿用原值，待 V02 测量冻结。已完成静态审查；回归用例已编写，尚未执行；启动恢复接线归 E03。

### 5.3 启动顺序

将 world.start 的“初始化目录、Hook 索引准备”和“恢复派发”分开：初始化就绪后返回；恢复生产只在本实例的 handler/direct handler 或 HTTP listener 实际可接受请求后启动。就绪信号由 eve 启动代码传递，不固定 sleep，不靠反复发送失败请求探活。

新增逻辑放 eve 源模块和 vendoring 补丁，生成插件只导入/调用。生产 `compiled-artifacts.ts`、handler 注册和 dev 父进程 `development-world-server.ts` 同步接入；不得出现插件等待恢复完成、恢复等待 handler 注册的循环。

E03 实现：生产 World 使用 `deferRecovery` 先完成初始化，非懒加载 handler 模块注册直接派发入口后调用 `startRecovery`；开发父进程在监听器和 worker 就绪后启动后台分页生产。两条路径共用 `recoverLocalRuns`，等待 `queueRecovery` 容量后继续扫描；保留 tag 隔离、命名空间、开发投递鉴权头和缺失 generation 隔离。关闭先取消生产，再关闭队列并等待生产退出。恢复失败报告错误，不伪报扫描完成。静态审查已完成，运行验收待 V01/V02。

ready 表示初始化及新请求入口可用，不表示所有长期会话已结束。恢复后台进行，新请求、取消和状态读取可用。

保留 `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS`、`WORKFLOW_LOCAL_QUEUE_CONCURRENCY` 的明确语义。新增恢复容量参数若实现需要，应在 CLI 文档列出有效范围；非法取值报配置错误。默认 C/B 在 V02 测量冻结；候选值属于验收输入，不属于业务决策。若机器预算不足，明确剩余积压和完成时间，不关闭恢复冒充修复。

## 6. E04：失败事实与流历史分离

采用**只读持久执行状态接口 + 原有流历史**。不往旧消息流补造 `session.failed`，不修改历史游标，不在 EOF 后追加事件。这样已关闭而缺少终态业务消息的流也能正确展示失败。

### 6.1 状态接口合同（E04a 已实现，待运行验收）

`GET /eve/v1/session/:sessionId/status`：

```ts
type SessionExecutionStatus = {
  sessionId: string;
  executionStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
  finishedAt: string | null;
  errorCode: string | null;
};
```

- 读取 world.runs 的持久状态；failed 的 finishedAt 来自持久 completedAt，不使用查询时间。
- running 包含等待输入，不映射成“模型正在生成”。状态是执行事实，不替代已有 session.completed 等业务事件的正常语义。
- 确认记录不存在返回 404；存储故障返回服务错误，不转换成 404、成功或终态。响应不包含原始序列化异常、输入、凭据或堆栈。
- 通过 eve Channel/Session/ExecutionRuntime 正常分层公开，客户端增加对应只读方法。使用与流读取同等的 session 授权，不允许任意 runId 查询。
- 原有完成/取消业务语义不被本次批量改写。本次失败收敛专门处理主会话 `failed`；关联任务取消仍保留其原始 cancelled 状态。
- GET 无清理副作用。当前 `createSessionStreamResponse` 的全错误转 404 不得复制到新接口。

### 6.2 Workflow 外的失败收敛

增加 eve 自有终态收敛函数，生产 World 安装和 dev 父 World 共用。在 `run_failed` 已成功持久化、存储锁已释放之后调用；旧失败记录由 E05 调用同一函数。不要增加一条必须成功重放才能执行的清理 Step。

2026-10-29 补充决策 A：源码 `runtime/runs.js: cancelRun` 只持久化取消事件；turn 的 AbortSignal 由私有取消 Hook 消费触发。在线不得把 cancelled 当作写入者退出确认。

E04b 实现：持久 `run_failed` 成功返回、存储锁释放后，后台收集失败 session，按批次共用一次 Run 关联扫描。主会话保持 failed，读取步骤中已完成的超时/turn 启动结果及 `$eve.parent`、超时和任务输入中的精确 command token，使用原生反序列化，不输出 token。在线只取消确认归属的计时运行；存在未结束的本地 turn/子会话、主会话未完成步骤、未知关联或清理错误时，报告未完成并保留流。无上述未决项时才关闭已登记的未关闭流。停写后的 E05 使用同一函数取消精确关联的活动本地运行并完成 EOF。已 completed 的子运行不取消、不改结果。

清理结果的 `scope` 固定为 `local-workflow`，不证明远程执行器已退出。远程 task 标记为 unresolved，不自动取消或释放其引用；旧式远程委派的停机/引用由对应远程执行合同另行确认。本工具不启动远程模型、认证或工具执行。

超时关联优先使用 `startSessionTimeoutStep` 已完成记录的真实输出；离线批次可分页读取超时 workflow 输入、按 command token 建临时索引，用框架反序列化接口解码。不得对每个父会话重复全量扫描、直接 eval 或把 token 输出到报告。

主会话失败不自动证明独立子 Run 已停止。需检查持久 turn/child 执行关联并收敛其等待者；使用框架已支持的取消/通知合同，不能只清除 Agent 引用掩盖仍运行的子执行。取消 Run 不代表撤销已经发生的外部工具副作用。现场 B 的数据操作在旧服务停止后执行，避免旧进程继续向关闭的流写入。

用 `streams.list/getInfo/close` 及原生 EOF 格式完成关闭，不新增数据库、关闭 sidecar 或 owner 代次。失败状态持久化与清理不是同一事务：清理失败必须保留原始 failed 事实并报告失败项，支持 E05 重跑；不能把清理失败触发的异常冒充 Run 从未失败。

在线状态读取和 Agent 15 秒心跳查询作为失败通知依据，不依赖 EOF 一定先到。`returnValue` 在观察到 failed 后按原生规则拒绝；本方案不重写其轮询 API。

## 7. E05：存量 B 处理工具

已实现 `eve repair-replay inspect --data-dir <目录> --output <报告>` 与 `eve repair-replay apply --data-dir <目录> --manifest <inspect报告> --writers-stopped --output <报告>`，具体使用见 CLI 文档。已完成静态审查；构建、运行和幂等性验收仍待 V01/V02。`--writers-stopped` 是操作人员确认，不是进程检测器。

1. 在隔离副本读取 failed 的主会话，使用框架异常解码确认本次 `.2/.3` Step 身份分歧；单凭 CORRUPTED_EVENT_LOG 不足以纳入。
2. 输出白名单清单：Run/sessionId、失败时间/错误码、来源版本、配套 Run ID、各流是否关闭、当前处理结果。不得输出用户消息和密钥。
3. apply 只处理清单中的目标，再确认归属及状态；复用 E04 清理，绝不将 failed 改回 running。
4. 已终态子 Run 不重复取消，已有 EOF 不重复写。每项输出已处理/无需处理/失败，存在失败项返回非零；第二次运行只处理未完成部分。
5. 工具保留原失败事件、消息、步骤结果、会话 ID、归档状态；新增的 EOF/取消事件是清理事实，不是伪造执行成功。
6. 输出给 Agent 的清单只有 Agent 所需的会话 ID、失败时间、错误码及清理结果。Agent 自行按租户与会话关联查找业务行，不接受工具提供的跨租户任意 SQL。

工具直接构造关闭自动恢复的 World 存储入口，不启动 agent 服务、队列执行 handler、模型或工具。inspect 零写入；apply 的写入范围仅为确认对象的 EOF、关联取消事实及原生取消清理。不能导入会自动执行 world.start 恢复的生产 bootstrap 来读取数据。

正式运行前停写并备份当前 Agent 数据库和 eve 数据目录。禁止用升级前备份覆盖当前业务数据来实施 B；备份仅用于故障回滚。

## 8. A01—A03：Agent 适配

详细接口及逐文件交付见 [Agent 与 Apps 接入交付](baigong-040-replay-agent-apps-handoff.md)。不直接使用 Workflow 私有磁盘格式，不靠 npm overrides 替代修复包。

### 8.1 状态和鉴权

- `src/server/eve/request-scope.ts` 增加精确 STATUS 路径；现有 eve-stream token 仅允许读取同一 session 的 stream/status，不扩大到写入及其他 session。
- `EveGateway` 增加 getSessionExecutionStatus；使用现有 signal，查询错误原样分类，不把连接失败、401、404 当成 failed。
- 快照首次读取、续聊/补充输入/取消的非活动确认，以及存量/后台维护使用该状态。failed 为权威失败事实；正常 active 路径沿用原有流尾和受理协议。
- `recordObservedTermination/settleInactiveSession` 复用 FAILED/持久失败时间；对真实 failed 不排 reset 重试任务。若数据库已有相反终态，报告冲突，不静默改写。

### 8.2 事件投影与在线等待

- 快照先固定并完整读取原有历史前缀，再应用持久失败终态。将未完成 Turn/回答标为失败，保留已完成轮次与消息正文；清 activeTurnId、pendingInput，canSend=false。
- 提取独立的投影终结函数，复用 session.failed 的归约逻辑；不伪造 IndexedEveEvent，不增加 cursor，不把本次查询时间写成原事件时间。管理执行历史保持原始记录，不给合成终态伪造 execution cursor。
- checkpoint.restore 已检查 terminalOutcome/terminatedAt，复用此机制；状态更新后刷新读取 context。分页快照失效后重新获取首页，不混用旧分页票据与新终态。
- 已打开的事件流在现有 15 秒 heartbeat 时读取一次执行状态，同一连接不重叠查询。确认 failed 后取消自己拥有的 eve reader 并结束输出；不为每个 Run 新建常驻计时器。断连和终态后停止状态查询。
- 单次状态查询受现有请求 signal/查询预算约束；未查到状态时不输出失败，不自动重发业务请求。在线等待期间的存储错误仍是可观察错误。
- 新开流如果快照已终态，完成原有固定前缀同步后结束，不再 follow。没有新增消息也不能合成 `cursor+1` 的 conversation.events。

### 8.3 引用与未绑定 Turn

- 复用 `releaseRuntimeReferenceInTransaction` 释放引用、临时快照和 Turn.runtimeReferenceToken；保留 conversationTurns 行、queryId、eveTurnId 及历史关系。
- 现有 reconciliation 只看“业务终态 + 流尾终态 + ROOT_TURN”，扩展为先确认持久失败，再检查对应配套执行状态并释放；SPECIALIST_DELEGATION 按自身/父执行关联处理，不全量删除。
- 不使用 `deleteUnsentTurn` 清理本次缺少 eveTurnId 的记录：该函数会删 Turn 及附件资源，本次没有证据证明这些请求从未执行。
- 对缺少 eveTurnId 的记录保留空值，不虚构执行 ID。原 request-recovery 在引用释放后依据已关联 session 返回 ACCEPTED；本方案保留“已受理”与“执行成功”的区别，不改成 NOT_FOUND 或触发重新发送。
- 释放前确认身份和关联，不凭 13 条引用的数量推断活动模型数。存量数据中的未处理关联单列，不能标记全部完成。
- 存量批次不删除用户记忆内容、上传附件、历史消息和业务日志。运行引用关联的临时记忆快照按现有生命周期释放，和用户持久记忆明确区分。

## 9. W01：Apps 必要的小范围改动

不新增协议版本、不新增终态事件类型、不让 Apps 直连 eve。BFF 继续代理既有 snapshot/events，并保持租户/院校/用户授权和严格协议校验。

- 按 Apps 仓库要求先建立 OpenSpec proposal/specs/design/tasks，确认后实施。
- `NativeAgent.tsx` 的消息流正常 EOF 分支：若当前投影仍非终态，对同一 conversation、同一 generation/scope 发起一次现有 snapshot 请求。刷新使用原有 AbortSignal；切换会话/身份后丢弃旧响应。
- 新快照确认 terminalOutcome=FAILED 时整体替换状态，清 acceptedTurnId、busy、取消等待和待答问题，停止 follow；显示“会话已结束，历史记录保留，请新建会话继续”。不清除用户历史，不自动发送草稿。
- 刷新仍非终态则保留现有断流提示及手动重连；不无限重连、不将网络 EOF 标为成功。401/权限撤销继续原有清空受保护内容的处理。
- 已终态快照可以直接展示历史，不需要反复开一条马上 EOF 的流。已存在的历史分页、调用链、知识来源、用量与专业 agent 链接继续可读。
- BFF `nativeAgentBridge.ts` 无业务修改计划；Apps Native 协议无需放宽终态校验。现有解析器应直接接受修复后的 Agent 响应。

## 10. 最终验收与业务不回退

实现阶段不反复运行全套测试。V01/V02 统一执行，保留每项源码 SHA、正式包 SHA256、命令、机器规格、退出码和结果，不把静态审查或 health=200 当作通过。

| 验收项                    | 明确通过条件                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| 真实 `.2/.3` 活动会话升级 | 可续聊；历史已完成 Step 不重复执行；未知 ID/correlationId 仍拒绝                                        |
| 单纯发布号变化            | 同合同不同发布号可重放；人为不兼容合同被拒绝                                                            |
| 本次 failed B             | 原 Run 保持 failed；清理重复运行无重复 EOF/取消；历史可读；无新模型/工具执行                            |
| 历史无 session.failed     | status 查询确认为 failed；Agent 快照与 Apps 页面终态一致，包含 EOF 已存在的历史                         |
| 投影                      | 已完成轮次不变；未完成 Turn/回答明确失败；无 activeTurnId/pendingInput；不伪造 cursor                   |
| 请求与引用                | 有/无 eveTurnId 均保留事实；未确认受理不自动重发；ROOT/SPECIALIST 引用按身份释放，临时快照不泄漏        |
| 在线失败                  | 已连接页面在下一次 15 秒心跳状态查询完成后进入收敛；查询耗时单列，不能承诺总耗时严格 15 秒              |
| 574 规模                  | 至少 287 主会话+287 超时 Run，混合空闲/执行/父子；统计 active/ready/delayed、成功失败数、恢复耗时       |
| 调度                      | active≤C、recovery-ready≤B；普通队列另计；长 sleep 不占派发槽；新请求可推进；父子不死锁；close 后不补发 |
| 资源                      | 隔离进程采样 CPU、RSS、I/O 和定时器/等待量；重复启动无持续累积；默认容量由实测与部署预算冻结            |
| `.3` 回归                 | EOF/非 EOF 取消、跨进程持久 EOF、迟到 reader、错误不跳块、Hook 冲突及索引行为不回退                     |
| 现有业务                  | 创建/续聊/补充输入/取消/专业 agent/附件/知识模式/历史分页/受理恢复/院校隔离保持正确                     |
| Apps                      | 初始终态、在线无业务终态消息、正常断流、切换会话、权限撤销、请求超时均分别覆盖                          |

使用标准 tier 配置运行 eve 测试；compiled 修改先重建。复用现有 stream/hook 场景、workflow-builders 测试、Agent gateway/reconciliation/projection 测试、Apps NativeStreamRevalidation/NativeAgentSnapshot 等。新增测试只覆盖本次合同缺口，不为数量重复同一断言。

Apps 功能实施及发布遵循其 OpenSpec 和覆盖率要求，不能把未跑的门禁写为通过。Agent 最终 Nitro 制品也要核验内嵌修复代码；本地 tgz 测试不替代三方联调。

## 11. 发布、切换与回退

1. 完成功能、审查提交和统一验收后更新版本、CHANGELOG、changeset，发布新不可变修复版本；不覆写 `.3`。版本号在版本提交时确认，记录真实 SHA，不预填提交哈希。
2. 交付 tgz URL/SHA256、完整步骤合同清单、状态 API、配置参数、E05 工具及 Agent/Apps 交付回执。
3. 生产执行前备份当前 PG+eve 数据，停止旧工作进程/写入。先执行 E05 inspect 审核清单，再 apply；Agent 用同一清单收敛业务数据，保留未处理项。
4. 切换 Agent 新制品及 Apps 修复版，启动有界恢复。旧 failed 不重放；新请求与兼容的 active Run 正常执行。核对清理结果与用户页面后开放业务。
5. 在新包尚未写入稳定 Step ID 之前，代码回退也需核对已做的数据维护；写入稳定 ID 后不能把旧 `.2/.3` 直接接到新数据。完整回退使用匹配的当前切换前 PG+eve 快照，并明确切换后新增数据处置。
6. 不在本轮自动执行 180/145 的部署、重启或数据处理。生产资源阈值和上线观察另行取证。

## 12. 方案自检

2026-10-29 E01 实施：合同清单位于 `packages/eve/src/internal/workflow/step-contracts.json`，逐项记录源路径、函数名、稳定 ID 和两条精确历史 ID。核对清单中源文件与 `.2` tag、`.3` 源码提交相同。构建转换在三种模式共用合同，步骤代理专用路径也使用同一 ID；内嵌 core 补丁统一 registerStepFunction/getStepFunction/useStep，并在保留 correlationId 检查的前提下比较已声明兼容的历史身份。未放开未知版本或第三方步骤。测试已准备，按计划尚未执行；真实包跨版本重放、传递依赖和最终构建仍由 V01 验收。

- [x] Q1=A/Q2=B 写入，未把 B 偷换成删除旧会话或回滚旧数据。
- [x] 兼容覆盖执行注册/重放比较/反序列化，不只处理 createSessionStep。
- [x] 调度覆盖启动互等、父子执行、延迟占槽和关闭；active/ready/delayed 明确区分。
- [x] 底层 failed、持久 EOF、业务 session.failed 不再混为同一事实。
- [x] Agent Turn 无 outcome 列、引用释放会删除临时快照、checkpoint 已有失效机制均按源码反映。
- [x] Apps EOF 后不刷新快照的问题纳入修改；不新增伪造游标。
- [x] 明确状态接口为拟新增，Agent 鉴权也必须同步修改。
- [x] 备份、生产统计、资源阈值、真实包升级和联调均未冒充已验证。
- [ ] E01 合同白名单逐项实现审查、C/B 实测定值、正式 CLI/API 编译及运行验收：执行阶段完成。

输入：[Agent 交付报告](../../baigong/baigong-agent/2026-10-28-Eve跨版本重放与启动恢复交付.md)。本方案取代该报告的“已 failed 数据恢复”候选项，明确采用 B；此前 [.3 流生命周期交付](baigong-040-agent-handoff.md)仍是回归依据，不代表此次跨版本修复已完成。

2026-10-29 统一验收进行中：构建、81 项定向测试、38 项真实存储场景测试及机械规则检查通过；扩展 channel/schedule 合同新增版本并保留历史支持。真实 `.2/.3` 包生成的步骤历史均已由当前 compiled core 成功恢复，已完成步骤调用数为 0，恢复后步骤调用数为 1。574 运行调度测量选定默认 C=16、B=C；该测量使用 5ms 模拟 handler，不代表模型、工具或生产资源负载。详细记录见 [统一验收记录](./baigong-040-replay-validation-20261029.md)。最终 tgz 和三方业务验收尚未完成。
