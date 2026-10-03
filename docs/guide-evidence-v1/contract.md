# 指南证据链 v1 契约（G0 冻结）

- 状态：**已冻结**。G1～G6 并行开发以本契约及所在提交为共同基线（SHA 见交付报告）。
- 范围：仅定义契约、共享类型、读模型 DTO、模块/API 名称、fixture 与最小检查。
- 非目标（本轮不做）：业务 API 实现、页面、向量 RAG、Embedding、账号系统、数据驾驶舱、新依赖。
- 冻结文件：`src/lib/guide/types.ts`、`src/lib/guide/view-types.ts`、本文件、契约 fixture 与检查脚本。
  并行期间任何模块不得自行修改冻结类型；需要变更时由契约负责人统一处理。
- 必守不变量：`raw_text` 不可静默改写；`ai_draft` 与 `confirmed_content` 分离；现有教师修改 accept/clarify、
  问答来源、审核快照与有限重试不变；AI-R1 异步写入快照与 children→observations 统一锁顺序不变；
  模型调用不得放进数据库事务；服务端教师校验、来源核对、诊断/评分/排名拦截不变；旧记录与旧 JSONB 兼容。

---

## 1. 已批准口径（实现必须逐条遵守）

1. 展示文案为“**已确认观察到**”。
2. 证据只对应**具体年龄表现条目**，不对应整个目标或领域。
3. 三种正式状态：**暂无相关记录 / 已有相关线索 / 已确认观察到**。
4. AI 关联待核对（“AI 关联待核对”）属于**工作流状态**，不进入正式人数统计。
5. 单次行为可以由一次充分证据支持；持续性表现需要跨日证据或有明确期间、事实依据的连续观察纪要。
6. 不设“满三次自动掌握”等统一门槛。
7. 班级默认按**当前在班名单 ＋ 本学期**统计，按观察发生日期筛选，按儿童去重。
8. 转入前同阶段的有效证据可以纳入，保留发生班级；不宣称本班教学成效。
9. 指南是教育参考，儿童观察才是表现证据；参考年龄不是达标期限。

---

## 2. 指南目录模型（`src/lib/guide/types.ts`）

层级：**领域 → 子领域 → 目标 → 年龄段 → 具体表现条目**。

| 概念 | 类型 | 关键约束 |
|---|---|---|
| 目录 | `GuideCatalog` | `version` 为目录版本；目录先以版本化静态数据提供，不建表 |
| 领域 | `GuideDomain` | `code` ∈ health/language/social/science/arts，中文名见 `GUIDE_DOMAIN_LABELS` |
| 子领域 | `GuideSubDomain` | 归属领域 |
| 目标 | `GuideGoal` | 综合目标；全指南共 **32 个**；`index` 仅用于定位 |
| 表现条目 | `GuidePerformanceItem` | 证据关联的最小对象；`age_band` ∈ 3-4 / 4-5 / 5-6；`text` 为完整原文 |
| 教育建议 | `GuideEducationSuggestion` | 独立保存，`goal_id` 关联目标，不拆到条目 |
| 来源位置 | `GuideSourceLocation` | document / publisher / published_year / section / url? |
| 条目详情 | `GuideItemDetail` | 条目 + 目标/子领域/领域引用 + 该目标教育建议 |

**粒度禁令**：32 个综合目标 ≠ 32 条表现条目。每个目标在三个年龄段下分别列出多条具体表现，
条目数量远多于目标数量；禁止在数据、统计或 UI 中把两者等价换算。

**稳定 ID 约定**（G1 遵守，本契约只约束稳定性，不约束拼写格式）：
- `goal_id`、`item_id`、`suggestion_id` 在目录版本内稳定且全局唯一；
- 目录升版不得改变已发布 id 的含义；已发布 id 只能新增或标记废弃，不得复用。
- 当前冻结版本常量：`GUIDE_CATALOG_VERSION = "moe-3-6-2012.v1"`（G1 的正式目录使用该值）。

