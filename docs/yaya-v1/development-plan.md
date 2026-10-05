# 芽芽正式开发计划（yaya-v1.0）

2026-10-05。前置已收口，进入实现，不再排独立全量 CONTRACT/TECH/DESIGN 返修轮。
共同开发 SHA 由整合交付报告给出；不得从 main 或三线旧 tip 开工。
规范以 contract-v1.md、src/lib/yaya/types.ts 为准。物理实现细节由唯一 owner 决定，字段扩展要报告，不 fork 核心口径。

## 1. 波次与依赖

| 波次 | 任务 | 可立即做的真实实现 | 依赖 |
|---|---|---|---|
| 1 并行 | DATA1 | 迁移、私有存储、投影、批准/回执、原子替代、账号私有 API、隔离库验收 | 冻结核心 |
| 1 并行 | MEDIA1 | S3/本地测试存储适配、图片处理、授权媒体/引用/回收服务、可注入元数据接口 | 冻结核心；元数据DDL归DATA1，不等其在制代码 |
| 1 并行 | AGENT1-CORE | 模型扩展、幼教 Prompt、有界动作引擎、图片输入/上下文/取消与恢复、可注入工具/存储端口 | 冻结核心，不等实际业务tool；正式装配第二波 |
| 1 并行 | VISUAL1 | 修正后的 A 默认桌面/390、C 批量工作区和小芽出图，提交用户选稿 | 不写产品UI；推荐不是已批准视觉 |
| 2 | TOOLS1 | 全现有平台动作注册、schema/候选/读结果、共享事务执行+回执、密码安全窗口衔接 | 合入已通过DATA1/MEDIA1/AGENT1-CORE |
| 2 | UI1 | assistant-ui sidebar/workspace/history、消息/审批/结果/附件卡、移动端、正式入口 | 用户选稿 + 第二波共同基线；可与TOOLS1并行 |
| 3 | INTEGRATE1 / QA1 | 表单/Review/档案图片接入、真实账号HTTP+隔离库+浏览器联合流、受控交错 | 第二波来源完整SHA；再单列真实provider与发布 |

第一波是实现代码，不是再写可行性报告。组件/库的依赖注入用于接真服务和有限测试，不允许用永久 mock 路由、TODO 返回成功、伪执行卡宣布闭环。
TOOLS1/UI1具体prompt在第一波整合后以新共同SHA发布，本轮不给缺前置的任务抢跑。

## 2. 独占文件与发布接口

