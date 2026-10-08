# 全平台并行检查共同基线

日期：2026-10-08。用户确认先固化并整合聊天 v2，再同步 UI/typeset 与业务两线。此为本地检查候选，不是全平台验收、生产批准或部署。

## 来源与历史

- 原证据页候选：`f371ba3b2a39af6aaa660566ed5435bd316c05a7`。
- 聊天精确快照：`b6f20e6b1f1a55ece0fb7569f0efc4c02ff91d25`，父提交 `41d4a3f20889edac83cfe1697dd5125261b62f22`；源 `C:\Users\nanpr\AppData\Local\Temp\yui-v2` 保持未提交工作原样，逐文件哈希记录在 `chatbox-v2-freeze-manifest.json`。
- 保留两来源历史的合并：`d1b441a6a2fc5c7913d128260a1a014ce182aeb3`；两来源均为祖先，未改 main。只有 `design-qa.md` 追加内容冲突，保留了双方完整局部历史，未整文件任选 ours/theirs。
- 不纳入 `.env`、凭证/运行日志、输出/依赖缓存、被否决的个人 V2/V3 设计。`local-ui-preview.md` 是源阶段历史运行资料，原 5020 服务和“余量49次”不是当前事实，不自动重启或重置旧额度。

## 此组合重新执行的检查

- `pnpm validate` 全通过；Next 正式包 + tsup 通过。
- 页引用纯检查 42/42、消息组件静态 render 15/15、来源纯检查 34/34。冻结快照本身另实跑客户端 56/56；不将静态数字冒充浏览器结果。
- 聊天联合 `final-wire-67837b04`：70/70，真实 Next production HTTP + AUTH/CSRF + 一次性 PostgreSQL + toolkit/权威消息，模型协议替身 18 次、真实模型 0 次；Chrome 24 组（1440/1024/390），errors=[]，cleanup verified。
- 证据页组合 `evidence-pages-73936b13`：113/113，保留原103并增加10项“恰好一个可见页面”断言；五视口、真实 AUTH/HTTP/隔离 DB，指定故障和2项长 token 排版替身分层标注，真实模型 0、cleanup verified。
- 组合后旧验收定位曾命中框架保留的隐藏页面，strict locator 失败；只将专属 runner 改为 `:visible` 并明确断言可见实例唯一，没有 `nth()`/force click 或删掉原业务断言，没有为该定位问题改产品逻辑。
- 生成 `next-env.d.ts` 还原；harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 不变。package/lock、AUTH、G0/Yaya 核心 wire、schema/迁移未改。

## 两线 owner

- UI/typeset：非 API 页面、组件呈现、CSS/布局/字形与必要交互易用性；维持已批准世界。**不改 `src/components/yaya/client/**`、lib/API/DB 或业务状态/批准语义**。
- 业务：`src/lib/**`、`src/app/api/**` 的现有业务实现，另独占 `src/components/yaya/client/**` 的协议/身份/执行逻辑；组件/page中的业务 handler 跨界先报主代理。冻结契约/DDL需变更时提交差异方案，不私改。
- 各自独立工作树/端口/资源，已有修改先精确 checkpoint，再正常合入共同新基线，禁止 reset/覆盖源树。问题、修复、证明、NOT_RUN 分开交付。

真实 provider/搜索/Coze 对象桶/托管库/生产迁移/部署/真机/Safari/人工屏幕阅读器均 NOT_RUN。两个子代理继续独立评审和修复，不把本基线检查当作“所有业务均正确”。不 push、不部署、不清理他方资源。