**目录查询模块**（G1 实现，建议 `src/lib/guide/catalog.ts`）：
- `listGuideItems(filter?: GuideItemFilter): Promise<GuidePerformanceItem[]>`
- `getGuideItem(itemId: string): Promise<GuideItemDetail | null>`
- `listEducationSuggestions(goalId: string): Promise<GuideEducationSuggestion[]>`

---

## 3. 证据关联模型（JSONB）

存放于 `observations.guide_evidence`（`ObservationGuideEvidence`）：`{ links, last_attempt? }`。
每条 `GuideEvidenceLink` 字段与语义：

| 字段 | 语义 |
|---|---|
| `id` | 关联 id，稳定唯一 |
| `item_id` / `catalog_version` | 指向具体表现条目及创建时的目录版本 |
| `status` | 工作流/正式状态，见下 |
| `support` | 支持条件：`single_event` / `sustained` / `clue_only`；AI 建议、拒绝、撤回时为 null |
| `basis` | **依据快照**：来源观察 id、`observed_at`、来源片段、片段出处、发生时班级快照；写入后不重算 |
| `ai_reason` | AI 建议理由，供教师核对 |
| `teacher_note` | 教师决定备注（例如说明成人帮助方式） |
| `created_at` / `decided_at` | 创建时间 / 教师决定时间 |
| `withdrawn_at` / `withdrawn_reason` | 撤回信息（仅撤回态） |

**状态机（单向；终态需重新建议产生新关联）**：

```
ai_suggested ──→ confirmed_performance ──↔── confirmed_clue
      │                     │                      │
      ├──→ rejected         └──────→ withdrawn ←───┘
```

- `ai_suggested`：AI 建议待核对（工作流状态，不计入正式统计）；
- `confirmed_performance`：教师确认的**表现**（已确认观察到）；
- `confirmed_clue`：教师确认的**线索**（已有相关线索）；
- `rejected`：教师不采用 AI 建议（终态，不计入统计）；
- `withdrawn`：已确认后撤回（终态，不计入统计；保留撤回信息与依据）。

**支持条件规则**：
- `single_event`：一次充分证据即可确认单次行为表现；
- `sustained`：需 `basis` 跨日（至少两个不同 `observed_at`），或 `teacher_note` 给出明确期间与事实依据的连续观察纪要；
- `clue_only`：证据只支持“相关线索”，不足以确认具体表现；
- **不设统一次数门槛**；“满三次自动掌握”等规则一律禁止。

**成人帮助**：观察片段涉及成人帮助时，不得静默描述为独立表现；教师可在 `teacher_note` 说明帮助方式，
由教师决定确认表现还是线索（fixture 场景五为示例）。

**依据快照**：`quote` 必须能在 `quote_source` 指向的文本中逐字连续找到（仅容忍空白差异，沿用现有引文核对规则）；
`class_context` 缺失即历史未知，不补造。

**禁止字段**：关联与读模型中不得出现能力分数、等级、模型置信度或任何对儿童的评价性打分。

---

## 4. 最小存储方案（G2 落库）

1. 指南目录：**版本化静态数据，无需新表**。
2. 新增两个**可选 JSONB** 列（旧记录为 NULL，安全兼容，不补造历史）：

```sql
-- 参考片段：由 G2 纳入其迁移并在隔离环境执行；G0 不执行任何迁移
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS class_context_snapshot jsonb;
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS guide_evidence jsonb;
```

3. `observations.class_context_snapshot`（`ObservationClassContextSnapshot`）：创建观察时由 G2 写入
   发生时班级 id / 名称 / 学段 / 学年 / captured_at。班级改名或停用后历史展示仍稳定。
   旧记录缺失 → 按“历史班级未知”展示，不得用当前班级回填。
4. `observations.guide_evidence`：G5 读写；不改变 `ObservationDraft` 现有六个 AI 字段及
   `confirmed_content` 语义；不改变 `agent_context` 结构。
5. 读取兼容：字段缺失、JSON 不可解析、未知 `status` 一律按“无关联/未知”安全降级，不抛错、不删除原始 JSONB。
6. 学期起止来自**显式配置**（G2 提供，建议 `src/lib/guide/semester.ts` 或等价模块），不建表、不推断。

