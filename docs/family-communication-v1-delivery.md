# 家园沟通 v1 — 本地开发候选

基线：`49f819e46bce5a98e880b7252448946c1f8cbc4c`。
工作树：`D:\CodexWorktrees\family-communication\child-growth-agent`。
分支：`codex/family-communication-v1`。未合并、未 push、未部署；尚未提交本轮改动。

## 首版能力

入口：更多 → 家园沟通；教师成长档案详情也可带当前幼儿进入。除档案入口传入 childId 外，须显式选择幼儿，不默认替教师选中第一人；同班同名选项显示出生日期。管理员查阅观察但不生成、修改或核对教师分享，私人草稿不向同班教师或管理员共享。

期间：月份、显式校历学期、近一年（过去12个月，不冒充学年）；未结束月份或学期截止服务端今天。按照观察发生日期筛选，最多选择60条、所选正文合计最多60000字符；不截断、不偷偷丢记录。没有已确认来源不调用模型。

生成、编辑、核对复制、刷新恢复独立草稿。模型正文与建议署名 `<教师显示名> · <班级名>` 一起持久化为完整可编辑文字；署名修改也随正文保存，复制只取核对保存已确认的完整 textarea 正文，不在复制时另拼隐藏署名。剪贴板失败会说明已保存/已核对但未复制，并聚焦、选中全文供手动复制；Windows 复制对照仅归一化 CRLF/LF。

生成不改原文、教师确认稿、成长小结或资料指纹；已核对不代表已发送。不生成照片、PDF或公开链接，无家长账号、无自动推送，也未注册新的芽芽工具。

复用 `invokeChatLlm`，StepFun使用应用自有strict JSON Schema；Coze用原有运行时鉴权与应用Zod守门。没有新增provider、状态库或依赖。模型最多两次调用，重试前再核身份与所选来源；同一请求登记先于模型，同键异内容409，同键已登记只读回，不重跑。

## API与存储

- `GET /api/family-communications?child_id=&kind=month&value=YYYY-MM`：当前范围内已确认观察与账号私有草稿。`kind=semester&value=<显式学期ID>` 或 `kind=year`。
- `GET /api/family-communications?client_request_id=<原UUID>`：owner与当前资源权限核验后读取原结果，绝不调用模型。
- `POST /api/family-communications`：`{client_request_id,child_id,period,observation_ids,note}`，只接受这些字段；不接受角色、批准、本文摘要、来源快照或自报正文。
- `PATCH /api/family-communications/[id]`：`{expected_revision,action:save|review,text}`。同版本竞争仅一成功；实际保存与当前身份、归属、已确认依据在短事务内复核。
- 新增单表 `family_communications`：账号owner+原请求唯一、内容摘要、明确日期、来源快照、归属前提、文字与版本。保存状态 generating/draft/reviewed/failed；来源变化的对外投影为stale且不返回正文。
- 生成失败只允许服务端已可信登记的执行上下文把同一ID+owner+request_digest的generating记录标为failed，不写模型正文或业务数据；已提交的草稿不被改成失败。DB不可核验时仍保持未知。
- 登记时由 DB `clock_timestamp()` 写入 5 分钟 `deadline_at`。执行先取得该草稿的行锁，再另查询 DB clock 算剩余时间；每次派发与生成结果保存使用同一截止守门，保存 SQL 也要求 `deadline_at>clock_timestamp()`。单次模型 signal 不超过剩余时间与 120 秒，最多两次调用不延长总截止。
- 原 pending 超时后，GET 只读返回 failed 投影，不 UPDATE 状态、不重派模型；迟到结果不可保存，也不能把它当作有效草稿编辑。该投影与可信失败执行的元数据写入是不同路径；没有把未知结果解释为成功。
- 教学权限复用已冻结 `growth_profile.write` 的当前教师/幼儿组合，但本模块不执行成长小结写入；没有改AUTH角色规则或增加审批框架。原班只读不等于整份档案或生成权限。
- 同伴姓名从所选观察发生班级及当前班级匹配，只用于服务端脱敏/输出守门，不作为模型或客户端新的名单读取。未知姓名仍需教师在复制前核对。
- 自动生成的事实/引文经有限结构与逐字引用守门；不宣称机器验证了全部自然语言推断或真实provider抗注入质量。教师核对仍必要。

## 必要迁移

已有库需在基础 children/app_accounts 表具备后执行 `scripts/upgrade-family-communication-v1.sql`。只新增/补齐本模块表、索引与约束，含 `ADD COLUMN IF NOT EXISTS deadline_at` 以补齐早期候选表；无种子或业务回填，不改写 observations、成长小结或资料指纹。主执行线程仅在自有隔离库执行，生产未执行；documenter 本轮只读 SQL。

