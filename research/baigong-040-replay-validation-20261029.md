---
issue: local/2026-10-28-eve-replay-startup-handoff
status: in-progress
last_updated: !!str 2026-10-29
---

# eve 跨版本重放修复统一验收

功能验收提交 `96606a25`，此前 E05 提交为 `7ff2cf5c`。版本已准备为 `0.40.0-baigong.4`，正式包隔离验收已完成，发布状态以 Release 为准。验证环境为 WSL2 Linux 6.18.40.1、Node 24.21.0，28 个逻辑 CPU、15818 MiB 内存。Agent/Apps 源码与生产数据未修改。

## 进度

- [x] E01—E05 已实现并签名提交。
- [x] 首轮正式构建；修复合同 JSON 的路径别名导入与事件包装器重载类型后通过。
- [x] 首轮定向单元测试：7 文件、81 项通过。
- [x] 真实 Local World 场景测试：4 文件、38 项通过。
- [x] 完整 TypeScript 检查、定向 lint 及机械规则检查通过。
- [x] 文档检查：81 篇、358 个代码块内 269 条导入通过。
- [x] 真实 `.2/.3` 构建的持久步骤历史在当前 compiled core 上恢复成功。
- [x] 574 个运行、两次启动、三组并发的独立调度测量。
- [x] 最后一批修正的构建、类型及 lint 复核。
- [x] 子代理取消测试补齐 sandbox 替身后，整组 9 项通过；与主 Workflow 的 21 项合计 30 项集成测试通过。
- [x] 最终 `.4` tgz 隔离安装、CLI、跨版本复核。
- [ ] 签名版本提交、标签及 GitHub Release 发布。
- [ ] Agent/Apps 接入及生产业务验收，由配套交付文档负责。

## 实际存储与回归

执行命令需预先完成 `pnpm --filter eve build`：

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts \
  step-contracts.test.ts local-queue-scheduler.test.ts repair-replay.test.ts \
  compiled-artifacts.test.ts configure-nitro-routes.test.ts \
  eve-session-routes.test.ts workflow-runtime.test.ts
pnpm --filter eve exec vitest run --config vitest.scenario.config.ts \
  failed-session-cleanup.scenario.test.ts stream-lifecycle.scenario.test.ts \
  hook-lifecycle.scenario.test.ts workflow-stream-recovery.scenario.test.ts
pnpm --filter eve exec vitest run --config vitest.integration.config.ts \
  workflow-entry.integration.test.ts turn-cancellation.integration.test.ts
```

场景测试使用原生事件 API 创建失败会话、turn、timer 和消息流，再使用原生序列化写入错误。确认 inspect 前后整个存储目录的内容摘要相同；在线清理取消 timer、保留活动 turn 和主流；停写后 apply 取消关联运行并写 EOF；再次 apply 不改存储；主运行保持 failed。既有流取消、重连、跨进程轮询和 Hook 生命周期回归通过。

集成测试首轮 28 项通过、2 项失败。两项失败均在共享 sandbox 初始化处报告 microsandbox VM runtime 未安装，分别是活动子代理取消与子代理 HITL 取消。补齐替身后的整组 9 项取消测试退出码为 0；初次复跑期间 compiled 重建造成模块加载错误，该次结果不计为通过。构建结束后独立复跑无加载错误。针对这两项测试使用已有 `mockSandbox`，通过测试 manifest/module map 注入 sandbox backend；不更改生产 sandbox 行为，也不将替身测试计为真实 VM 验收。

扩展合同 channel 从 5 增至 6、schedule 从 3 增至 4。变更为 eve 提供的 Session 新增状态查询；旧扩展使用的既有方法和事件保持不变。保留旧 epoch 与其不可变元数据，新增旧版 authoring fixture 和当前报告；机械规则检查通过。

## 跨版本持久重放

脚本：`scripts/baigong/replay-compatibility-probe.mjs`。record 与 replay 使用独立 Node 进程和同一临时存储，未修改已落盘事件。

```sh
node scripts/baigong/replay-compatibility-probe.mjs record \
  /absolute/old-package/dist/src/compiled /tmp/eve-replay-data 0.40.0-baigong.2
