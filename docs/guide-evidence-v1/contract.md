# 指南证据链 v1 契约（G0-R1 修正后重新冻结）

- 状态：**已冻结（R1）**。基线：`69e8d1f` 之上的 R1 提交；G1～G6 并行开发以本契约及所在提交为共同基线（SHA 见交付报告）。
- 范围：契约、共享类型、读模型 DTO、模块/API 名称、fixture 与最小检查。
- 非目标（本轮不做）：业务 API 实现、页面、迁移执行、模型调用、向量 RAG、Embedding、账号系统、数据驾驶舱、新依赖。
- 冻结文件：`src/lib/guide/types.ts`、`src/lib/guide/view-types.ts`、本文件、契约 fixture 与检查脚本。
  并行期间任何模块不得自行修改冻结类型；需要变更时由契约负责人统一处理。
- 必守不变量：`raw_text` 不可静默改写；`ai_draft` 与 `confirmed_content` 分离；现有教师修改 accept/clarify、
  问答来源、审核快照与有限重试不变；AI-R1 异步写入快照与 children→observations 统一锁顺序不变；
  模型调用不得放进数据库事务；服务端教师校验、来源核对、诊断/评分/排名拦截不变；旧记录与旧 JSONB 兼容。

## R1 修正清单（相对 69e8d1f 契约）

| # | 原歧义 | R1 规则 |
|---|---|---|
| 1 | 阶段概念混用 | 明确区分**当前班级阶段 / 指南参照年龄段 / 证据发生时阶段**；证据阶段只来自 `class_context_snapshot.stage`，禁止用动态 `classes.stage` 回填或决定未知历史 |
| 2 | 个人历史可能被当前阶段排除 | 个人页（`child_history`）不按当前学段排除历史证据；班级页（`class_current_roster`）才应用同学段口径 |
| 3 | 依据“一条有效即通过” | 全部必需依据必须有效（同儿童、来源存在、已确认、片段可核对、版本一致）；任一条失效整条不计入正式状态，保留审计展示 |
| 4 | 目录版本兼容 | 版本不一致一律不进入正式状态（保守 v1），不建迁移框架；教师可手动重新关联 |
| 5 | 依据版本无定义 | 依据快照含 `source_confirmed_at`（决定时来源 `confirmed_at`），核对版本一致，防止片段仍在但来源事实已变化 |
| 6 | 确认稿引用位置不清 | `confirmed_content` 只允许 `highlight_quote` / `highlights` 两个事实位置；`objective_description`、`support_suggestions`、`teacher_note` 不可作为表现证据 |
| 7 | 无 AI 建议无法关联 | 新增手动关联（`origin=manual`、`item_id` 直接确认），不依赖先调用模型；AI 失败/旧记录同样可用 |
| 8 | 归档与关联确认分离 | 观察确认接口扩展 `guide_decisions`，与归档在同一事务协调生效；未归档请求返回 `deferred`，不产生正式状态 |
| 9 | 批量/重复/部分失败语义 | 批量决定全有或全无；完全相同的重复提交返回 200 幂等；过期令牌 409 |
| 10 | 跨期持续证据误计 | 持续性关联只有在**全部依据**落在筛选期间内才计入该期间；期间不足显式排除并说明 |
| 11 | 成人帮助一刀切降级 | 条目元数据表达 `adult_help`：`allowed` 说明帮助方式后可确认表现；`requires_independence` 才降为线索 |
| 12 | 连续纪要任意字符串 | 必须提供结构化 `sustained_note`（明确起止期间 + 不少于 10 字的事实说明，且期间覆盖全部依据） |
| 13 | 班级快照来源不明 | 快照新增 `source`（enrollment_lookup / teacher_confirmed / legacy_import）与可选 `enrollment_id`、`confirmed_at` |
| 14 | 条目统计口径缺失 | 条目产品规则 `evidence_type` / `counts_in_behavior_stats` / `adult_help`；产品规则不得伪装成官方新增标准 |
| 15 | NULL 与损坏混同 | NULL 是正常未关联（可靠）；损坏 JSON / 未知状态显式标识并降为 partial/unavailable；技术不可用不是第四种能力状态 |
| 16 | 不可靠统计显示 0% | `reliability` 非 reliable、非行为统计条目或分母为 0 时，占比为 null；仍显示原名单分母 |

