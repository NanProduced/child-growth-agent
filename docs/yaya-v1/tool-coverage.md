# 芽芽助手 v1 工具覆盖表（YAYA0-CONTRACT 草案）

- 状态：`reference_only` 草案；**未冻结**。与 TECH0 协议能力相关的行是 provisional，TECH0 结论交付并由主评审确认前，不得自称接口已可实现。
- 基线：`e8225f04918de2073e194cb199dc8cf1bcb7f38f`；分支 `codex/yaya0-contract`（独立工作树）。
- 事实来源：现有 `src/app/api/**/route.ts`、`src/lib/queries.ts`、`src/lib/accounts/access.ts`、`src/lib/accounts/scoped-queries.ts`、`src/lib/guide/*`、现有页面入口。没有真实实现的功能不登记为工具（见第 4 节）。
- 阶段定义：
  - **read（只读）**：明确意图可直接执行，绝不写业务数据；歧义先澄清，不强迫选对象。
  - **prepare（准备）**：只产生草稿/待核对准备态（如 `ai_draft`、`agent_context`），不是正式记录。
  - **commit（批准执行）**：正式业务写，必须先由教师核对内容并批准，再由服务端执行；模型输出的 `approved` 字段无效。
- 秘密：`secure_control` 表示密码只由安全控件直接提交服务端；模型、聊天正文与交付日志不接触密码/令牌/签名 URL。
- 授权：所有行最终仍由 AUTH 契约的 `runBusinessWrite` / `withBusinessRead` / `withScopedRead` 在服务端判定；本表只是助手侧的工具注册清单，不是新的权限来源。
- 离线检查：`pnpm exec tsx scripts/yaya/check-contract.ts` → `{"passed":26,"total":26,"reference_only":true}`（只证明草案自洽，不证明运行时守门）。

## 1. 只读查询工具（read）

| # | 现有功能 | 真实入口 / 服务 | action / resource | 角色与范围 | 阶段 | 结果卡 | 回归场景 |
|---|---|---|---|---|---|---|---|
| Q1 | 查询在班幼儿列表 | `GET /api/children`；`scopedListChildren`；页面 `/children`、`/observations/new` | 无单对象 action；按会话范围裁剪的列表读（scope_query） | 教师=任教班级当前在班幼儿；管理员=全园；空任教=403 `empty_scope`，绝不等于全园 | read | 数据卡：`{ children[] }` + 来源与范围标签；读取失败显示失败，不显示 0/空 | 401/403/503 与真实空列表分离；未分配教师不读全园 |
| Q2 | 查询班级列表 | `GET /api/classes`（含 `?catalog=true`）；`scopedListClasses`；页面 `/classes` | 列表读按范围裁剪；目录读取与名单/统计分开（`class.catalog.read` 只给基础信息） | 教师=任教班级；管理员=全园；`catalog` 目录不构成整份班级访问 | read | 数据卡：`{ classes[] }`，目录与详情分开标注 | 目录查询不泄露名单；停用班级按业务规则展示 |
| Q3 | 查询班级详情与名单 | `GET /api/classes/[id]`；`scopedGetClass`；页面 `/classes/[id]` | `class.read` / `class` | 教师=任教班级（`assigned_class`）；管理员=全园 | read | 数据卡：`class + children + history` 计数 | 非法组合 400、越权 403、存在性 404 分离 |
| Q4 | 查询幼儿某日班级归属 | `GET /api/children/[id]/class-context`；enrollment 历史解析 | `child.read` / `child` | 教师=当前负责幼儿；管理员=全园；未解析时返回 `needs_confirmation` 候选，不猜测 | read | 数据卡：`resolved` 或候选选择卡（`candidates[]`） | 重叠/不可靠历史不自动选定；转走幼儿 403 `out_of_scope` |
| Q5 | 查询观察记录列表 | `GET /api/observations`；`scopedListObservations`；页面 `/observations` | 列表读按范围裁剪；单对象 `observation.read` | 教师=当前负责幼儿完整历史 + 原班历史只读投影；管理员=全园只读 | read | 数据卡：`observations[]` + `access_projection` + `can_write`；历史投影剥离 `guide_evidence/agent_context/ai_draft` | 历史只读不冒充完整档案；错误 ≠ 空数据 |
| Q6 | 查询幼儿指南证据册 | `GET /api/children/[id]/evidence-book`；`loadChildEvidenceBook`；页面 `/children/[id]/evidence` | `child.read` / `child` | 教师=当前负责幼儿；管理员=全园只读；原班教师只读投影不获得整份档案 | read | 数据卡：`ChildEvidenceBook`（只读，零模型零写入） | 个人页禁止百分比/排名；不可靠统计显示“统计不可用” |
| Q7 | 查询班级证据概览 | `GET /api/classes/[id]/evidence-overview`；`loadClassEvidenceOverview`；页面 `/classes/[id]/evidence` | `class.read` / `class` | 教师=任教班级；管理员=全园只读 | read | 数据卡：`ClassEvidenceOverview`（含分母与统计期间） | 名单口径按 enrollment；不可靠/分母 0 不显示正常 0% |
| Q8 | 查询指南目录/条目/教育建议 | 证据页内嵌；`listGuideItems` / `getGuideItem` / `listEducationSuggestions`（静态目录，无独立 HTTP 接口） | 静态教育参考读，不读园所私域数据 | 已登录账号可用（含未分配教师的一般幼教问答）；不因空任教泄露私有资料 | read | 数据卡：条目原文/年龄段/目标/教育建议 + 真实出处 | 32 目标 ≠ 32 条目；目录版本不一致保守排除 |