---

## 5. 状态计算规则（个人页与班级页必须一致）

对每个 (儿童, 条目, 筛选范围)：

1. **候选关联**：该儿童所有观察的 `guide_evidence.links` 中 `item_id` 匹配、且 `basis` 至少引用一条
   “已确认观察”（`status = confirmed` 且 `confirmed_content` 非空）的关联。
2. **排除**：`ai_suggested` / `rejected` / `withdrawn` 不参与正式状态。
3. **目录版本**：`catalog_version` 与当前目录不一致时，若 `item_id` 仍存在则继续统计并给出
   `catalog_version_mismatch` 提示；若条目已不存在则排除并给出 `item_not_in_catalog`。
4. **日期筛选**（`filter_field` 恒为 `observed_at`）：
   - `semester`：`basis` 中至少一条 `observed_at ∈ [start_date, end_date]`（含首尾）；
   - `all_history`：不限日期。
5. **状态**：存在 `confirmed_performance` → **已确认观察到**；否则存在 `confirmed_clue` → **已有相关线索**；
   否则 **暂无相关记录**。
6. **班级人数**：对**当前在班名单**（`child_class_enrollments.end_date IS NULL`）每位儿童按同一规则计算，
   按儿童去重；`counts.no_records + counts.has_clues + counts.confirmed_observed` 恒等于名单人数（分母）。
   `confirmed_ratio = confirmed_observed / total`（`total = 0` 时为 `null`）。
7. **转入前证据**：只按儿童与 `observed_at` 纳入，不按 `class_id` 排除；来源展示使用 `basis.class_context`
   的发生班级；文案不得宣称本班教学成效。
8. **阶段过滤**：`basis` 发生班级阶段可解析（优先 `class_context_snapshot.stage`，缺失时可用 classes 行 stage）
   且与当前班级阶段不同 → 排除并给出 `out_of_stage_evidence`；阶段未知 → 纳入并在来源处显示历史未知。
9. **历史归类**：条目所属年龄段只作参考；展示历史时不按儿童当前年龄重新归类。
10. **待核对**：`ai_suggested` 单独作为 `pending_suggestions` 展示，不计入状态与人数。

---

## 6. 读模型 DTO（`src/lib/guide/view-types.ts`）

### 6.1 个人页 `ChildEvidenceBook`

`child`、`catalog_version`、`catalog`（完整目录）、`scope`（筛选范围）、`status_counts`（三类条目数）、
`goals[].items[]`（`ChildGuideItemView`：条目 + 状态 + `confirmed_links` 正式来源 + `pending_suggestions`
工作流来源 + 最早/最近观察日期）、`notices`。

### 6.2 班级页 `ClassEvidenceOverview`

`class`、`catalog_version`、`catalog`、`scope`、`roster`（当前在班名单 + `child_count` 分母）、
`goals[].items[]`（`ClassGuideItemView`：条目 + `counts` 三类人数 + `total` 分母 + `confirmed_ratio`
+ 每位儿童的 `ClassChildItemStatus`）、`notices`。

- `confirmed_ratio` 仅班级页允许；展示时必须同时给出分母（`total`）与统计期间（`scope`），
  并注明“按观察日期与在班名单统计，不宣称教学成效”。
- 个人页禁止任何百分比、等级、排名；个人页只呈现条目状态与来源。

### 6.3 错误、未知与空状态

- `notices`（`EvidenceNotice`）显式表达：`catalog_version_mismatch`、`item_not_in_catalog`、
  `basis_expired`、`ai_link_failed`、`history_unknown`、`out_of_stage_evidence`、`empty_roster`、`empty_evidence`。
- 空状态：名单为空 → `empty_roster` 且 `total = 0`、`confirmed_ratio = null`；无任何证据 → `empty_evidence`，
  全部条目为“暂无相关记录”。
- 错误体统一为 `EvidenceApiError = { error: EvidenceErrorCode; message: string }`。

---

## 7. 模块与 API 契约

### 7.1 冻结名称

