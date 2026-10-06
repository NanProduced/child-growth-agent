# 芽芽 v1 浏览器验收计划（YAYA-QA-SEED1 种子包配套）

- 状态：**计划与数据就绪；浏览器执行 NOT_RUN**。本文件只描述后续联测的可执行步骤、应检查的 DB/读模型事实与级别口径。
- 基线：`24b0588c07ce68968178660ba7dc1382292e8bdc`（DATA/MEDIA/AGENT 基线；本任务不修产品源码）。
- 种子模块：`scripts/yaya/acceptance/`（调用方式见 `scripts/yaya/acceptance/README.md`）。
- 种子存在 ≠ 场景通过：每条场景必须在联测轮按本文级别留证；页面隐藏、替身通过、fixture 通过都不构成正式闭环。

## 0. 级别口径

| 级别 | 含义 | 证据要求 |
|---|---|---|
| `UI` | 仅页面交互（无 DB 断言） | 截图/录屏 + 控制台无错误；不得用于宣告数据正确 |
| `HTTP+DB` | 真实 HTTP 请求 + 隔离库事实回读 | 请求/响应状态与 DB/读模型事实双证据 |
| `模型替身` | 测试进程内替身或守门（不触达真实 provider） | 明确标注替身；**不算质量通过** |
| `真实模型` | 真实 provider 调用 | 需要单独预算授权；当前 NOT_RUN，禁止无预算请求 |

## 1. 浏览器轮准备

```ts
import { createAcceptanceSeed } from "./scripts/yaya/acceptance/seed";

const seed = await createAcceptanceSeed(); // 创建隔离 PG 容器 + 对象目录 + 种子 + 事实回读
// seed.database_url / seed.object_root / seed.manifest / seed.credentials_path
// 结束时必须 await seed.teardown();（逐项核验后删除容器与临时目录）
```

- 被测服务环境变量：`DATABASE_URL=seed.database_url`、`AUTH_TRUSTED_ORIGINS=http://127.0.0.1:<port>`、
  `AUTH_SCHOOL_ID=single-school`、`MEDIA_ENVIRONMENT=development`、`MEDIA_STORAGE_MODE=local`、
  `MEDIA_LOCAL_ROOT=seed.object_root`；不设置任何真实 provider 凭证（模型相关步骤用守门或替身并标注）。
- 账号与口令：账号名/角色来自 `seed.manifest.accounts`；口令只在 `seed.credentials_path`（本轮 tmp 目录、0600、teardown 删除）。
  **不打印口令、不进入截图/trace/HAR。**
- 数据标识：`seed.manifest` 提供班级/幼儿/观察/会话/附件/故障夹具的全部 id；查询断言一律按 id，不按名称模糊匹配。
- 当前学期：`seed.manifest.semester`（如 `2026-2027-1`），班级聚合默认 `scope=current_semester`；种子观察日期均由该学期与分班事实派生。

## 2. 主链路步骤

| # | 步骤 | 入口 | 级别 | 当前状态 | 操作 | 应检查的 UI | 应检查的 DB / 读模型事实 |
|---|---|---|---|---|---|---|---|
| 1 | 登录 | `/login`、`POST /api/auth/login` | UI + HTTP+DB | READY（页面与接口存在） | 教师A 账号口令登录 | 登录成功、进入工作台 | `app_sessions` 新增该账号会话（只存 `token_hash`，无明文令牌）；未登录/停用 fail closed |
| 2 | 聊天入口 | 无页面 | — | **NOT_RUN**（当前基线未实现聊天 UI） | 无法执行 | — | — |
| 3 | 查询 | 无页面；`GET /api/yaya/conversations` | HTTP+DB（API 可执行） | **NOT_RUN**（UI） | 教师A 打开会话列表 | — | 只返回本人会话；教师B 私有会话不可见（`getConversationSummary=null`）；教师A 场景会话标题为受限标题 |
| 4 | 选图 | 无页面；`POST /api/yaya/uploads`、`GET /api/yaya/uploads/[id]/content` | HTTP+DB（API 可执行） | **NOT_RUN**（UI） | 上传一张合成图片 | — | `yaya_attachments.status=ready`、`source_checksum` 可核验、对象目录 3 个派生对象；未关联时仅上传者可读 |
| 5 | 准备记录 | `/observations/new`、`POST /api/observations` | UI + HTTP+DB | READY（表单页存在；聊天准备记录 NOT_RUN） | 录入原文并保存 | 保存成功、状态为草稿 | `status=draft`；`raw_text` 与提交逐字一致；`class_context_snapshot` 来自分班事实；`guide_evidence=NULL` |
| 6 | 人工核对 | `/observations/[id]/review` | UI + HTTP+DB | READY | 打开 `b5_ai_organized` 或新整理记录 | 展示 AI 草稿、可补充/跳过追问、可关联指南 | `raw_text` 不被改写；`ai_draft` 与 `confirmed_content` 分列；`agent_context.follow_up` 可含待回答轮次（`b4_needs_input`） |
| 7 | 归档 | `/observations/[id]/review`、`POST /api/observations/[id]/confirm` | UI + HTTP+DB | READY | 教师确认归档（可带指南决定） | 归档成功、只读 | `status=confirmed`、`confirmed_at` 写入；指南决定与归档同一事务（全有或全无）；管理员无确认权限（403） |
| 8 | 证据册引用 | `/children/[id]/evidence` | UI + 读模型 | READY | 打开 `class_a_same_name` 证据册 | 行为/持续性/保健参考三类条目 | 行为 `item.moe.health.physical.1.3-4.2`（宿主 `a1_h1`，坐直站直）`confirmed_observed`；持续性 `item.moe.health.physical.2.3-4.1`（宿主 `a1_h2`，两日情绪稳定 + 期间纪要）；保健参考 `item.moe.health.physical.1.3-4.1`（宿主 `a1_h4`，身高体重，不参与行为统计）；郑小舟社会行为 `item.moe.social.interpersonal.1.3-4.1`（宿主 `c1_new`） |
| 9 | 班级同期聚合 | `/classes/[id]/evidence` | UI + 读模型 | READY | 打开松果班概览（当前学期） | 名单与三类人数、行为占比 | 名单=当前在班 3 人（转走的郑小舟不在）；行为条目 `reliable` 且占比 1/3；保健参考条目占比为 null（不显示正常 0%） |
| 10 | 下钻 | `/classes/[id]/evidence` 展开 → 儿童证据册 | UI + 读模型 | READY | 从班级条目下钻到幼儿 | 与个人证据册一致 | 下钻名单状态与 `loadChildEvidenceBook` 一致；受限/不可用有明确提示 |