生产升级、备份与发布仍需用户授权。当前交付仅为本地候选，不代表线上已有本功能；发布时须配套核对迁移。

## 当前实测证据

以下计数来自主执行线程最新实测交接；documenter 本轮只读组件/服务/契约/迁移、三份文档、浏览器结果与截图，未启动服务或复跑检查。纯检查与 DB 计数按主执行线程交接记录，不冒称 documenter 独立执行。

- 纯检查 37/37；日期/重复来源/伪造字段/诊断排名趋势用语/逐字引用/错来源与杜撰原话。
- 真实隔离 PG+真实 AUTH+真实 route handler 54/54；迁移幂等、owner隔离、角色/越权/CSRF、同键重放、同版本并发、确认来源失效、模型等待撤权/到期、同权限转班、历史同伴脱敏、完整文字持久化与零业务改写。截止超时、late 模型结果拒绝、过期 pending 只读恢复已覆盖；超时补测为 SQL fixture 与真实生成函数的 model-await 等待时序反例，含锁等待后重新取 DB clock；provider 仍为替身，不是实际 kill 进程验收。
- 最终真正 Next production HTTP+Chrome+隔离 PG 37/37；登录与显式选择、3/5选择、生成、完整正文/署名编辑保存刷新复制、剪贴板拒绝后选中全文、同班同名日期、四个宽度、44px目标、键盘与减少动态、折叠来源/顶部助手、失败不覆盖、丢响应只查原请求、可信空/503/管理员只读。本轮核对 `results.json`：`passed=37`、`errors=[]`、`provider=protocol_double`、`real_model_requests=0`；protocol double 不构成真实 provider 或模型质量验收。
- 主执行最终 `eslint . --quiet`、`tsc`、全范围 stylelint 均 exit 0；最终 Next 生产 webpack build 已通过，`next-env.d.ts` 已按原 tracked 内容恢复。该构建及恢复项为 COMPLETE（非主评审批准）；documenter 按主执行交接记录，未独立复跑。
- 独立终检 01a11e68 返回 SHIP，仅原四项 P2（完整复制署名、面板色偏、成功/失败提示混色、展开 ARIA）4/4 resolved。不再做 UI hunt；该裁定不认证整站、生产或真实 provider，不构成用户主评审部署授权。

主执行线程最终旧回归交接如下；全部已完成，documenter 未独立执行这些检查：

| 检查组 | 最新结果 |
| --- | --- |
| 原角色 | PASS 21/21 |
| auth-client | PASS 33/33 |
| auth 契约 | PASS 36/36 |
| guide | PASS 19/19 |
| source-save | PASS 24/24 |
| core | PASS 68/68 |
| business | PASS 113/113，cleanup verified |

最终页面 JSX 已移出数据读取的 try/catch；按主执行线程交接，布局与功能未变，最终静态检查已全部 exit 0。documenter 本轮未读该页面或复跑 lint，记录的是主执行结果。

截图/结果/网络路径及状态（无请求体、cookie、CSRF）：`output/playwright/family-communication/`（gitignore）。既有只读核对 `cleanup.json`：`cleanup_ok=true`、`issues=[]`；主执行交接确认 business cleanup verified，最终 `cga.family.check` 容器标签扫描无残留。documenter 未启动或清理资源；最终构建与 `next-env.d.ts` 原 tracked 内容恢复已由主执行完成。

主执行最终保留检查 COMPLETE：`git diff --check` 通过；package/lock、AUTH 核心、冻结 types/API/harness 和 next-env 的 diff=0；冻结 helper 仍为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。以上按主执行交接记录，documenter 未执行 Git 检查、扫描容器或读取受保护源码；不扩写为整站/生产验收或主评审批准。

## 模块局部设计收尾

用户已选第 2 图，属于既有世界中的普通新模块。方向图来源、SHA256、同状态对照与适配记录见 `docs/design/family-communication-v1/README.md`；准确局部 values 见 `.impeccable/surfaces/src-components-family-communication-workspace-tsx.md`。方向图是设计参考，含合成示例，不是功能或生产验收证据。

沿用既有 global token、中文字体、shadcn/ui 与 Lucide。白色事实/正文表面；编辑面板为 `color-mix(in srgb, var(--accent) 40%, var(--card))`。成功提示用绿色 `--accent`、Check、status；失败、未知与复制拒绝用中性 `--muted`、Info、alert。窄屏来源默认折叠、保留已选数；顶部助手与至少44px目标已有实测。展开来源及展开更多记录按钮均有 `aria-expanded`/`aria-controls`，不以此代替屏幕阅读器验收。