| 模块 | 名称 | 归属 |
|---|---|---|
| 目录查询 | `listGuideItems` / `getGuideItem` / `listEducationSuggestions` | G1 |
| 读模型 | `getChildEvidenceBook` / `getClassEvidenceOverview` | G5 |
| 读接口 | `GET /api/children/[id]/evidence-book` | G5 |
| 读接口 | `GET /api/classes/[id]/evidence-overview` | G5 |
| 写接口 | `POST /api/observations/[id]/guide-evidence` | G5 |

### 7.2 GET 接口（只读）

- Query：`?scope=current_semester|all_history`、`?semester_id=<id>`（`semester_id` 优先于 `scope`）。
- 响应：`200` + 对应 DTO；`404` 儿童/班级不存在；`409 semester_config_missing`
  （默认学期无法从显式配置解析且未显式指定 `all_history`/`semester_id`）；`500`。
- **GET 绝不调用模型、绝不写数据库**。读接口与现有只读页一致，不要求教师口令。

### 7.3 POST `/api/observations/[id]/guide-evidence`

请求体按 `action` 区分（`GuideEvidenceMutationRequest`）：

| action | 请求字段 | 语义 |
|---|---|---|
| `suggest` | 无 | 触发 AI 关联：模型调用在**事务外**；逐条核对引用与条目；原子追加 `ai_suggested`，不覆盖教师已决定项 |
| `confirm` | `link_id`、`support`、`basis[]`、`teacher_note?` | 教师确认线索/表现；写入支持条件与依据快照 |
| `reject` | `link_id`、`reason?` | 不采用 AI 建议（终态） |
| `withdraw` | `link_id`、`reason?` | 撤回已确认关联（终态，保留撤回信息） |

响应：`200 GuideEvidenceMutationResponse { observation_id, links, notice? }`。

状态码与语义：

| 码 | `error` | 条件 |
|---|---|---|
| 400 | `invalid_request` | 结构校验失败；`support` 非法；`basis` 为空；`sustained` 既无跨日证据也无期间说明 |
| 401 | `unauthorized` | 非教师身份（沿用 `requireTeacher`） |
| 503 | `teacher_auth_disabled` | 未配置 `TEACHER_PASSCODE`（沿用现有行为） |
| 404 | `not_found` | 观察或 `link_id` 不存在（`link_id` 必须属于该观察） |
| 409 | `state_conflict` | 观察未确认时执行 confirm/reject/withdraw；link 状态不允许当前操作；期望快照不匹配（并发写入） |
| 409 | `basis_expired` | confirm 时某条 `basis.quote` 无法在对应 `quote_source` 文本中逐字找到 |
| 409 | `catalog_version_mismatch` | confirm 时 `item_id` 不在当前目录版本 |
| 500 | `server_error` | 其他服务端错误 |

补充规则：

- confirm 要求观察 `status = confirmed`；`basis` 观察必须属于同一儿童且已确认；`quote` 必须可核对；
  `sustained` 需跨日依据或 `teacher_note` 的明确期间说明。
- `suggest` 的模型/引用核对失败**不**返回 5xx：返回 `200` + `notice: ai_link_failed`，
  并记录 `last_attempt { ok:false, error }`；成功时 `last_attempt.ok = true`。
- 写 `guide_evidence` 必须条件更新（比较期望的 `updated_at` 或 `guide_evidence` 快照），
  且**不得触碰** `raw_text`、`ai_draft`、`confirmed_content`、`agent_context`、`status`；
  与现有 AI-R1 异步写入快照机制并存。
- 模型调用不得放进数据库事务；如实现选择加行锁，必须遵守既有 children→observations 锁顺序。
- **依据过期语义**：读取时失效依据不报错、不删除，按 `basis_expired`/`history_unknown` 提示展示；
  写入时失效返回 `409`。

---

## 8. 时间与学期规则

1. 学期起止**必须**来自显式配置（`SemesterPeriod`）；不得从日期、班级学年或学期名称推断。
2. 统计与筛选恒按 `observed_at`（观察发生日期，日历日），区间**含首尾**；
   服务端“当前日期/今天”统一使用 `isoDateInShanghai()`（亚洲/上海）。