---

## 1. 已批准口径（实现必须逐条遵守）

1. 展示文案为“**已确认观察到**”。
2. 证据只对应**具体年龄表现条目**，不对应整个目标或领域。
3. 三种正式状态：**暂无相关记录 / 已有相关线索 / 已确认观察到**。
4. AI 关联待核对属于**工作流状态**，不进入正式人数统计。
5. 单次行为可以由一次充分证据支持；持续性表现需要跨日证据或有明确期间、事实依据的连续观察纪要。
6. 不设“满三次自动掌握”等统一门槛。
7. 班级默认按**当前在班名单 ＋ 本学期**统计，按观察发生日期筛选，按儿童去重。
8. 转入前同阶段的有效证据可以纳入，保留发生班级；不宣称本班教学成效。
9. 指南是教育参考，儿童观察才是表现证据；参考年龄不是达标期限。
10. 成人帮助不是一律降级条件：条目产品规则为 `allowed` 时，说明帮助方式后可以确认表现；只有 `requires_independence` 的条目才只能确认线索。
11. 手动关联与 AI 建议同等正式：没有 AI 建议、AI 失败或旧记录都可以由教师直接关联并确认。

---

## 2. 目录模型（`src/lib/guide/types.ts`）

层级：**领域 → 子领域 → 目标 → 年龄段 → 具体表现条目**。

| 概念 | 类型 | 关键约束 |
|---|---|---|
| 目录 | `GuideCatalog` | `version` 为目录版本；版本化静态数据，不建表 |
| 领域 | `GuideDomain` | `code` ∈ health/language/social/science/arts |
| 子领域 | `GuideSubDomain` | 归属领域 |
| 目标 | `GuideGoal` | 综合目标；全指南共 **32 个** |
| 表现条目 | `GuidePerformanceItem` | 证据关联的最小对象；`age_band` ∈ 3-4 / 4-5 / 5-6；`text` 完整原文 |
| 教育建议 | `GuideEducationSuggestion` | 独立保存，`goal_id` 关联目标，不拆到条目 |
| 来源位置 | `GuideSourceLocation` | document / publisher / published_year / section / url? |

**粒度禁令**：32 个综合目标 ≠ 32 条表现条目；禁止等价换算。
**稳定 ID**：同版本内稳定唯一；升版不得改变已发布 id 含义。
**冻结版本常量**：`GUIDE_CATALOG_VERSION = "moe-3-6-2012.v1"`。

### 2.1 条目产品规则（`GuideItemProductRules`）

> **产品规则是芽芽观察自建的展示/统计口径标注，不是《指南》官方新增标准，不得改写或补充指南原文。**

| 字段 | 取值 | 语义 |
|---|---|---|
| `evidence_type` | `behavior` / `sustained` / `health_reference` | 行为型 / 持续性 / 保健参考 |
| `counts_in_behavior_stats` | boolean | 是否参与行为类正式统计；保健参考类为 false |
| `adult_help` | `allowed` / `requires_independence` | 成人帮助条件：允许（说明帮助方式后可确认表现）/ 要求独立（有成人帮助只能确认线索） |

- `evidence_type = sustained` 的条目确认表现必须用 `sustained` 支持；`single_event` 只能确认线索。
- `counts_in_behavior_stats = false` 的条目在班级页不展示占比。

### 2.2 目录查询模块（G1 实现，建议 `src/lib/guide/catalog.ts`）

- `listGuideItems(filter?: GuideItemFilter): Promise<GuidePerformanceItem[]>`
- `getGuideItem(itemId: string): Promise<GuideItemDetail | null>`
- `listEducationSuggestions(goalId: string): Promise<GuideEducationSuggestion[]>`

