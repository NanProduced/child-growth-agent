# PLATFORM-FLOW-CHECK1 交付候选

日期：2026-10-08。状态：业务修复与限定本地检查完成，等待父代理评审；不宣称全平台生产通过。真实模型/搜索/S3/托管库预算与实际请求均为 0。

## 来源、权限和提交历史

- 唯一写入树：`D:/CodexWorktrees/platform-business-check/child-growth-agent`，分支 `codex/platform-business-check`。初始 HEAD/status 核验为完整 `f371ba3b2a39af6aaa660566ed5435bd316c05a7`、干净树。
- 第一修复 checkpoint：`0c112daec6f4e6cdef0abc11c611e2f910b7e2dc`。
- 用户追加授权后正常 `--no-ff` merge 产品组合 `d1b441a6a2fc5c7913d128260a1a014ce182aeb3` → `9900542ec6838229183ff8227fd152aec7f9af78`，无冲突。
- 独占 client 目录移交后，回执修复 checkpoint：`84964f763b7b002a269c5d687dd8e1b01eb276cc`。
- 正常 `--no-ff` merge 完整共同基线 `ccf5998c20a4e8de6671f3938ec86a14f3ed545e` → `7bce5585ce572324c5e20996d649823c35fe76ce`，无冲突。已完整读 `docs/platform-review/base-delivery.md`。此后仅补本交付文档与专属脚本的过期 NOT_RUN 提示。
- main、其他工作树、源 yui-v2 均未修改；无 reset、push、deploy、线上迁移或历史 5020 服务操作。未审前不进入下一阶段。
- 本树 AGENTS/PRODUCT 已完整读取；AUTH/Guide/Yaya/HTTP/CHAT-BIND/媒体冻结契约及已交付必要章节已读取并与当前代码核对。RTK.md 不存在，只记录。历史文档中“公开 GET/旧口令/未接线/随机重传”等声明不是当前实现事实。
- 核心 wire/types、storage-types、schema/migrations、package/lock、harness 均未因本任务修改；冻结文件相对完整共同基线 diff 为空，harness blob 始终为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。

## 六项根因、反例和修复

| 发现 | RED（修复前先运行） | 最小共享修复与 GREEN |
| --- | --- | --- |
| 1. 回收后重传的失败请求删掉并发成功对象 | `platform-flow-media.ts`：第一请求在 model 对象 put 前暂停，第二请求用同一确定性回退身份提交 ready；第一请求失败后原图/缩略图丢失。seed `qaseed1-muzk0v5e-09d89fcb`，cleanup verified | 所有上传身份都已确定性化，删除过时“随机兜底补偿”分支；真实 PG + 本地对象 checksum、原身份重试、正常租约回收均通过。部分未登记对象保留可恢复，不能凭单请求 put 结果宣称独占删除权 |
| 2. 建档/转班只检查日期外形 | `platform-flow-guards.ts` 初轮：`2022-02-30` 出生日期、`2026-02-30` 转班日期均 500，数据库拒绝才回滚 | 两个既有共享 schema 复用 `parseIsoDateStrict`，返回 400；儿童数、分班历史完整不变。观察/写工具已有的合法日历规则保持 |
| 3. 上传/字节读取只在对象 I/O 前核身份 | 初轮：对象 put 时真实撤原会话，上传仍 200 并落元数据；对象 get 时撤会话仍返回 200 字节 | 上传登记使用原请求头、既有 `withPrivateWrite` 和同 client 绑定 DATA 元数据端口；对象 I/O 在事务外；读取返回前以当前身份、任教、归属重投影。身份异常不转为 upload_unknown，不补偿删除。撤会话后 401、零元数据、无字节 |
| 4. 私有授权有效性在行锁等待前计算，保存后不重核 | 二次反例 RED 8/9：实测等待 app_sessions 行锁跨绝对期限，最终 401 但元数据已提交。seed `qaseed1-muzkkn4y-0425a375` | 复用既有 AUTH `demandSessionValid`，在取得会话锁后及原 callback 完成、COMMIT 前按数据库时钟重核；同事务回滚业务/批准/回执。最终 expiry 反例零元数据，TOOLS 原断言与 APP 跨期断言保留 |
| 5. 图片一经提案引用便无法读 | 真实 prepared proposal 建立图片引用后，合法当前教师读取 403；MEDIA loader 仍只支持 observation，把 proposal 当“尚未接入” | 抽取 DATA 原有 per-image proposal-source 投影供 DATA/MEDIA 共用，先筛该图片关联项，再按当前业务来源取合法投影。元数据和字节路径均覆盖；合法提案图片 200，撤任教后 403，owner/uploader 不构成绕过 |
| 6. 客户端原操作恢复只核身份，不核成功证明 | `platform-flow-client.ts` RED 6/10：unknown effect、空业务 ID、详情不可读但无效果证明、outer saved 与 failed receipt 矛盾，均仍返回 saved 类结果 | 删除本地重复身份比较，复用冻结 `queryOperationOutcome`；预期身份来自原准备计划，检查请求 operation 与预期一致，坏证明归 unknown。合法 saved、unchanged、后续详情不可读保留，GREEN 10/10；不增加任何 POST |

