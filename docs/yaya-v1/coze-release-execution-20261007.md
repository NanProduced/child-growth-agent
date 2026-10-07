# 已授权发布执行记录（2026-10-07）

用户明确允许当前共用应用库备份/增量升级，并指定首位管理员 `admin`。不改写旧业务数据、不复用旧口令、密码只在受保护本地文件交付。发布与线上合成测试已授权；新模型总额度 20，旧耗尽账本不重置。

## 数据库已完成

- 目标身份 `fb9bdaade52916a4`，来自本项目 prod 自定义 DATABASE_URL，不是平台默认 exec_sql(product) 的另一份库。
- 原应用数据：children 7、observations 6、classes 3、child_class_enrollments 8。
- PostgreSQL 17.5。原生 pg_dump 使用导出快照；完整 public dump 在内存中 AES-256-GCM 加密，密钥/备份目录 ACL 仅当前用户与 SYSTEM，均 gitignored。
- 备份恢复到本轮独立本地 PostgreSQL，全部旧行/字段 SHA256 一致；所用迁移连续两次，旧数据不变、新表 14 个。
- 最终执行 run `release-0cd3dab1`：锁应用四表、锁内复核备份前提→增量 DDL→旧列数据摘要复核→COMMIT。没有执行 initialize-demo/upgrade-classes 的种子/回填；旧 snapshot/evidence 保持 NULL。
- 首位管理员通过现有非公网 bootstrap 生成。凭证在 `logs/release/release-0cd3dab1/admin-credentials.json`；不在聊天、源码、参数或日志打印密码。已存在管理员则绝不覆盖。
- 平台 `health_check` 表只读且有独立心跳更新：前两次锁/摘要校验失败全部回滚。修正为只锁/修改本应用四表，不提升权限、不修改监控表；最终旧业务数据一致。
- 所有本轮 dump/restore 容器含匿名卷按 ID/标签清理核实，保留加密备份和恢复验证证据。

可执行入口：`pnpm exec tsx scripts/yaya/release-database.ts` 默认只备份/恢复/干跑；生产变更须显式 `--apply`。本库已升级，禁止以旧基线脚本盲目重跑 apply。

## 平台传输实证与代码适配

本地/沙箱 SDK 0.7.32 bundle SHA256 均为 `9f9f01d57464c0dd52daea110e0eabe52ffb7e935259a8b9fe61d02761a5de3b`。DEV 缺新 PAT 模式 COZE_API_TOKEN，但注入旧 workload；不导出/伪造 token，不删除 .coze，不访问 SDK 私有 getClient。

- 原 SDK 新 ensure/metadata 通道在 DEV 失败，不证明全部内置集成不可用。
- 已有 S3 代理的 workload `x-storage-token` 协议真实可用，精确 key、GET、metadata、精确删除可用；所有探针自有 key 已清。
- 代理忽略 `IfNoneMatch`（实测异内容覆盖），HEAD ContentLength=0，不用 HEAD 假校验。
- 适配使用自身标准 S3Client + 已核 SDK 的 workload 协议，保留媒体端口。平台键 `.../<variant>/<SHA256>`：输入字节必须匹配 key，已有对象 GET 验证摘要；同 key 异内容在 I/O 前拒绝，写后 GET 核字节，权限/网络错误不变成不存在。新元数据存精确 key，无签名 URL。
- 内容地址保证**逻辑不可变/幂等**，并发相同字节可能重复底层 PUT；不宣称代理物理 exactly-once。通用 S3/local 原语义不改。这个边界必须保留在交付/验收说明，不能声称 IfNoneMatch 已生效。
- 第12/13/14次模型探针：200但非法/空流，不计成功；均计请求。
- 第15次使用旧官方 SDK 的头组合（不混入新 PAT 的 X-Coze-* 三头）取得真实 Pro 回答、finish=stop、usage 347。这是文本传输证明，不是图像/页面闭环。
- 代码显式兼容 flag `YAYA_PLATFORM_AUTH=workload` 只取本平台注入身份；native project/env 身份先验证，HTTPS endpoint 固定 integration.coze.cn，不借 CLI/PAT、不修改环境里的 token。
- 文本/图片 provider 可显式分配；图片不静默借 StepFun。Coze 返回 JSON/SSE 都核验，HTML/不完整/矛盾流拒绝，重试0、取消/超时保留。
- 运行日期锚点取原 run 的服务端 created_at（Asia/Shanghai），不改用户原文；转发 SDK trace 白名单且剔除浏览器 x-run-mode。

## 本地代码验证

`check-platform-runtime` 29/29（真实 AWS 序列化+内存代理，忠实忽略条件写）；原 strict 6 schema/LLM 7；core 68、API 57、chat-bind 22；媒体 28/25、integration-media-db 88、Agent engine29、真实 Next HTTP 主链路61；validate/Next build/tsup。均无额外真实模型。最终发布前需按最终字节重跑构建与必要链路。

## 版本与同步纪律

- 待发布代码在 codex/yaya-final-wiring，基于已验证 4159bea；历史保留，不 squash/force。
- 平台私有 main 7f54266 的独有 .coze `[env]` 含 DATABASE_URL/TEACHER_PASSCODE 实值，禁止把这些私有历史推送 GitHub；仅安全移除当前树的 env 纯凭证段、不改历史。原 asset 33,204 B 保留。
- GitHub只推本地已核无凭证的发布提交；不操作本地 main 未跟踪资产。
- 平台 fetch/sync 后核源文件 blob与所选平台 commit，固定部署目标，不默认发布旧 7f54266，不把任意平台 merge 当已测版本。

## 尚未完成（当前 checkpoint）

生产 AUTH Origin/媒体/模型配置、代码同步、固定提交发布、公开 HTTPS 浏览器和合成业务链路仍待执行。当前线上仍旧版本；管理员表已初始化但旧接口不能以新账号登录。模型预算已预登记15/20，余5；任何线上模型尝试和重试继续编号，不重置。真实图片推理尚未通过，不能从文本或 HTTP200 外推。