---

## 3. 证据关联模型（JSONB）

存放于 `observations.guide_evidence`（`ObservationGuideEvidence`）：

```ts
{
  revision: number,          // 容器修订号：每次写入 +1；旧记录缺失按 0，不补造
  links: GuideEvidenceLink[],
  last_attempt?: GuideEvidenceAiAttempt | null
}
```

### 3.1 `GuideEvidenceLink`

| 字段 | 语义 |
|---|---|
| `id` / `item_id` / `catalog_version` | 关联 id 与目录定位；版本不一致不进入正式状态 |
| `origin` | `ai`（AI 建议）或 `manual`（教师手动建立，不依赖模型） |
| `status` | 见状态机 |
| `support` | `single_event` / `sustained` / `clue_only`；撤回保留最后值（审计），拒绝/待核对为 null |
| `sustained_note` | 结构化连续观察纪要：`period_start`、`period_end`、`description`（≥10 字，期间须覆盖全部依据） |
| `adult_help_used` | 本次决定是否使用成人帮助；与条目 `adult_help` 规则共同校验 |
| `basis` | 依据快照数组（见 3.2） |
| `ai_reason` / `teacher_note` | 建议理由 / 教师决定备注 |
| `revision` | 关联修订号：每次状态或内容变化 +1 |
| `created_at` / `decided_at` | 创建 / 教师决定时间 |
| `withdrawn_at` / `withdrawn_reason` | 撤回信息（仅撤回态） |

### 3.2 状态机（单向；终态需重新建议或手动关联产生新关联）

```
ai_suggested ──→ confirmed_performance ──↔── confirmed_clue
      │                     │                      │
      ├──→ rejected         └──────→ withdrawn ←───┘
```

- `ai_suggested`：工作流状态，不计入正式统计；`rejected` / `withdrawn` 为终态。
- `withdrawn` 保留撤回前的 `support` 与 `basis`（审计一致性），并记录 `withdrawn_at` / `withdrawn_reason`。
- `rejected` / `ai_suggested` 的 `support` 必须为 null。
- 教师可在 `confirmed_clue` ↔ `confirmed_performance` 之间改判（依据与备注重新写入，`revision` +1）。

### 3.3 支持条件与成人帮助

- `single_event`：一次充分证据即可确认单次行为表现。
- `sustained`：至少两条跨日依据（不同 `observed_at`），**或**结构化连续观察纪要（明确期间 + ≥10 字事实说明 + 期间覆盖全部依据）。
- `clue_only`：只确认相关线索。
- 成人帮助：`adult_help_used=true` 且确认表现时，必须填写说明帮助方式的 `teacher_note`；
  条目 `adult_help=requires_independence` 时，有成人帮助只能确认线索（400）。
- **不设统一次数门槛**；“满三次自动掌握”等规则一律禁止。

### 3.4 依据快照（`GuideEvidenceBasis`）

| 字段 | 语义 |
|---|---|
| `observation_id` / `observed_at` | 来源观察与发生日期（时间轴） |
| `quote` / `quote_source` / `quote_field` | 逐字片段与出处；`raw_text` 时 `quote_field=null`；`confirmed_content` 时必须为 `highlight_quote` / `highlights` |
| `class_context` | 发生时班级快照；null = 历史未知，不补造 |
| `source_confirmed_at` | 依据版本：决定时来源观察的 `confirmed_at`；AI 建议可为 null，教师确认时必须写入且与来源当前值一致 |

**有效性（服务端逐条核对，写入与读取双重检查）**：
来源存在、属于同一儿童、`status=confirmed` 且 `confirmed_content` 非空、`observed_at` 与快照一致、
`source_confirmed_at` 与来源当前 `confirmed_at` 一致、片段在声明位置可逐字核对。
**任一条必需依据失效，整条关联不得继续支持正式状态（禁止“有一条有效即可忽略其他失效依据”的 `.some()` 规则）。**
失效依据保留审计展示，附 `valid=false` 与 `invalid_reason`。

