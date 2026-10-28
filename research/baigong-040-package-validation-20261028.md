---
issue: "baigongapps 报告 180；eve 修复包交付验证"
status: in-progress
last_updated: "2026-10-28"
---

# eve 0.40.0-baigong.3 制品交付验证

## 制品

- 源码提交：94d83626bc993e3cbdf63a66dc76b1da4a1d00fb。
- 版本：0.40.0-baigong.3。
- 本地交付目录：`.output/baigong-0.40.0-baigong.3/`（Git 忽略目录，需单独复制交付）。
- 文件：`eve-0.40.0-baigong.3.tgz`。
- SHA256：`36ef3fd7fcbde8dcd741c23ba5424170810592d6b8e9d2b23f6637f08503d896`。
- 配套文件：SHA256SUMS、manifest.json、verify-installed.mjs。
- 已沿用 .2 的 GitHub Release 附件分发方式发布（不是 npm registry 发布）：[https://github.com/Procyon-Nan/eve/releases/tag/eve-v0.40.0-baigong.3](https://github.com/Procyon-Nan/eve/releases/tag/eve-v0.40.0-baigong.3)。
- 下载地址：[https://github.com/Procyon-Nan/eve/releases/download/eve-v0.40.0-baigong.3/eve-0.40.0-baigong.3.tgz](https://github.com/Procyon-Nan/eve/releases/download/eve-v0.40.0-baigong.3/eve-0.40.0-baigong.3.tgz)。
- 签名标签 eve-v0.40.0-baigong.3 指向上述源码提交，签名验证通过；Release 不是 draft/prerelease，已设为 latest。

发布后已从 GitHub Release 下载 tgz 到独立文件重新计算 SHA256，与上述值完全一致。远端标签对象为 `b1d41b26351dd995ae038f1d64b43fd5cace4dc0`，解引用提交为 `94d83626bc993e3cbdf63a66dc76b1da4a1d00fb`。

## 构建来源

版本内容暂存时完成完整 `pnpm --filter eve build`，随后用户提交相同源码为 94d83626；打包前确认工作区源码没有变更，仅保留原有 pnpm-lock.yaml 元数据变更及 .codegraph-wsl 目录。CLI 版本输出为 0.40.0-baigong.3。

使用 pnpm_config_verify_deps_before_run=false 避免脚本执行前自动安装依赖；没有修改依赖声明或锁文件。补齐标准 prepack 的 LICENSE/NOTICE 复制后，沿用仓库 scenario 打包方式，以 ignore-scripts=true 复用已构建内容，避免重复清空重建 dist。

## 隔离验证

安装目录：`/tmp/eve-baigong3-install-or0xWm`。执行 npm install 本地 tgz，使用 --ignore-scripts --no-audit --no-fund，依赖来自 npm registry。ignore-scripts 表示未运行依赖安装生命周期脚本，不代替 Agent 正式 npm ci/build。

结果：

- npm 隔离安装成功，新增 35 个依赖包，耗时约 4 分钟。
- 安装后 CLI 输出 0.40.0-baigong.3。
- tgz 内 9,430 个 dist 文件与构建输出逐文件 SHA256 一致；安装后的 9,534 个包文件与 tgz 内容逐文件 SHA256 一致。
- verify-installed.mjs 从安装目录加载实际 compiled World 和内部 runtime，连续取消 20 个非 EOF Workflow 流后，计时器为 0，所有源 reader 均已解锁；持久 first/second 两块顺序及 EOF 验证通过。
- 此脚本仅验证包级冒烟行为，不替代此前回归矩阵和 Agent/Apps 验收。保留脚本及临时安装目录以便复查。

复现命令（仓库根目录执行）：

```bash
node .output/baigong-0.40.0-baigong.3/verify-installed.mjs /tmp/eve-baigong3-install-or0xWm
```

交付目录同时保存验证结果 JSON 和本报告副本。文档及制品清单静态审查通过；git diff --check 通过。

## 交付边界

本记录只覆盖 eve 包级验证。Agent A01/A02、依赖与契约版本升级、Nitro 完整制品、Apps 业务矩阵和 30 分钟观察仍待完成；已按用户指示发布 GitHub Release，未执行 Agent/Apps 部署。接入步骤见 [Agent 交付文件](baigong-040-agent-handoff.md)。