node scripts/baigong/replay-compatibility-probe.mjs replay \
  /absolute/new-package/dist/src/compiled /tmp/eve-replay-data 0.40.0-baigong.2
```

另用独立目录对 `.3` 执行相同流程。record 由真实旧构建 core/world 执行带旧版本身份的 `createSessionStep`，保存结果后停在 Hook；replay 使用当前稳定身份，恢复 Hook 后执行 `dispatchTurnStep`。两个版本均得到：record 首步骤调用 1 次；replay 首步骤调用 0 次、后续步骤调用 1 次；保留历史输出并最终 completed。这验证真实 core 的步骤重放和恢复，不等同于完整 Agent 多轮业务验收。正式 `.4` 包已在隔离安装后重复该检查，两个版本均通过。

## 恢复调度测量

脚本：`scripts/baigong/recovery-scale-probe.mjs`。真实 compiled Local World 持久创建 574 个运行：287 个主会话、287 个 timer。注册直接 handler，模拟 5ms 派发后返回一小时等待；同时插入一个普通请求。两次恢复使用同一存储，检查每次 574 个不同运行全部派发且无重复；关闭后活跃 handler 为 0。测量在外部脚本进行，生产运行路径未增加计时。

| C / B   | 两次恢复耗时 ms | 普通请求派发 ms | 关闭 ms | CPU ms    | RSS MiB   | 恢复最大并行 |
| ------- | --------------- | --------------- | ------- | --------- | --------- | ------------ |
| 8 / 8   | 1050 / 978      | 86 / 7          | 48 / 42 | 657 / 460 | 105 / 119 | 4            |
| 16 / 16 | 653 / 556       | 83 / 7          | 52 / 42 | 581 / 373 | 106 / 120 | 8            |
| 32 / 32 | 456 / 346       | 79 / 6          | 45 / 38 | 573 / 347 | 118 / 120 | 16           |

变更默认值并重新构建后，不设置这两个环境变量的探针也通过：两次各恢复 574 项，最大恢复并发 8；总耗时 674/569ms，普通请求 94/7ms，关闭 54/37ms。

选定默认 C=16、B=C，使恢复同时派发最多 8 项，同时保留普通请求容量；管理员仍可配置。该选择是有界调度的发布默认值，不宣称生产吞吐最优。5ms handler 不执行 LLM、工具或完整历史重放；RSS 是当前进程读数，不是生产容量估算。系统资源统计本次 fsRead/fsWrite 为 0，不能据此宣称没有磁盘读取。

```sh
WORKFLOW_LOCAL_QUEUE_CONCURRENCY=16 WORKFLOW_LOCAL_RECOVERY_BUFFER=16 \
  node scripts/baigong/recovery-scale-probe.mjs /absolute/eve/compiled
```

## 未覆盖边界

尚未完成正式版本签名提交与发布、真实 VM、Agent/Apps 接入及生产资源对照。测试通过不代表这些外部验收完成，生产数据修复与切换仍需另行授权。

## 正式 tgz 隔离验收

制品 `.output/baigong-0.40.0-baigong.4/eve-0.40.0-baigong.4.tgz`，SHA256 `ef731869aaa370b326f1dd29039ba92b3726383249150f18f54f6edf4a63ba84`。3,335 个 dist 文件与构建逐文件相同；npm 隔离安装使用 `--ignore-scripts --no-audit --no-fund`，3,439 个安装文件与 tgz 逐文件相同。CLI 输出 `.4`。

随附 `verify-installed.mjs` 验证 20 次流取消后无轮询遗留、reader 解锁及持久块顺序/EOF。`verify-repair-cli.mjs` 从安装包调用实际 CLI，验证 status/inspect 零写入，apply 未确认停写时拒绝执行，确认后取消关联 turn、关闭流、保留 failed 状态且可幂等重跑。两项脚本、`.2/.3` 独立进程重放和默认 C/B=16 的 574 运行探针全部退出 0。

正式包两次恢复各 574 项，最大并行 8；耗时 649/549ms，普通请求 78/7ms，关闭 47/43ms。该结果仍仅代表模拟 handler 的调度成本。