3. 历史阶段不按儿童当前年龄重新归类；展示历史条目时按观察发生时定位参考年龄段。
4. 没有可靠历史资料（缺班级快照/无法解析阶段）时显示**未知**，不自动归入小班或任何阶段。
5. 参考年龄不是统一达标期限；教师可确认任何年龄段的条目。

---

## 9. 共享文件归属与并行纪律

| 文件/模块 | 归属 | 内容 |
|---|---|---|
| `src/lib/guide/types.ts` | G0 | 冻结：目录、证据关联、学期、班级快照 |
| `src/lib/guide/view-types.ts` | G0 | 冻结：DTO、状态、通知、API 类型 |
| `src/lib/guide/__fixtures__/contract-fixtures.ts` | G0 | 契约 fixture（不写库、不调模型） |
| `scripts/check-guide-contract.ts` | G0 | 最小契约检查 |
| `docs/guide-evidence-v1/contract.md` | G0 | 本文件 |
| 目录数据与目录查询 | G1 | `listGuideItems` / `getGuideItem` / `listEducationSuggestions` |
| 历史、学期、schema、创建观察路径 | G2 | `SemesterPeriod` 配置、两个 JSONB 列、迁移 SQL、写入快照 |
| UI 组件与 surface brief | G3 / G4 | 仅各自组件与 brief，不改共享类型 |
| 证据业务、AI、确认路径、读模型 | G5 | `getChildEvidenceBook` / `getClassEvidenceOverview` / 三个 API |
| 正式页面接入与整合 | G6 | 页面装配 |

并行纪律：

- 冻结文件只由契约负责人修改；其他模块需要变更时先提接口问题，不私自改变契约。
- 不自动切换、合并或重置其他 agent 的分支；只提交自己负责的文件，保留正常提交历史。
- 不 push、不部署、不修改生产环境变量；不输出 `.env`、口令、API Key、完整连接串。
- 迁移 SQL 只能由 G2 在隔离本地 PostgreSQL/自建容器执行，禁止对托管库或线上库执行。
- 真实 LLM 预算已耗尽：G5 的 suggest 路径使用离线 invoke 替身；真实 provider 测试标记 `NOT_RUN`。
- 浏览器接口拦截只能证明 UI 状态，不能当作真实数据库或模型全链路验收。

---

## 10. Fixture 与最小检查

- Fixture：`src/lib/guide/__fixtures__/contract-fixtures.ts`
  - 目录 fixture 为**最小示意**（2 目标 / 3 条目），证明“目标数 ≠ 条目数”，不是正式目录；
  - 场景覆盖：三种正式状态、AI 待核对、成人帮助、历史未知、撤回、不采用、跨日持续性表现；
  - 班级 fixture：20 名合成幼儿，同一目标条目 **6 人表现 / 4 人线索 / 10 人无记录**，
    其中 1 名儿童的待核对建议不影响正式状态；
  - fixture 全部为纯数据：不写数据库、不调用模型、不冒充真实 LLM 结果。
- 检查：`pnpm tsx scripts/check-guide-contract.ts`（离线，只读 fixture）
  - 校验展示文案、目录粒度、来源定位、状态规则、跨日要求、20 人分布与去重分母。

---

## 11. 验收与已知限制

本轮（G0）离线验收：

- `pnpm ts-check` 通过；
- `pnpm tsx scripts/check-guide-contract.ts` 输出 `{ passed: 12, total: 12 }`；
- 契约无互相冲突：类型、DTO、状态规则、API 语义均以本文件为准。

`NOT_RUN`（本环境明确未执行，不得当作通过）：

- 真实 StepFun/Coze provider 调用：`NOT_RUN`（预算耗尽，禁止调用或重置账本）；
- 隔离实库迁移与读写：`NOT_RUN`（G0 不执行迁移、不改库）；
- 浏览器/UI 验收：`NOT_RUN`（G0 无页面交付）；
- 生产环境部署与环境变量变更：未执行且禁止。