---

## 4. 最小存储方案（G2 落库）

1. 指南目录：版本化静态数据，无需新表。
2. 新增两个可选 JSONB 列（旧记录 NULL，安全兼容，不补造）：

```sql
-- 参考片段：由 G2 纳入其迁移并在隔离环境执行；G0 不执行任何迁移
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS class_context_snapshot jsonb;
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS guide_evidence jsonb;
```

3. `class_context_snapshot`（`ObservationClassContextSnapshot`）：class_id / class_name / stage / school_year /
   captured_at / **source** / enrollment_id? / confirmed_at?。来源枚举：`enrollment_lookup`（创建观察时按归属历史解析）、
   `teacher_confirmed`（教师确认）、`legacy_import`（旧记录导入）。**证据发生时阶段只来自此快照**，
   禁止用动态 `classes.stage` 回填或决定未知历史。
4. `guide_evidence`：G5 读写；不改变 `ObservationDraft` 六个 AI 字段与 `confirmed_content` 语义；
   不改变 `agent_context` 结构。
5. 读取兼容：
   - 字段缺失（NULL）＝正常未关联，不报错、不降可靠性；
   - JSON 不可解析 → `guide_evidence_unreadable`；未知状态 → `unknown_link_status`；两者显式标识并降可靠性；
   - 未知字段安全忽略，不删除原始 JSONB。
6. 学期起止来自**显式配置**（G2 提供，建议 `src/lib/guide/semester.ts`），不建表、不推断。

---

## 5. 状态计算规则（个人页与班级页共用正式状态定义，筛选口径不同）

对每个 (儿童, 条目, 筛选范围, audience)：

1. **候选关联**：该儿童全部观察的 `guide_evidence.links` 中 `item_id` 匹配的关联。
2. **目录版本**：`catalog_version` 必须与当前目录完全一致；不一致 → 排除（`catalog_mismatch`，降可靠性），
   不因 `item_id` 仍存在而默认兼容。
3. **依据全有效**：全部必需依据通过 3.4 核对；任一条失效 → 排除（`basis_invalid`，降可靠性）。
4. **期间包含**：全部依据 `observed_at` 必须落在筛选期间内（含首尾）；`sustained_note` 期间同样必须落在期间内。
   跨期持续证据只在本期有一条时**不**计为本期持续表现 → 排除（`basis_out_of_period`，不降可靠性）。
5. **audience 口径**：
   - `child_history`（个人历史回看）：不按当前学段排除，按儿童与日期筛选；
   - `class_current_roster`（班级当前名单统计）：全部依据的发生阶段必须可核对且与当前班级阶段一致；
     阶段不同 → `out_of_stage_evidence`（口径排除）；阶段未知 → `history_unknown`（降可靠性）。
6. **支持条件**：持续性条目确认表现必须 `sustained`；`sustained` 必须跨日或结构化纪要；不足 → `support_insufficient`（降可靠性）。
7. **状态**：存在计入的 `confirmed_performance` → **已确认观察到**；否则存在计入的 `confirmed_clue` → **已有相关线索**；
   否则 **暂无相关记录**。`ai_suggested` / `rejected` / `withdrawn` 不参与。
8. **班级人数**：对当前在班名单（`end_date IS NULL`）每位儿童按同一规则计算，按儿童去重；
   三类人数之和恒等于名单人数（分母）。`confirmed_ratio = confirmed_observed / total`，
   仅在 `reliability=reliable`、条目参与行为统计、`total > 0` 时给出，否则为 `null`。
9. **可靠性**（不是第四种儿童状态）：
   - `reliable`：无完整性/可读性问题（期间与阶段口径排除不算不可靠）；
   - `partial`：存在失效依据、目录版本不一致、支持条件不足、损坏 JSON 或未知阶段等，计数为下限；
   - `unavailable`：相关证据完全无法读取，不得显示为正常的 0；仍显示原名单分母。