第 1—5 项用真实 PG/真实业务实现证明；第 6 项是客户端纯信任边界反例，不冒充实库事务或浏览器证明。所有原检查断言保留；没有降低内容/来源/角色/批准守门，也没有改变预期来掩盖这些 RED。

## 完整业务覆盖矩阵

| 业务链路 | 当前实现核验与证据 | 限制/层级 |
| --- | --- | --- |
| 账号登录、状态、CSRF、GET 不续期、退出 | AUTH core 28；HTTP 主线登录三角色，匿名/跨会话 CSRF 拒绝；APP 原运行查询不续期 | 真实 Next/AUTH/隔离 PG；不含生产安全认证 |
| 停用、重置、撤会话、任教与转班权限 | AUTH 实库受控交错；business-access 113；TOOLS 134/R1–R4；账号/会话/资源锁后重核与零写入 | 真实双连接，不用内存/SQL 替身证明事务 |
| 建成长档案 → 观察原文 | 主线 HTTP 46：正式建档与首次分班、教师创建 draft、管理员教学拒绝、raw_text 对照；日期 RED/GREEN | 原文预期来自输入，不从回执反建；原文只在首次创建时保存 |
| 必要补问 → 整理草稿 | 实际 organize/follow-up HTTP，经 local StepFun 协议返回 ask→proceed→draft；原文不变、未归档；原保存快照检查保留 | 模型协议替身，证明编排，不证明判断质量 |
| 教师修改 → accept/clarify → 最终确认 | HTTP 真实 clarify→教师补充→accept→再次明确确认；模型审核 accept 本身仍不正式归档 | 真实 AUTH/HTTP/PG；审核内容为协议替身 |
| 指南关联与归档同事务 | 缺来源决定 400，观察/关联全回滚；合法归档与手动关联一起提交；已归档不重整理/归档；140 规则检查覆盖全部必需依据、版本、跨期、成人帮助与未知 | 回滚/提交为实库 HTTP；140 规则检查为离线纯逻辑，分开记录 |
| 个人来源 → 班级同期统计/下钻 | HTTP 证据册逐来源，选中条目正式 confirmed_observed；custom range 同期儿童状态一致，total 等于原 roster 分母；123 纯写流程/参数规则 | API 数据与参数证明；本轮不宣称页面点击/排版浏览器验收 |
| 成长小结/活动支持 | HTTP 主线实际生成/保存，绑定已确认 observation IDs；活动引用逐字核对；管理员拒绝；原 TOOLS 依据变化与保存回滚检查 | 本地协议模型；效果/真实模型质量 NOT_RUN |
| 自然语言 → 当前权限查询/来源投影 | APP 182、联合 HTTP 70；实际 READ1、完整依赖累计、撤权/历史降级、一般问答允许空任教；失效/503 禁继续模型 | real Next dev/start + PG；model double，真实 provider 0 |
| 页引用 → 原输入分片 → run 依赖 | 新基线独立 HTTP：授权页引用、外 URL/越班/匿名拒绝，原输入逐字不变、引用单独保存和当前投影进 run；42 纯 schema/browser bundle | 不抓 DOM/远程 URL，不将选文升级成正式依据；无 page-reference 产品改动 |
| 写提案 → 可信 HITL → 执行/回执 | 联合 HTTP 查询→准备→可信批准→create/organize/confirm；TOOLS 134 + R1 b/R2 c/R3 l/R4，消费、业务、回执同 client，故障原子回滚 | 真实业务调用；批次逐项、不自动重发整批 |
| unknown → 只查原身份 → 取消/恢复/跨账号 | APP 182 跨进程/失联/取消；TOOLS 原回执查询与 owner；client 10/原56 核原计划，历史回读不自建身份/批准；其他账号和管理员不能读他人聊天 | 不将缺回执当未保存，不把旧成功因详情不可读改成失败；本轮未新增重发流程 |
| 附件上传/幂等/归档追加/租约回收 | guard 13、media 并发反例、integration-media 88、HTTP 实际 multipart/内容代理/归档追加；引用锁与删除 lease 两序交错、完整引用、精确 key、审计 CAS 回滚 | real sharp + real local file objects + PG；S3/对象桶 NOT_RUN |

