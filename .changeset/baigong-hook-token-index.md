---
"eve": patch
---

本地 World 在启动时补齐历史 hook 的 token claim，缺失 token 的在线查询改用现有索引，避免反复扫描全部历史 hook。索引准备失败或存在不同 owner 的 claim 冲突时阻止启动就绪，保留原有数据格式与事件恢复路径。