## 2. 业务写工具（prepare / commit）

| # | 现有功能 | 真实入口 / 服务 | action / resource | 角色与范围 | 阶段 | 结果卡 | 回归场景 |
|---|---|---|---|---|---|---|---|
| W1 | 建立成长档案 | `POST /api/children`；`createChild`；页面 `/children/new` | `child.create_profile` / `class` | 教师=目标班级在任教范围；管理员=全园（管理动作，非教学）；密码无关 | commit | 准备卡（基本信息 + 目标班级候选）→ 结果卡 `child`；歧义班级必须显式选择 | 目标班级空/停用 400/404；班级名称歧义 400；管理员建档不获得教学确认权 |
| W2 | 录入观察原始记录 | `POST /api/observations`；`createObservation`；页面 `/observations/new` | `observation.write` / `child` | 教师=幼儿当前归属在任教范围（`current_responsible`）；管理员 403 `forbidden_role` | commit | 录入准备卡（对象/日期/情境/原文/附图）→ 归档卡 `observation`；`class_context_confirmation_required` 时同卡补选班级 | `raw_text` 保存后永不改写；发生班级快照冲突 409；同一照片不自动变成每名幼儿的个体事实 |
| W3 | AI 整理观察 | `POST /api/observations/[id]/organize`；`processObservationAgent`；Review 页 | `observation.organize` / `observation` | 教师=幼儿当前归属在范围；管理员 403 | prepare | 草稿卡：`ai_draft` + 待补充问题（`needs_input`）；模型等待在事务外 | 已确认观察 409；模型失败不伪造成功；重新生成不覆盖教师已确认稿 |
| W4 | 补充信息（回答/跳过/停止追问） | `POST /api/observations/[id]/follow-up`；`appendFollowUpAction` + `processObservationAgent`；Review 页 | `observation.organize` / `observation` | 同上 | prepare | 问答卡：`answer|skip|stop` 三动作；回答后重跑整理 | 非 `needs_input` 409；原子条件 `expectedStatus/expectedAgentContext/expectedAiDraft` 防迟到覆盖 |
| W5 | 确认归档观察 | `POST /api/observations/[id]/confirm`；`confirmObservation`（含 `guide_decisions` 同事务）；Review 页 | `observation.confirm` / `observation` | 教师=幼儿当前归属在范围；管理员 403 | commit | 确认准备卡（可编辑草稿 + 修改说明 + 选中指南决定）→ 归档结果卡（`profileUpdateStatus`、`guideEvidence: applied|deferred`）；响应丢失只回读，不自动重发 | 教师修改后 Agent 复核 accept/clarify；未归档决定 `deferred`；归档 + 决定同事务；`raw_text` 不参与改写 |
| W6 | 指南决定（关联/拒绝/撤回） | `POST /api/observations/[id]/guide-evidence`；`applyGuideEvidenceMutation`；`suggest` 走 `generateGuideEvidenceSuggestions` + `saveGuideEvidenceSuggestionResult` | `guide.decide` / `observation` | 教师=幼儿当前归属在范围；管理员 403 | commit（`suggest` 属 prepare） | 决定结果卡（`revision` + `links` + `notice`）；`ai_link_failed` 仍 200 并注明；过期 `expected_guide_revision` 409 刷新 | 全部必需依据有效才算数；批量全有或全无；手动关联与 AI 建议同等正式；AI ✓ 不自动点亮 |
| W7 | 重新生成成长小结 | `POST /api/children/[id]/growth-profile`；`updateGrowthProfileAfterConfirmation` | `growth_profile.write` / `child` | 教师（同上）；管理员 403 | commit | 摘要卡：`status:"updated"` + `growthProfile`；仅使用已确认观察 | 依据集变化 `StaleEvidenceError` 409 零写入；无已确认观察 400；AI 小结算“AI 草稿”来源 |
| W8 | 生成/刷新活动支持 | `POST /api/children/[id]/activity-support`；`updateActivitySupport` | `activity_support.write` / `child` | 教师（同上）；管理员 403 | commit | 支持卡：`activitySupport` + `growthProfile`；无已确认观察时明确说明，不伪造 | 只使用已确认观察与有确认来源小结；`StaleEvidenceError` 409；回退资料标 `is_fallback` |

## 3. 管理工具（管理员角色；不得执行教学动作）