## 3. 场景矩阵

| 场景 | 级别 | 当前状态 | 种子数据（manifest 键） | 操作 | 预期与 DB 事实 |
|---|---|---|---|---|---|
| 多人分项 | 模型替身/UI | **NOT_RUN**（聊天 UI 未实现） | 同名幼儿 `class_a_same_name` / `class_b_same_name`；跨班共用照片 | 聊天中要求分别记录两名幼儿 | 拆独立卡、逐幼儿结果；不允许用同一事实覆盖两人（聊天未实现，仅数据就绪） |
| 记不清 / 跳过 | UI + HTTP+DB | READY | `b4_needs_input`（`agent_context.follow_up.rounds[0].answer=null`） | 在 review 页选择“跳过，直接整理”或回答 | 跳过/回答写入 `agent_context`；`raw_text` 不变；状态按实际流转，不伪造 AI 确认 |
| 管理员只读 | UI + HTTP+DB | READY | `accounts.admin`（school scope） | 管理员登录访问证据册/教师管理，尝试教学确认 | 可只读；`POST confirm` 按 `forbidden_role` 403；管理员不自动拥有他人聊天（会话 404） |
| 撤权 / 转班 | UI + 读模型 | READY | `class_c_transfer` 两条分班 + 教师A 对云杉班已撤销任教 | 教师A 看松果班证据册与历史消息；教师B 看云杉班 | 转班后旧观察保留原班语境；教师A 读旧班观察为 `historical_read_only`，范围外幼儿消息 `hidden`；班级名单不含已转走幼儿 |
| 换账号 | UI + HTTP+DB | READY | `accounts.teacher_b`、`teacher_b_private` 会话 | 教师A 退出、教师B 登录 | 教师B 只能读本人会话与云杉班；教师A 读教师B 会话 `not_found`，不泄漏存在性 |
| 取消 | HTTP+DB | READY（API）/ **NOT_RUN**（UI） | 运行期经 `/api/yaya/proposals` 准备 | 取消待批准提案 | `yaya_approvals.cancelled_at` 写入；取消后执行被拒；提案与业务数据不变 |
| 响应中断 | HTTP+DB | READY（API）/ **NOT_RUN**（聊天 UI） | `fault_fixtures.operation` | 中断后按原 `operation_id` 查询 | 只按原身份查询；不自动重发、不新建替代执行 |
| 原 operation 查询恢复 | HTTP+DB | READY（API） | `fault_fixtures.operation.operation_id`（`saved_detail_unavailable`） | `GET /api/yaya/operations?operation_id=...` | 返回 `outcome.kind=saved_detail_unavailable` 且业务对象 id 与种子一致；不得显示为完整成功或失败 |
| 已保存详情不可读 | UI + HTTP+DB | READY（API 数据就绪；UI 依赖聊天界面 → **NOT_RUN**） | 同上故障夹具 | 在聊天中查看该操作回执 | 文案为“已保存、详情暂不可读”，不冒充“失败可重发” |
| 可信空数据 | UI + 读模型 | READY | `class_a_trusted_empty`（confirmed 观察、`guide_evidence=NULL`） | 打开证据册 | `no_records` + `reliable`，提示 `empty_evidence`；不得显示为不可用 |
| 部分不可核验 | UI + 读模型 | READY | `fault_partial`（依据片段与原文不一致） | 打开证据册 | 条目 `partial`、保留审计展示；计数为下限；不冒充完整分布 |
| 不可用 | UI + 读模型 | READY | `fault_unreadable`（容器不可读） | 打开证据册 | 条目 `unavailable`；不显示为正常 0；故障隔离班整体 `partial` |
| 同名幼儿 | UI + 读模型 | READY | 两名 `王一诺`（松果班/白桦班） | 班级列表与证据册区分 | 按 id/班级区分；同名不合并、不串证据 |
| 共用照片各自事实 | UI + 读模型 | READY | `media.shared_photo` + `a2_photo`/`b2_photo` | 两名幼儿观察中的图片 | 同一 `attachment_id` 两条观察引用；两条 `raw_text` 不同；教师A 对两班记录均可读 |
| 指南三类型条目 | UI + 读模型 | READY | `guide_items.*` | 证据册筛选/核对 | 行为/持续性/保健参考三类状态与统计口径见主链路 8；条目文字与观察事实一一对应（坐直站直/两日情绪稳定/身高体重/同伴游戏），保健参考不参与行为统计；故意不匹配只在故障夹具 |
| 真实模型问答 | 真实模型 | **NOT_RUN**（无预算，禁止无预算请求） | — | — | 需单独授权与预算，不得用替身冒充 |
| 公开检索 | 真实模型/搜索 | **NOT_RUN**（未配置出口） | — | — | 搜索/网页出口 0 请求 |