未实现的活动实施反馈、学期快照、家长分享、报告导出/打印等只列产品缺口；本任务没有新增这些功能或架构。

## 执行结果与重跑边界

| 检查 | 本轮实跑结果 |
| --- | --- |
| `platform-flow-guards.ts` | 最终 13/13，实库/handler/AUTH + I/O 撤权/锁等待/提案图片 |
| `platform-flow-media.ts` | RED→GREEN，真实 PG 元数据 + 并发 local objects，seed 62/62 |
| `platform-flow-client.ts` | RED 6/10 → GREEN 10/10，纯客户端边界 |
| `platform-flow-http.ts` | 合入聊天产品后最终 46/46，8 次本地协议模型响应，provider 0，cleanup verified |
| `check-auth-core.ts` | 28/28，真实 Next HTTP/PG/受控竞态；账号体系没有因后续同步变化 |
| `check-business-access.ts` | 113/113，真实 handler/PG/受控锁交错；不是 Next server |
| `yaya/check-tools-write-db.ts` | 最终 134/134，原断言；真实 AUTH/PG/业务写/回执 |
| TOOLS R1 `b` / R2 `c` / R3 `l` / R4 `all` | 最终 53/53 / 9/9 / 13/13 / 37/37；按共享私有保存边界风险选择，不无限重跑全部分组 |
| `yaya/check-integration-media-db.ts` | 88/88，最终源同步后再次通过；run `int-media-muzla8m8-e42d4e0e` |
| `yaya/check-agent-app1.ts` | 最新产品 + 本任务修复 182/182；run `agent-app1-muzl07k0-3e95f2cf`；真实 Next dev/PG/本地图片、跨进程受控交错 |
| `yaya/check-final-wiring.ts`（dev） | 70/70，run `final-wire-ebe02a9a`，本地协议模型 13 次/provider 0，cleanup verified |
| 同检查（production next start） | 完整共同基线 + 本任务修复，70/70，run `final-wire-6624b452`，本地协议模型 13 次/provider 0；完整页面不含明文 HttpOnly 会话 token，cleanup verified |
| `check-guide-write-flow` / `check-save-consistency` / `check-guide-evidence-runtime` | 123/123 / 24/24 / 140/140；离线规则/语句/helper/模拟，不能充实实库证明 |
| `yaya/check-ui1-client` / `check-chatbox-v2` / `check-chat-bind` | 56/56 / 42/42 / 22/22；纯逻辑/真实 browser-target bundle；不是浏览器点击 |
| TypeScript / repo eslint / CSS stylelint | `pnpm ts-check` / `pnpm lint:build` / `pnpm lint:style` exit 0 |
| Next / server bundle | Next `build --webpack` 和仓库原 tsup 参数 exit 0；不重新联网安装依赖 |
| `git diff --check` | 通过；精确 staging；生成 next-env/类型已恢复 |

两轮共同基线普通 merge 无产品冲突；最终完整 tip 仅增加交接文档/可见实例验收脚本，未无意义重跑所有不受影响业务。

**明确保留的未绿检查：** `check-media-r1.ts` 为 24/25，B5 仍要求回收后的确定性身份走“随机身份补偿”并返回 compensation_unknown；该旧预期会要求恢复已实证的数据丢失路径。原脚本/原断言没有改、没有将它标绿，交父代理裁定更新测试口径。清理为 removed。

`check-guide-evidence-db.ts` 的旧 passcode/cga_teacher 授权已过时，NOT_RUN；没有把它硬修成假通过。旧 close-joint runner 的 ai_draft 注入不证明编排，本轮改用专属真实 HTTP+模型协议替身主线，同时保留原 guide/save 检查。

## 精确文件清单（相对 ccf5998c）

业务实现 11 个：