10. **待核对**：`ai_suggested` 单独作为工作流状态展示，不计入状态与人数。
11. **历史归类**：条目年龄段只作参考；不按儿童当前年龄重新归类历史证据。

---

## 6. 读模型 DTO（`src/lib/guide/view-types.ts`）

### 6.1 个人页 `ChildEvidenceBook`

`audience: "child_history"`、`child`、`catalog_version`、`catalog`、`scope`、`filters`、
`status_counts`、`goals[].items[]`（`ChildGuideItemView`）、`notices`。

`ChildGuideItemView`：`item`、`status`、`reliability`、`links`（全部关联，逐条带
`counts_toward_status` 与 `excluded_reason`）、`first_observed_at` / `latest_observed_at`。

### 6.2 班级页 `ClassEvidenceOverview`

`audience: "class_current_roster"`、`class`、`catalog_version`、`catalog`、`scope`、`filters`、
`roster`（当前在班名单 + `child_count` 分母）、`goals[].items[]`（`ClassGuideItemView`）、`notices`。

`ClassGuideItemView`：`item`、`counts`、`total`（分母）、`reliability`、`confirmed_ratio`（可 null）、
`children[].{child_id,status,reliability,confirmed_link_count,pending_suggestion_count,first/latest_observed_at}`。

- 班级页允许“已确认观察到占比”，但必须同时显示分母与统计期间，注明按观察日期与在班名单统计、不宣称教学成效；
  不可靠统计、非行为统计条目或分母为 0 时显示“统计不可用/未统计”，不得显示正常 0%。
- 个人页禁止任何百分比、等级、排名。
- 来源细节在个人页展开；班级页钻取到个人页查看来源。

### 6.3 筛选与范围

`EvidenceScope`：`kind` ∈ `semester` / `all_history` / `custom_range`；`semester_id`；`label`；
`start_date` / `end_date`（含首尾；all_history 为 null）；`filter_field = "observed_at"`。
`EvidenceViewFilters`：所选 `domain_code` / `age_band`（指南参照年龄段）/ `goal_id`；null 表示不过滤。

### 6.4 错误、未知与空状态

- 通知码：`catalog_version_mismatch`、`item_not_in_catalog`、`basis_expired`、`basis_invalid`、
  `ai_link_failed`、`history_unknown`、`out_of_stage_evidence`、`guide_evidence_unreadable`、
  `unknown_link_status`、`empty_roster`、`empty_evidence`。
- 空状态：名单为空 → `empty_roster`（`total=0`、占比 null）；无任何证据 → `empty_evidence`（全部“暂无相关记录”）。
- 错误体 `EvidenceApiError = { error, message, link_id?, item_id? }`。

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
| 观察确认扩展 | `POST /api/observations/[id]/confirm` + `guide_decisions` | G5 |

### 7.2 GET 接口（只读）

- Query：`scope=current_semester|all_history|custom_range`、`semester_id`、`from`、`to`、
  `domain`、`age_band`、`goal_id`。
- 优先级：`semester_id` > `from`/`to`（必须同时给出，否则 400）> `scope`；缺省当前学期。
- 响应：`200` + 对应 DTO；`404` 儿童/班级不存在；`400 invalid_request` 日期范围非法；
  `409 semester_config_missing`（默认学期无法从显式配置解析且未显式指定范围）；`500`。
- **GET 绝不调用模型、绝不写数据库**；与现有只读页一致，不要求教师口令。

### 7.3 POST `/api/observations/[id]/guide-evidence`

请求体按 `action` 区分：

| action | 请求字段 | 语义 |
|---|---|---|
| `suggest` | 无 | 触发 AI 关联：模型调用在**事务外**；逐条核对引用与条目；只对**尚无任何关联**的条目追加 `ai_suggested`，不覆盖、不重复教师已决定项；并发写用服务端快照条件更新 |
| `confirm` | `expected_guide_revision`、`decisions[]` | 教师确认：批量决定，支持已有建议（`link_id`）与手动关联（`item_id`） |
| `reject` | `link_id`、`expected_guide_revision`、`reason?` | 不采用 AI 建议（终态） |
| `withdraw` | `link_id`、`expected_guide_revision`、`reason?` | 撤回已确认关联（终态，保留撤回信息） |