| # | 现有功能 | 真实入口 / 服务 | action / resource | 角色与范围 | 阶段 | 结果卡 | 回归场景 |
|---|---|---|---|---|---|---|---|
| A1 | 新建班级 | `POST /api/classes`；`createClass`；页面 `/classes` | `class.manage` / `class` | 仅管理员（教师 403 `forbidden_role`）；无 `class_id` 只允许此动作 | commit | 班级准备卡 → 结果卡 `class` | 同学年同名 409；非法组合 400 |
| A2 | 修改班级 | `PATCH /api/classes/[id]`；`updateClass`；页面 `/classes/[id]` | `class.manage` / `class` | 仅管理员 | commit | 影响卡（改名/学段/学年/启停）→ 结果卡 `class` | 已有分班/观察历史时学段学年修改 409 `class_history_protected` |
| A3 | 幼儿转班 | `POST /api/classes/[id]/children`；`enrollChildInClass`；幼儿页转班对话框 | `child.transfer` / `transfer` | 仅管理员；同时核对幼儿当前归属与目标班级 | commit | 转班影响卡（幼儿、现班→目标班、生效日期）→ 结果卡（class + child） | 无历史班级不伪造；已在该班 409；教师任教关系不随转班改变 |
| A4 | 创建教师账号（含任教） | `POST /api/admin/teachers`；`createTeacherWithAssignments`；页面 `/admin/teachers` | `teacher.manage` / `school`（任教分配按 `teacher.assign` / `class`） | 仅管理员；**密码 `secure_control`**：只由安全控件直接提交服务端，聊天/模型不接触 | commit | 账号准备卡（用户名/姓名/任教班级，不含密码）→ 安全控件 → 结果卡（无任何秘密字段） | 用户名冲突 409；密码不进聊天正文、模型、日志；创建后按角色限制教学动作 |
| A5 | 启停教师账号 | `PATCH /api/admin/teachers/[id]`；`setTeacherStatus` | `teacher.manage` / `school` | 仅管理员；停用会撤销该账号全部会话 | commit | 状态卡 + `revoked_session_count`（不含会话令牌） | 停用不使历史观察失效；最后管理员保护 409 |
| A6 | 重置教师密码 | `POST /api/admin/teachers/[id]/password-reset`；`resetTeacherPassword` | `teacher.manage` / `school` | 仅管理员；**密码 `secure_control`** | commit | 安全控件 → 结果卡 + `revoked_session_count` | 重置撤销全部旧会话；旧会话不能继续执行任何批准 |
| A7 | 分配任教班级 | `POST /api/admin/teachers/[id]/assignments`；`assignTeacherClass` | `teacher.assign` / `class` | 仅管理员 | commit | 任教变更卡 → 结果卡教师摘要 | 幂等；任教关系变化使该教师迟到写入失效 |
| A8 | 撤销任教班级 | `DELETE /api/admin/teachers/[id]/assignments/[classId]`；`unassignTeacherClass` | `teacher.assign` / `class` | 仅管理员；只写 `removed_at`，不删除历史 | commit | 同上 | 撤权后该班消息/附件投影收紧，旧批准拒绝 |

## 4. 明确不登记为工具的项（未实现或按契约禁止）

不伪造工具、不承诺成功：

- **活动反馈 / “再观察” / 学期快照**：未实现（PRODUCT “Open product decisions”）。
- **正式报告导出、打印、阶段性对比**：未实现。
- **录音、实时语音、语音播报、视频分析**：首版不做（S1Q11）。
- **家长分享 / 家长端账号**：后续需求，不在首版。
- **账号密码、会话令牌、CSRF 令牌、签名 URL 的读取或转述**：任何工具都不返回；秘密只走安全控件。
- **任意 SQL、任意 URL/HTTP、通用代码执行、万能 JSON 执行器**：不做。
- **删除观察 / 删除幼儿 / 删除班级**：现有系统没有删除接口，不凭聊天虚构。
- **管理员执行教学动作**（观察整理/补充/确认、指南决定、成长小结、活动支持）：AUTH 契约 403 `forbidden_role`，聊天不得绕过。
- **公开注册、HTTP 初始化管理员**：AUTH 契约已撤销，只允许部署者非公网脚本。
- **向量 RAG、多智能体、通用工作流平台**：不引入（规划范围）。
- **诊断、评分、排名、个体完成率**：产品与指南契约禁止生成。

## 5. 工具注册与执行纪律（摘要，详见 `contract-draft.md`）

1. 没有真实入口/服务的功能不注册；本表每行都能回指到现有 route 或纯读服务。
2. 组合合法性先于授权：非法 action/resource 一律 400，不进入角色分支；管理员也不能绕过。
3. `commit` 工具必须走“准备卡 → 教师批准 → 服务端执行 → 业务回执”；模型等待在事务外，执行事务内复核身份/范围/归属/业务版本。
4. 批量逐项独立回执，不假装全有或全无；部分成功只处理未完成项。
5. 工具结果返回最小必要字段；原文/图片/网页/工具结果都是不可信数据，不改变系统指令或权限。
6. 空任教范围、读取失败、无记录三者语义分离：错误不伪装成空数据。