- `src/lib/accounts/access.ts`：公开复用原会话时钟重核 helper。
- `src/lib/yaya/data/private-auth.ts`：锁后及 COMMIT 前同 client 检查。
- `src/lib/yaya/data/access-facts.ts`：原 per-image proposal 授权提取复用，语义不 fork。
- `src/lib/media/upload-service.ts`：删除不安全补偿、保留 AUTH 错误语义。
- `src/lib/media/content-service.ts`：逐引用 loader 传原 attachment identity。
- `src/lib/media/record-access.ts`：消费 DATA proposal 投影及事务绑定归属锁。
- `src/lib/validation.ts`：两条日期共享边界修复。
- `src/app/api/yaya/uploads/route.ts`：对象 I/O 后原身份登记保护及幂等回读后重核。
- `src/app/api/yaya/uploads/[id]/route.ts`：同事务当前身份/来源元数据读取。
- `src/app/api/yaya/uploads/[id]/content/route.ts`：对象 get 后当前身份/来源重核。
- `src/components/yaya/client/actions.ts`：原计划/成功证明共用冻结判定。

专属验收 4 个：`scripts/platform-flow-media.ts`、`scripts/platform-flow-guards.ts`、`scripts/platform-flow-http.ts`、`scripts/platform-flow-client.ts`。
专属文档 2 个：`docs/platform-review/flow-checkpoint.md`（保留阶段历史）与本文件。

其他组件/pages/CSS/public/DESIGN 未由本任务编辑；没有待移交的已证实组件 handler 修复。父代理提供的 UI 呈现与可见实例兼容来自基线 merge，不能算本任务修改。

## 清理证明、限制与 NOT_RUN

- 所有启动前已审查安全路径；使用锁定依赖独立 `pnpm install --offline --frozen-lockfile --ignore-scripts`，未用跨盘 junction。
- 每个 PG 均由本轮 harness/acceptance 创建并登记；连接前容器 ID/运行标签/loopback/current_database/current_user/空库核验。无外部 DB URL、生产连接或线上 DDL。
- 各原套件结束均通过其不可变 harness 精确清理闸门；已登记容器按 ID+标签删除并复查，Next 按 PID+创建身份与树归属终止，没有按名字/端口杀其他进程。
- 专属/回归输出中的 15 个精确 `yaya.qa-seed1=<seed_id>` 标签最后再查均无容器残留；输出过的 14 个精确对象根目录最后再查全部不存在。例：最终 HTTP seed `qaseed1-muzla4yp-6d72772c`，容器 `a41acf3483809bcd57577bf06e1f691d1da11e17e58abf8332b8f9e8ca649c89`、PID 3608、port 50601、创建时间 `2026-10-08T13:45:47.3111980Z` 均属该轮，已清理。
- seed 自有临时凭证目录由登记 teardown 删除并核验；没有读取 `.env` 或他方凭证。复用 final-wiring 只在程序内读取该轮随机合成账号 seed 文件，未打印/提交内容，随 seed 清理；专属 HTTP runner 直接为自有合成 DB 设置随机口令，不读文件。
- `final-wire-ebe02a9a` 与 `final-wire-6624b452` 两个精确自有 server.log 已删除并核验不存在，防止保留开发诊断中的合成 session 信息；仅合成诊断数据，不可恢复。旧日志/其他资源不动。
- Next build 通过不可变生成物快照恢复：next-env 恢复、仅本轮新建类型文件删除，issues=[]。构建结果 `.next`/dist 为本树可复用生成物，不是运行中的服务。
- 开发联合响应曾 `session_token_present:true`（Next dev 调试 Flight；未当作生产认证证据）；最终生产 start 明确为 false。正式生产 HTML 不序列化 session 的检查已独立跑过。
- 已保留的部分上传对象存在可恢复上限：未知或失败请求无法证明独占所有权，不添加无依据清理器/前缀删除；本轮测试根最终整体按登记身份回收。
- 真实模型质量、多模态模型能力、真实搜索、S3/Coze 对象桶、托管库、生产迁移/部署/安全认证，全部 NOT_RUN。旧 20/50 模型账本没有读取、复用或重置。
- 本业务代理本轮真实浏览器点击、截图、1440/1024/390 布局、真机/Safari/屏幕阅读器 NOT_RUN；父代理交接的 Chrome 24 与 evidence 113 是基线证据，不能替代本轮独立业务/事务检查，也没有冒充本轮浏览器验收。

候选交父代理统一评审，保留 B5 测试口径漂移与产品缺口；没有后续阶段、部署或主线整合动作。