`GuideEvidenceDecisionInput`：`support`、`basis[]`、`sustained_note?`、`adult_help_used?`、`teacher_note?`，
外加 `link_id`（已有建议）或 `item_id`（手动关联）。

**批量与重复语义**：

- 批量决定**全有或全无**：任一条失败，整个请求失败且不写入任何决定；错误体带 `link_id`/`item_id` 定位。
- `expected_guide_revision` 为读取时的容器修订号；不匹配返回 `409 state_conflict`（依据已过期，请刷新）。
- 完全相同的重复提交在结果状态已一致时返回 `200` 幂等成功；手动关联遇到同条目已有生效关联且内容不同 →
  `409 state_conflict`（不静默覆盖教师决定）。
- `reject` / `withdraw` 不删除历史：拒绝保留建议与理由，撤回保留 `support`、依据与撤回信息。

**写入规则（服务端）**：

1. 独立 confirm 要求观察 `status=confirmed`；`basis` 观察必须属于同一儿童且已确认；片段可核对；版本一致。
2. 全部依据必须有效（同 3.4）；任一条失效 → 400/409，不写入。
3. `sustained` 需跨日或结构化纪要；持续性条目表现确认需 `sustained`。
4. 成人帮助条件：见 3.3；`adult_help_used` 为真且确认表现时 `teacher_note` 必填。
5. `confirmed_content` 引用只允许 `highlight_quote` / `highlights`。
6. 手动关联的 `item_id` 必须存在于当前目录版本；写入时服务端打上当前 `catalog_version`。
7. 写 `guide_evidence` 必须条件更新（比较期望容器 `revision`），且**不得触碰** `raw_text`、`ai_draft`、
   `confirmed_content`、`agent_context`、`status`；与 AI-R1 异步写入快照机制并存。
8. 模型调用不得放进数据库事务；如加行锁，必须遵守既有 children→observations 锁顺序。

### 7.4 观察确认扩展（一次归档 + 选中关联）

`POST /api/observations/[id]/confirm` 请求新增可选 `guide_decisions`：

```ts
guide_decisions?: {
  expected_guide_revision: number;
  decisions: GuideEvidenceDecisionInput[];
}
```

- 归档请求（实际写入 `confirmed_content`）中，关联决定在**同一事务**内应用，与归档协调生效；
  决定校验失败 → 整个确认失败（400/409），观察保持未归档。
- 未归档请求（如需要教师澄清的路径）不应用决定，响应 `guideEvidence.status = "deferred"`，
  客户端在最终归档请求中重试。
- 不携带 `guide_decisions` 时行为与现状完全一致；不放松现有 accept/clarify 与 AI-R1 保护。

### 7.5 错误码

| 码 | `error` | 条件 |
|---|---|---|
| 400 | `invalid_request` | 结构/日期范围/支持条件/成人帮助说明/引用位置不合法；批量中任一条不合法 |
| 401 | `unauthorized` | 非教师身份（沿用 `requireTeacher`） |
| 503 | `teacher_auth_disabled` | 未配置 `TEACHER_PASSCODE`（沿用现有行为） |
| 404 | `not_found` | 观察或 `link_id` 不存在（`link_id` 必须属于该观察） |
| 409 | `state_conflict` | 未归档时执行独立 confirm/reject/withdraw；状态不允许；容器 `revision` 过期；重复手动关联冲突 |
| 409 | `basis_expired` | 确认时依据无法核对或版本不一致 |
| 409 | `catalog_version_mismatch` | 确认时 `item_id` 不在当前目录版本 |
| 500 | `server_error` | 其他服务端错误 |

