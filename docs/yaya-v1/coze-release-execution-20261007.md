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

## 正式部署与线上合成验证（完成于 2026-10-08）

- GitHub main / 发布源 `260c6f6e1cafdee5cbf1f43c7c350ddc5fa50b9e`；不改本地受保护 main、不 force/squash。平台私有旧历史没有推往 GitHub；恢复 ref 保留，源码普通 merge，无冲突。平台 merge/包裹身份不是源 Git SHA，最终发布页面明确选中原源提交。
- 部署记录 `7693953170015518758`：Succeeded，commitHash 与源完整 SHA 相同。正式域名 `https://childgrowth.coze.site` 与 `https://snjs3ctb76.coze.site`。单实例 1 CPU/2GB，未同步开发库表/种子。
- 生产普通变量已配置 AUTH_TRUSTED_ORIGINS（两正式 HTTPS 源）、AUTH_COOKIE_SECURE、AUTH_SCHOOL_ID、YAYA_PLATFORM_AUTH、文本 StepFun/图片 Coze、豆包 Mini、s3 和每 run 2 次模型尝试上限。COZE 系统身份/桶变量由平台提供，不手填、不导出运行时凭证。旧口令值没有重新启用授权。
- 最终平台传输纯检查 35/35；engine29、API57、原 LLM7、validate、Next+tsup 构建通过。源提交的构建已完成，随后新增的线上验收脚本不改运行时。

### 实际通过

1. HTTPS 登录 API + 真实 Chrome 管理员/教师登录；Cookie HttpOnly/Secure/SameSite；匿名读取401、管理员教学写403、教师只看本轮独立班级/幼儿。
2. 真实 multipart 上传合成红蓝 PNG，同幂等身份重传；扣子代理的 original/thumbnail/model 三对象均可授权读回；DB 为 ready+media/prod 内容地址；其他账号不能读取。
3. 真实 Coze `doubao-seed-2-0-mini-260215` 一次模型调用，8636 input/40 output，正确答“左红右蓝”，合法 NDJSON answered。不是本地对象模式或模型替身。
4. 真实 StepFun `step-5-preview` 一次调用，7218 input/1610 output，生成 create_observation 提案；未批准时业务观察0。真实 Chrome 按原 run 恢复原提案→完整对象/日期/原文核对→明确批准→真实 operations HTTP 回执 committed；DB 恰好一条 draft，raw_text 与**浏览器批准的卡片**逐字一致。没有声称 draft 已整理/已归档。
5. Chrome 1440/1024/390 实际页面无横向溢出，输入框可见且高度≥44；截图位于受保护、gitignored 的 release-0cd3dab1 目录。不是 fixture 浏览器证据。
6. 所有原 children7/observations6/classes3/enrollments8 的原列逐字节摘要与备份一致。新增合成数据按独立 ID 登记，没有回填旧证据。

入口 `scripts/yaya/check-release-live.ts`（必须显式 stage；不会自动调用模型）。累计断言含重复登录/旧数据核对，不能当独立场景总数。模型新增实际2次；账本保守预登记4个槽位（16–19），其中17/19没有派发。此前15次全部计入，旧40不变；本轮不再加测。使用最多2次/run限制，避免隐藏规划重试越过总授权。

### 发现与限制（不改预期冒充全通过）

- P1：看图回答当场正常，重新打开会话显示“历史消息当前不可读”。已定位 runtime/terminal-message 的 image dependency 被计 unmapped，安全降 unknown；图片来源尚不能通过冻结的 child/class/observation 来源模型无损映射。不得用 independently_readable=true 或默认 bound 绕过。原 run 查询仍可核验，待来源/历史 owner 返修。
- P2：1440 桌面侧栏展开时浮动芽芽入口仍显示，遮挡输入区/发送区；手机已单独隐藏。批准后上方旧“尚不能证明保存”摘要未同步，下面新回执已显示已保存。待 UI 共享状态/入口展示修复。
- 文本抽取检查：初始严格 raw 检查 FAIL，提案多带一个句号。实际测试消息拼接本身有双句号（原文末句号+指令分隔句号），不能把该输入歧义定性为模型必然改写。未把失败改成 PASS；另行由真实教师核对卡选择采用提案文本，再验证**已批准文本→DB**一致。正式使用仍须逐字核对，不能自动放行。
- NOT_RUN：真实 provider 的整理→追问→正式确认归档整链、复杂多人/全部工具质量、真实幼儿图片、软键盘真机/Safari/屏幕阅读器、代理长连接边界、多实例限流/生产安全认证。线上 smoke 通过不等于全业务/全模型质量/全安全验收。
- 合成班级/幼儿/一条 draft、聊天及三对象保留供复核，精确身份在 live-smoke.json；测试教师已停用、全部会话撤销。不是“零测试数据残留”。不存在临时本地服务器/容器；备份、凭证与截图受保护且不提交。

本轮完成固定源版本上线与已列线上验证。后续优先关闭图片历史投影与桌面入口遮挡，再扩大真实模型业务验收；不得退回已退役的旧口令版本。