documenter 本轮仅通过 apply_patch 修改上述模块 brief、设计 README 与本交付文档；不刷新 root DESIGN.md、design.json、PRODUCT.md、design-qa.md。未改源码、依赖、AUTH规则或其他工作树，未读凭证、调模型、执行迁移、启动服务、提交、合并或部署。历史设计文档漂移不构成本轮刷新全站的授权。

主执行交接称 root `design-qa.md` 已追加严格新模块段并保留旧历史；该操作属于主线程，documenter 未读取或改动该文件。独立 SHIP 的范围仍仅本模块原四项 P2，不将旧历史或新增段解释为整站验收。

## 暴露的既有问题与有限修正

1. 登录脚本尚未就绪时，原表单默认GET曾让隔离临时账号口令出现在地址中。已加POST降级和挂载前禁用控件；不改变认证规则。相关临时账号/容器已回收，测试日志脱敏，未涉及生产口令。
2. 开发webpack的layout eval模块出现SyntaxError；模块字符串独立编译正常，尚未关闭该开发模式问题。本轮正式生产包浏览器验收无页面错误，不能据此宣称dev或原线上已有hydration问题已修。
3. 原浮动助手覆盖当前页面内容/复制按钮；仅新模块按平台证据页既有CSS模式将该入口锚定到顶部文档返回工具栏，其余路由未调整。

## Release gate：同步 POST 的生产等待风险

当前生成 POST 同步等待模型结果。平台代理最长等待/TTFB 与真实 provider 负载尚未联测，生产延迟风险保持 OPEN；5 分钟业务截止、120 秒单次模型 signal 或本地 Chrome 通过均不能证明代理链允许相同等待时长。

如果联测中实际触发平台 90s 闲断边界，需要另行优化为注册后返回 202 或流协议，当前未实现这些协议。现有原 ID 只读恢复可处理响应丢失，复核原登记结果且不重复调用模型；这只证明恢复路径，不表示同步等待的生产延迟风险已关闭。

发布前需由 main 补齐代理等待/TTFB 与真实 provider 负载的联合验证和发布裁定；若触发闲断边界，再在另行授权的实现范围内处理协议优化。本轮不启动联测、调真实模型或更改源码。

## NOT_RUN

真实StepFun/Coze质量、平台代理最长等待/TTFB 与真实 provider 负载联测、真实 kill 进程恢复、托管DB、生产迁移/部署、S3、真机键盘/Safari/屏幕阅读器、暗色浏览器验收；真实模型请求0，未读.env、未更改旧预算，不持有本轮真实模型授权。主执行静态、列明回归、最终生产构建与 next-env 恢复已完成；documenter 未运行静态/旧回归、构建或浏览器测试。用户主评审/部署授权尚未取得；主线程最终交付不提交、不部署。原所有线上演示数据和既有工作树/服务未改动。

## 最终复核

本地文档及构建/恢复收尾 COMPLETE（非主评审批准）；整体保留本地候选、未提交/未合并/未部署状态。独立终检 SHIP 仅关闭原四项 P2，用户主评审/部署授权尚未取得。主线程将最终交付，不提交、不部署；documenter 完成三文件更新后停止：

| 项目 | 当前状态 | 已完成证据或 main 剩余项 |
| --- | --- | --- |
| 四项 P2 修后针对性 verdict | SHIP，4/4 resolved | 独立终检 01a11e68，仅原四项 P2：完整正文/可编辑署名/剪贴板失败、srgb浅绿面板、成功与失败/未知提示、两个展开按钮 ARIA；不扩展为整站或生产认证 |
| 最终静态与列明回归 QA | PASS | 模块纯 37/37、DB 54/54、Chrome 37/37（errors=[]）；source-save 24/24、role 21/21、auth-client 33/33、auth 36/36、guide 19/19、core 68/68、business 113/113；最终 `eslint . --quiet`、`tsc`、全范围 stylelint 均 exit 0；business cleanup verified |
| 最终生产构建、next-env 恢复与保留检查 | COMPLETE（非主评审批准） | 主执行确认 Next 生产 webpack build 通过，`next-env.d.ts` 已恢复原 tracked 内容；`git diff --check` 通过；package/lock、AUTH 核心、冻结 types/API/harness、next-env diff=0；helper 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`；`cga.family.check` 容器标签扫描无残留，既有 `cleanup_ok=true` 不扩写成生产清理证明 |
| DEV 残留与用户主评审部署授权 | DEV_OPEN / NOT_AUTHORIZED | webpack layout eval 异常未关闭，production成功不等于DEV修好；用户主评审/部署授权尚未取得，独立 SHIP 不授权提交/合并/部署 |
| 同步生成生产等待 release gate | OPEN / NOT_RUN | 平台代理最长等待/TTFB 与真实 provider 负载联测、是否触发 90s 闲断及发布裁定；若触发，另行优化注册后 202 或流协议，不以原 ID 恢复证明延迟风险关闭 |