- `suggest` 的模型/引用核对失败不返回 5xx：返回 `200` + `notice: ai_link_failed`，记录 `last_attempt{ok:false}`。
- 读取时失效依据不报错、不删除，按 `basis_invalid` / `basis_expired` / `history_unknown` 提示展示。

---

## 8. 时间与筛选规则

1. **三个阶段概念必须区分**：
   - 当前班级阶段：儿童当前归属班级的 stage，只用于班级页 audience 口径；
   - 指南参照年龄段：条目 `age_band` 或视图筛选 `filters.age_band`，只作阅读参考；
   - 证据发生时阶段：只来自 `class_context_snapshot.stage`，缺失即未知，禁止动态回填。
2. 学期起止**必须**来自显式配置（`SemesterPeriod`）；不得从日期、班级学年或学期名称推断。
3. 筛选恒按 `observed_at`（日历日），区间含首尾；服务端“当前日期”统一 `isoDateInShanghai()`。
4. `custom_range` 必须同时给出 `from`/`to`（YYYY-MM-DD，`from ≤ to`），否则 400。
5. 个人历史回看（如“小班时期”）使用 `custom_range` 或 `all_history`，不因当前已升班而排除。
6. 跨期持续证据：全部依据（及纪要期间）落在筛选期间内才计入；否则显式排除并说明期间不足。
7. 历史阶段不按儿童当前年龄重新归类；没有可靠历史资料时显示未知。
8. 参考年龄不是统一达标期限；教师可确认任何年龄段的条目。

---

## 9. 反例清单与规则映射（先反例后规则）

| 反例 | 规则 | Fixture / 检查 |
|---|---|---|
| 中班儿童查看小班历史 | 个人页不按当前学段排除；证据阶段来自快照 | `middle-views-small-history` |
| 当前班级改学段不改变旧证据 | 动态 `classes.stage` 不回填；班级统计按快照阶段 | 同上 + 班级口径 `out_of_stage_evidence` |
| 一条有效 + 一条缺失/未确认/虚构引用 | 全部依据有效才计入，无 `.some()` | `mixed-basis-*`、`valid-and-unconfirmed-basis` |
| 跨儿童引用 | 依据必须同儿童 | `cross-child-basis` |
| 持续性证据跨学期仅一条在本期 | 全部依据在期间内才计入 | `sustained-cross-period`（本期排除 / 全部历史计入） |
| 目录版本不一致 | 保守排除，不默认兼容 | `catalog-version-mismatch` |
| 确认稿未来建议不能当证据 | 只允许 `highlight_quote` / `highlights` | `future-suggestion-not-evidence` |
| 没有 AI 建议仍能手动关联 | `origin=manual` 直接确认 | `manual-link-without-ai` |
| 一次归档及关联确认 | 确认接口 `guide_decisions` 同事务协调 | `CONTRACT_FIXTURE_CONFIRM_REQUEST` / `..._EXTENSION` |
| 教师操作依据已过期 | `expected_guide_revision` 不匹配 409 | `CONTRACT_FIXTURE_STALE_OPERATION` |
| 原文允许成人帮助的条目可确认表现 | `adult_help=allowed` + 说明帮助方式 | `adult-help-allowed-confirms-performance` |
| 要求独立完成的条目有成人帮助只确认线索 | `adult_help=requires_independence` | `adult-help-requires-independence-clue-only` + 决策校验 |
| NULL 兼容与损坏 JSON 不混为一谈 | NULL 正常；损坏/未知状态显式标识 | `null-evidence-is-normal`、`CORRUPTED_*` |
| 撤回信息、support、状态机一致 | 撤回保留 support 与撤回信息；拒绝 support=null | `withdrawn-keeps-history`、`rejected-not-counted` |
| 20 人 6/4/10 与重复记录去重 | 按儿童去重；待核对不计入 | `CLASS_20_FIXTURE` |

---

## 10. 共享文件归属与并行纪律