| Owner | 唯一修改范围 | 交付给其他模块 |
|---|---|---|
| DATA1 | src/lib/yaya/data/**；src/lib/yaya/storage-types.ts；src/storage/database/shared/schema.ts（仅新增yaya表）；scripts/upgrade-yaya-v1.sql；账号私有 conversations/messages/proposals/approval/operations GET routes；scripts/yaya/check-data*.ts；自有交付文档 | 存储DTO/repository导出、同一TransactionClient的批准消费/回执/替代入口、附件元数据/引用接口、迁移与错误语义 |
| MEDIA1 | src/lib/media/**；上传/内容读取/附件关联 routes；scripts/yaya/check-media*.ts；自有交付文档 | AttachmentMetadataPort（先可注入，后接DATA1）、私有对象标识/处理/内容代理、引用/删除租约服务、资料追加适配 |
| AGENT1-CORE | src/lib/yaya/agent/**；src/lib/llm.ts（此文件唯一owner）；scripts/yaya/check-agent*.ts；自有交付文档 | YayaModelGateway、YayaAgentDependencies、动作/事件 schema、有限循环/取消/上下文投影；不改data/media/既有业务routes |
| VISUAL1 | docs/design/yaya-v1/outputs/** 与出图台账（必要时只修出图prompt） | 候选图+sidecar，明确用户是否已选；不改产品/全局token |
| TOOLS1（第二波） | src/lib/yaya/tools/**；operations POST；仅必要既有业务routes/queries/pg-client兼容修改 | 全平台tool表与可执行适配；所有旧保存入口回归；不改AUTH/G0冻结规则 |
| UI1（第二波） | src/components/yaya/**；助手页面/入口；package.json/pnpm-lock.yaml（此波唯一依赖owner） | adapters与桌面/平板/手机UI；不做业务统计/授权/假批准 |

第一波任何人不得改共享types.ts、AUTH/G0、harness、其他owner源码、package/lock、生产配置。
确需跨owner改动时提交接口差异说明，由本整合负责人在下一共同基线处理；不要等待未提交文件或复制它们。

## 3. DATA1必达边界

- 账号私有会话/消息/私人准备草稿；client_message_id 与版本前提；当前来源投影，包括标题和模型上下文；GET无模型无副作用。
- prepare预分配身份；一次批准可绑定选中的多个operation；原会话、快照、版本、资源、附件逐项核验。
- 实现原子替代：锁旧操作、判尚未执行、supersede旧批准/执行、发布新身份。与原执行双连接交错时不能双写。
- 执行储存端口使用已有 TransactionClient；callback与receipt在同一client，不另开提交。DATA1可用隔离库业务callback证明rollback，实际业务tool接入留TOOLS1。
- 不先创建 operations POST 假执行API；只实现可复用的真实事务原语。TOOLS1拥有该route。
- 附件元数据、消息/提案/观察引用的DDL统一在此；message删除不丢操作核验/业务引用。媒体需要删除租约/CAS状态阻止查询后新引用。
- 私有写复用resolveRequestAuth、evaluateSameOrigin、csrfMatches与现有错误映射；业务写继续现有runBusinessWrite。禁止虚构AUTH动作或缓存Principal。

## 4. MEDIA1必达边界

- 首版文字+图片。初始限额：每次最多8张、单图10MiB；JPEG/PNG/WebP；由服务器验魔数、解码限制与尺寸、压缩、移除EXIF，错误保留其他图与文字。
- 默认客户端限额不是权限依据。unsupported格式明确说明，不以空图片成功；不得用远程任意URL下载绕过上传检查。
- 开发/生产资源身份分离；前缀仅命名。测试只用自有一次性本地存储/替身，真实桶另获授权。
- 上传私有但关联遵守业务权限；字节/缩略图经授权代理，短TTL签名不进聊天/日志/DB；对象只写一次并核对checksum。
- 创建观察的附图关联随业务事务提交；归档后只追加资料附件、单独审计与人工批准，不改原文/确认稿、不自动点亮指南。
- attach_observation_images是本次新增能力，原平台尚无接口，coverage不得先标已实现；授权复用宿主幼儿的 observation.write/child，并核验观察归属与版本；管理员只读。
- 回收完整引用检查+deleting租约；S3等待不长持数据库事务。未知删除结果不得伪装为成功或恢复ready。

## 5. AGENT1-CORE必达边界

- 实现能运行的动作引擎与gateway，不只写Prompt。文本复用现invokeLlm/结构化校验；多模态/取消增量扩展同一llm.ts，保持已有6类输出回归。
- 依赖注入readTool/proposeWrite/loadProjectedContext/resolveCurrentIdentity等正式端口，不包含模型可调用的批准/任意SQL/HTTP。
- 每次await和派发前固定run_id/身份/前提重核，失败尝试计预算，模型调用事务外；普通问答不要求幼儿/原文。
- 不因供应商接口当前无原生tools退化成固定单步宏；数据驱动第二次读；write只提案。管理员教学、越权、未知target拒绝在服务端工具边界。
- provider不具备所需能力时给明确unsupported，不静默换provider；stream物理取消、vision、usage真实能力单列NOT_RUN。
- 公开检索默认关闭；开启时只用无私域标识的教育检索模板/服务器核验。扫描未知即不调用，不以模型自报“已脱敏”为证据。

## 6. 共通验收与资源纪律

独立codex/工作树从交付完整SHA开始。读AGENTS/contract-v1/本计划；RTK缺失仅记录；harness blob保持6702f2ddf3b436e79f8c92ae8756c33f611a8503。
pnpm管理依赖；不读.env，不动main/来源树，不reset其他分支，不push/部署。真实模型预算40/40，实际provider/搜索/S3/托管库请求禁止；测试I/O必须自有隔离目标并有出口守门。
隔离库先核数据库、标签、回环地址、空库；按ID+所有权标签清理；端口占用直接退出；进程树需创建身份，不按名称/端口杀。生成物精确恢复。
交付完整SHA、文件/导出签名/迁移、反例RED→GREEN、正常与异常/受控交错、资源清理、NOT_RUN；只精确提交自有文件。停止等整合，不自行部署或扩展下一阶段。

真实账号/HTTP/隔离库 ≠ 真实provider；jsdom ≠ 浏览器；图稿 ≠ UI实现；本地闭环 ≠ 生产发布。