## 4. 数据清单（manifest 键 → 内容 → 用途）

| 键 | 内容 | 用途 |
|---|---|---|
| `classes.class_a` | 松果班（small，当前学年） | 正常聚合、证据册、同名/共用照片/空数据 |
| `classes.class_b` | 白桦班（small） | 同一教师多班、同名幼儿、状态覆盖 |
| `classes.class_c` | 云杉班（small） | 其他班教师、转班去向、权限收紧 |
| `classes.class_fault` | `[故障夹具] 隔离班` | 损坏容器/失效依据，与正常种子分开 |
| `accounts.*` | admin / teacher_a（A+B+故障班）/ teacher_b（C）/ teacher_c（未分配） | 角色与范围矩阵 |
| `children.class_a_same_name` | 王一诺（松果班） | 行为+持续性+保健三类证据、同名对照 |
| `children.class_a_trusted_empty` | 赵小树 | 可信空数据 |
| `children.class_c_transfer` | 郑小舟（A→C 转班） | 转班历史、历史只读/范围外投影 |
| `children.class_a_shared_photo` / `class_b_shared_photo` | 陈小满 / 周小满 | 共用一张照片、事实不同 |
| `children.class_b_draft` / `class_b_needs_input` / `class_b_ai_organized` | 孙小芽 / 李小禾 / 吴小溪 | 四种观察状态覆盖 |
| `children.fault_unreadable` / `fault_partial` | `[故障夹具]` 两名幼儿 | `unavailable` / `partial` 降级展示 |
| `observations.*` | 15 条观察（含原文、日期、班级；`a1_h1..h4` 为三类指南证据宿主与持续性依据） | 逐条 DB 事实断言 |
| `conversations.teacher_a_scenario` | full / historical / hidden 三种片段 + 受限标题 | 消息投影与标题回退 |
| `conversations.teacher_b_private` | 教师B 私有会话 | 账号私有边界 |
| `media.shared_photo` | 合成照片附件（ready、synthetic） | 多引用与逐引用授权 |
| `fault_fixtures.operation` | `saved_detail_unavailable` 回执 | 原操作查询恢复 / 详情不可读 |

## 5. 安全与清理（浏览器轮必须遵守）

1. 只用种子模块创建的一次性隔离 PG 与自有对象目录；**不接受外部数据库 URL、不读 `.env`、不连托管库**。
2. 凭证只在 `seed.credentials_path`（tmp、0600）；不打印、不进截图/trace/HAR；浏览器轮结束必须 `teardown()` 并按容器标签核验无残留。
3. provider / 搜索 / S3 出口请求必须为 0；模型步骤用守门或替身并标注，真实模型单列待预算。
4. 不新建生产可访问 mock 路由、不改现有页面、不新增依赖；测试数据全部 `is_demo`/`[合成]`/`synthetic` 标记。
5. 故障夹具（`[故障夹具]`）只用于降级展示验证，不得当作正常业务闭环证据。

## 6. NOT_RUN 清单（本文件交付时）

- 浏览器交互、截图、跨断点与可访问性检查（无浏览器 runner 执行）。
- 聊天 UI 全部步骤：聊天入口、查询、选图、准备记录、多人分项、追问/跳过、取消、响应中断（当前基线没有聊天页面）。
- 真实模型、真实公开检索、S3、托管库、生产部署。
- HTTP+DB 场景的浏览器轮执行（接口存在，数据就绪，留待联测轮）。