| 文件/模块 | 归属 | 内容 |
|---|---|---|
| `src/lib/guide/types.ts` | G0 | 冻结：目录、证据关联、学期、班级快照、产品规则 |
| `src/lib/guide/view-types.ts` | G0 | 冻结：DTO、状态、可靠性、通知、API 类型 |
| `src/lib/guide/__fixtures__/contract-fixtures.ts` | G0 | 契约 fixture（不写库、不调模型） |
| `scripts/check-guide-contract.ts` | G0 | 最小契约检查（参考算法，不替代 G5 运行时验证） |
| `docs/guide-evidence-v1/contract.md` | G0 | 本文件 |
| 目录数据与目录查询 | G1 | `listGuideItems` / `getGuideItem` / `listEducationSuggestions` |
| 历史、学期、schema、创建观察路径 | G2 | `SemesterPeriod` 配置、两个 JSONB 列、迁移 SQL、快照来源 |
| UI 组件与 surface brief | G3 / G4 | 仅各自组件与 brief，不改共享类型 |
| 证据业务、AI、确认路径、读模型 | G5 | `getChildEvidenceBook` / `getClassEvidenceOverview` / API |
| 正式页面接入与整合 | G6 | 页面装配 |

并行纪律：

- 冻结文件只由契约负责人修改；其他模块需要变更时先提接口问题，不私自改变契约。
- 不自动切换、合并或重置其他 agent 的分支；只提交自己负责的文件，保留正常提交历史。
- 不 push、不部署、不修改生产环境变量；不输出 `.env`、口令、API Key、完整连接串。
- 迁移 SQL 只能由 G2 在隔离本地 PostgreSQL/自建容器执行，禁止对托管库或线上库执行。
- 真实 LLM 预算已耗尽：G5 的 suggest 路径使用离线 invoke 替身；真实 provider 测试标记 `NOT_RUN`。
- 浏览器接口拦截只能证明 UI 状态，不能当作真实数据库或模型全链路验收。

---

## 11. Fixture 与最小检查

- Fixture：`src/lib/guide/__fixtures__/contract-fixtures.ts`
  - 目录 fixture 为最小示意（3 目标 / 4 条目），证明“目标数 ≠ 条目数”，不是正式目录；
  - 15 个反例场景覆盖：学段三分、依据全有效、跨儿童、跨期持续、目录版本、未来建议引用、
    手动关联、成人帮助双向、撤回/拒绝/待核对、NULL 与损坏 JSON、未知阶段；
  - 班级 fixture：20 名合成幼儿，**6 人表现 / 4 人线索 / 10 人无记录**，1 名儿童跨观察两条表现关联用于去重，
    1 名儿童待核对建议不计入，1 名 NULL 旧记录正常；
  - 操作 fixture：批量确认请求、观察确认扩展、过期令牌结构；
  - 全部为纯数据：不写数据库、不调用模型、不冒充真实 LLM 结果。
- 检查：`pnpm tsx scripts/check-guide-contract.ts`（离线，只读 fixture，输出 `reference_only: true`）
  - 参考算法忠实于本契约（依据全有效、版本严格、期间包含、阶段口径、成人帮助、可靠性），
    **明确不能替代 G5 的运行时验证**。

---

## 12. 验收与已知限制

本轮（G0-R1）离线验收：

- `pnpm ts-check` 通过；
- `pnpm tsx scripts/check-guide-contract.ts` 输出 `{ passed: 19, total: 19, reference_only: true }`；
- 契约、DTO、错误码、状态算法与 fixture 已同步（见 R1 修正清单与反例映射）。

`NOT_RUN`（本环境明确未执行，不得当作通过）：

- 真实 StepFun/Coze provider 调用：`NOT_RUN`（预算耗尽，禁止调用或重置账本）；
- 隔离实库迁移与读写：`NOT_RUN`（G0 不执行迁移、不改库）；
- 浏览器/UI 验收：`NOT_RUN`（G0 无页面交付）；
- 生产环境部署与环境变量变更：未执行且禁止。
