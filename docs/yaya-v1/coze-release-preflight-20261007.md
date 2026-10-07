# 扣子发布前只读核验（2026-10-07）

用户已要求核实内置集成机制并尽快部署最新版本、线上测试。本轮已取得发布意图；尚未执行生产迁移、账号创建、环境变更、push/pull 或部署。

## 内置集成结论

- 官方说明内置 LLM/存储无需用户提供 API Key；COZE_ 系统变量由平台管理，不允许在自定义变量界面自行建立。
- SDK 0.7.32 的 Config/LLMClient/S3Storage 在服务端附加平台鉴权和项目身份头。“用户不用管理 Key”不等于匿名内部 API；不能移除鉴权、复制内部 token 或把 CLI 登录 token 填入业务模型调用。
- 开发沙箱 shell 与应用进程的注入不同，需在真实预览/部署运行时核对。用户无须从界面寻找 Key。
- 现有标准 S3 适配器尚未按扣子平台代理鉴权装配。官方 uploadFile 随机改变 key，也不能直接替代现有确定性 putOnce/回执恢复语义。

官方来源（本轮读取）：

- https://docs.coze.cn/guides_internal_integrations
- https://docs.coze.cn/guides_environment_variables
- https://docs.coze.cn/guides_integrate_storage
- https://docs.coze.cn/guides_deploy_vibe_web

## 固定版本与线上事实

- 待发布代码候选：4159bea579fcb53ac4f01ec5f5fb7d3deff144b2，分支 codex/yaya-final-wiring；本地既有 main/其他来源树未改。
- GitHub origin/main：633488c9370b63851f8603ec78b685b4d88c5d09，是候选祖先（差 134 提交），无强推需求。
- 扣子项目：7690843235199139866；绑定仓库 NanProduced/child-growth-agent。
- 当前成功线上部署：history 7692048622074249225 / commit 633488c937；域名 https://childgrowth.coze.site 与 https://snjs3ctb76.coze.site。
- 平台浏览器发布下拉所见开发版本为 7f54266260（只读调查记录），不等于本地候选；不能默认发布它。平台独有变更须在同步前核对，不整文件覆盖、不 ours/theirs 自动择边。
- 线上 /api/auth/status HTTP 200 返回旧 configured/isTeacher，不是 AUTH v1。

## 生产配置/数据库（严格只读）

从本项目 prod 环境获取连接配置，仅传递给只读探针；连接串、密码与正文不输出、不落入文档。探针使用 REPEATABLE READ / READ ONLY / statement_timeout，最后 ROLLBACK。

- 生产自定义变量仍为旧口令、StepFun 与 DATABASE_URL。无 AUTH_TRUSTED_ORIGINS、无媒体装配变量；LLM_PROVIDER=stepfun。
- dev/prod 的自定义 DATABASE_URL 相同。官方内置资源隔离不能替这个用户自定义连接提供隔离；任何迁移会同时影响两个环境。
- 数据库目标身份指纹 fb9bdaade52916a4（仅 host+database SHA256 截断，不是凭证）。
- public 表：children、observations、classes、child_class_enrollments、health_check。没有 app_accounts/app_sessions/teacher_class_assignments 或 yaya_*。
- 数量：7 幼儿、6 观察、3 班级。未读取幼儿姓名/观察正文，不假定全是可丢弃演示数据。
- 数据库 metadata CLI 在当前空间列出 0 个库，无法据此确认本自定义目标的 PITR/备份恢复窗口；备份可恢复性 UNKNOWN。
- 首位管理员尚无对应账号表，未创建、未复用旧口令。

## 当前门禁与下一步

直接部署候选会导致新版身份服务 503 和聊天表缺失，不是可用发布。不得以部署成功/HTTP 200 冒充闭环。

发布前必须完成并核验：

1. 明确共用库升级还是独立验收环境；在任何修改前落实可恢复备份。
2. 基于现有生产形状验证增量升级清单，不执行含种子的 initialize-demo，不临时手选未测结构段；保持旧原文/确认稿/关系与历史 NULL 语义。
3. 配置真实 https Origin、Secure Cookie，安全初始化首位管理员（已有管理员不得覆盖）；不使用旧口令代替新版账号。
4. 完成平台模型/存储传输适配与开发预览联测，保留写入确认、原身份回执和精确对象清理。
5. 内容核验后同步代码，固定平台 commit-id 再发布；不自动同步开发种子、账号、聊天、照片。
6. 线上验收仅用登记的合成资源，清理按精确 ID；模型共享新账本已使用 11/20，余 9，不重置旧 40 次账本。

已向本项目扣子编程 agent 下发只读发布核验（session 346541113685762），已返回；不授权其自动发布或改库。

### 平台核验回报与交叉核对

- 平台 HEAD 7f5426626010109102ad501c7e3d62ef51ca268c，origin/main 633488c；领先 15 个未推送提交，status clean。累计树差异仅 .coze 与 assets/image_20260929174626425.png；不整文件覆盖 .coze（其 env 段需逐项脱敏核对），保留图片。
- 平台报告开发预览进程 pid311 中 COZE_API_TOKEN 缺失、workload identity 存在；Config.validate 失败。不能从此推出生产注入同样缺失，也不能把“变量存在”称为存储真实可用。SDK 构造/源码与真实调用分开。
- **数据库对象存在冲突**：平台官方 exec_sql(product) 回报 children=6、observations=3、classes=0；本项目自定义 prod DATABASE_URL 则是 7/6/3。表名相同不是数据库身份一致的证明，不能在默认平台库迁移就认为应用库已升级。
- 进一步通过线上 API 只统计响应数组数量：/api/children=7、/api/classes=3，均 HTTP 200；以及当前线上代码优先 DATABASE_URL 再 PGDATABASE_URL，证明发布升级必须针对当前应用的自定义连接目标，而不是上述默认平台资源。未输出任何姓名/正文。
- 对当前共用自定义库的备份窗口仍 UNKNOWN，尚未执行任何结构迁移。

本轮事实：未发起部署、未修改生产库/变量、未调用应用 LLM/对象读写；当前线上版本保持不变。
