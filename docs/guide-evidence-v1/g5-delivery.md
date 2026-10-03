# G5 指南证据关联、教师决策、读模型与 API 交付说明

- 分支：`codex/g5-guide-evidence`
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g5`
- 基线：`b02e4a1284ac9423d5bffd3ab9436db12aeccf23`（G-INT1 候选整合 HEAD）
- 源码提交：`9b16b197687a5a976814d82af4ab00610120f366`
- 本记录提交：包含本文件的 `docs:` 提交
- 状态：后端证据业务（决策/校验/读模型/API）通过离线与隔离实库验收；**不等于正式页面闭环、真实模型质量或线上可部署**。

## 1. 文件清单

新增：

| 文件 | 职责 |
|---|---|
| `src/lib/guide/runtime.ts` | 运行时解析（NULL/损坏/未知状态/未知字段保留）、依据逐条核对、关联评估、个人/班级汇总、可靠性、变更视图 |
| `src/lib/guide/decisions.ts` | 教师决定（confirm/reject/withdraw）的写入校验与状态机、幂等比较、依据快照生成 |
| `src/lib/guide/suggest.ts` | AI 关联建议：候选选择、Prompt 分区、Zod 闸门、两次有限尝试、引用逐条核对 |
| `src/lib/guide/read-model.ts` | `ChildEvidenceBook` / `ClassEvidenceOverview` 纯构建器与 DB 装载器、筛选解析、通知 |
| `src/lib/guide/item-index.ts` | 从冻结目录构建的条目索引（G1 数据只读） |
| `src/app/api/observations/[id]/guide-evidence/route.ts` | `POST` 四 action |
| `src/app/api/children/[id]/evidence-book/route.ts` | 个人证据册 `GET` |
| `src/app/api/classes/[id]/evidence-overview/route.ts` | 班级概览 `GET` |
| `scripts/check-guide-evidence-runtime.ts` | 离线运行时检查（138 项） |
| `scripts/check-guide-evidence-routes.ts` | 路由离线检查（模块替身，20 项计数断言） |
| `scripts/check-guide-evidence-db.ts` | 隔离实库 + 真实 HTTP + 受控双连接交错（83 项） |

修改（最小接入）：

| 文件 | 变更 |
|---|---|
| `src/lib/validation.ts` | 新增 `guideEvidenceMutationSchema`、决定/依据/纪要 schema；`confirmObservationSchema` 增加可选 `guide_decisions` |
| `src/lib/queries.ts` | `listObservationsForChildren`（无 LIMIT）、`applyGuideEvidenceMutation(WithClient)`、`saveGuideEvidenceSuggestionResult`、`buildGuideResponseLinks`；`confirmObservation` 增加可选第 5 参数（同事务应用关联） |
| `src/lib/llm.ts` | 新增 `guide_evidence_suggestion` responseType 与 StepFun strict JSON Schema |
| `src/lib/ai.ts` | 仅 `extractJson` 导出（1 词改动，复用现有解析） |
| `src/app/api/observations/[id]/confirm/route.ts` | 归档路径传 `guide_decisions` 并在同事务应用；未归档路径返回 `guideEvidence.status="deferred"`；错误码映射 |

未修改：G0 冻结类型/契约/fixture、G1 目录数据与产品规则、G2 迁移 SQL 与学期配置、G3/G4 组件/样式/fixture、成长小结/活动支持/审核 Prompt。

## 2. 接口与状态转换

### 2.1 API

| 接口 | 方法 | 语义 |
|---|---|---|
| `/api/observations/[id]/guide-evidence` | POST | `action=suggest|confirm|reject|withdraw`；需教师身份；返回 `{observation_id, revision, links, notice?}` |
| `/api/children/[id]/evidence-book` | GET | 个人证据册 DTO；只读、零模型、零写入；无需口令 |
| `/api/classes/[id]/evidence-overview` | GET | 班级概览 DTO；同上 |
| `/api/observations/[id]/confirm` | POST | 可选 `guide_decisions`：归档与关联决定同事务；未归档路径 `deferred` |

错误：`400 invalid_request`、`401 unauthorized`、`404 not_found`（观察/`link_id`）、`409 state_conflict`、`409 catalog_version_mismatch`、`409 semester_config_missing`、`503 teacher_auth_disabled`、`500 server_error`；批量失败携带 `link_id`/`item_id` 定位。

### 2.2 状态机（实现口径）

```
ai_suggested ──→ confirmed_performance ──↔── confirmed_clue
      │                     │                      │
      ├──→ rejected         └──────→ withdrawn ←───┘
```

- `support=clue_only` → `confirmed_clue`；`single_event`/`sustained` → `confirmed_performance`。
- 持续性条目确认表现必须 `sustained`（跨日依据或覆盖全部依据的纪要）；`clue_only` 不受限。
- 成人帮助：`adult_help_used=true` 且确认表现必须填写帮助方式；条目 `requires_independence` 时有帮助只能确认线索。
- `rejected`/`withdrawn` 终态：不原地复活；合法重新手动关联创建新 link，旧审计保留。
- 拒绝理由写入 `teacher_note`、撤回理由写入 `withdrawn_reason`（不新增冻结类型字段）。

## 3. 事务、锁顺序、revision 与幂等

- 独立操作（`applyGuideEvidenceMutationWithClient`）：`BEGIN` → 读 `child_id` → `children FOR UPDATE` → `observations FOR UPDATE`（锁顺序 children → observations，与既有确认/保存一致）→ 事务内读取该儿童全部观察作为依据来源 → 全部决定先校验（准备阶段不修改数据）→ 应用 → `UPDATE observations SET guide_evidence=…, updated_at=… WHERE id=$1 AND guide_evidence IS NOT DISTINCT FROM $old` → `COMMIT`。
- 同事务归档（`confirmObservation` 第 5 参数）：锁儿童 → 核对既有前提（status/agent_context/ai_draft，语句与查询保持原样）→ 读 guide 容器 → 校验 `expected_guide_revision` → 事务内读取全部观察，把当前观察覆盖为“本次即将归档的 confirmed_content + 实际 confirmed_at” → 应用决定 → 单条 UPDATE 同时写入 `confirmed_content/confirmed_at/status='confirmed'/guide_evidence`。任一条失败整体回滚，不出现“已归档但关联失败”。
- 模型调用始终在事务外：suggest 先生成，再开事务重核前提与 revision。
- revision：容器 NULL 按 0；每次有效写入 +1；link 新建 revision=1，每次变化 +1。
- 幂等：结果内容（status、support、basis 五元组含 `source_confirmed_at` 时刻、sustained_note、adult_help_used、teacher_note/理由）完全一致时返回 200 且不增长 revision、不新增 link；内容不同或过期 revision 返回 409。时间戳比较按时刻（兼容 `+00:00` 与 `Z`）。
- 写入只触碰 `guide_evidence` 与 `updated_at`；不改写 `raw_text`、`ai_draft`、`confirmed_content`（独立操作）、`agent_context`、`status`。

## 4. AI 建议

- Prompt：系统提示 + 三分区用户消息【候选指南条目】【当前观察事实】【可用已确认依据】；观察与依据中的指令视为资料。
- 输出 Schema（StepFun strict JSON Schema，Zod 为最终闸门）：
  `{"suggestions":[{"item_id","reason","quote","quote_source":"raw_text|confirmed_content","quote_field":"highlight_quote|highlights|"}]}`；空字符串表示 `raw_text` 无位置。
- 服务端核对：item_id 必须来自候选；引用必须在来源观察的 raw_text 或确认稿 `highlight_quote`/`highlights` 中逐字可核对；理由不得含诊断/评分/排名定性词；重复 item_id 去重；最多 5 条。
- 失败语义：最多两次尝试，第二次携带具体原因；仍失败返回 `200 + notice.code="ai_link_failed"` 并记录 `last_attempt{ok:false,error}`；不保存模型原始输出；网络失败保留网络原因，不伪装为内容校验失败。
- 落库前重核：观察状态/原文/草稿/确认稿与容器 revision；已有任何关联（含拒绝/撤回历史）的条目不再追加；迟到建议冲突 409，不自动重放。
- 候选选择策略：优先观察主领域（`confirmed_content.domain` 或 `ai_draft.domain` 映射到领域 code）的全量条目，领域不可靠时取全目录；目录顺序稳定，上限 120 条，超出截断。**局限与遗漏风险**：单一主领域启发式可能漏掉跨领域条目；上限截断只影响提示候选，不影响教师手动关联任何目录条目；年龄与主领域只是参考，不是关联资格门槛。
- 本环境真实模型请求数为 0（全部注入替身）。

## 5. 读模型

- 个人页：加载该儿童**全部观察**（专用查询，无列表 LIMIT），按目录筛选（领域/参考年龄段/目标），逐条重新核对全部必需依据；历史不因当前升班或年龄变化排除；不产生百分比、等级或完成率。
- 班级页：名单来自当前有效分班关系（`end_date IS NULL`）并按幼儿去重；不使用 `children.class_name` 文本匹配；同学段判断只用 `class_context_snapshot.stage`；NULL 快照按 `history_unknown` 显式排除且降可靠性；转走幼儿不进入分母；转入前同学段有效依据纳入并保留来源说明。
- 可靠性：NULL/正常未关联为 reliable；部分损坏、未知状态、目录版本不一致、失效依据、支持条件不足、阶段未知为 partial；全部不可读才 unavailable；期间与阶段口径排除不降可靠性。一名幼儿不可读不会把整个班级机械判 unavailable。
- 占比：仅班级行为统计条目且 reliability=reliable、total>0 时给出；partial/unavailable、保健参考、分母 0 时为 null。
- 通知：`guide_evidence_unreadable`、`unknown_link_status`、`catalog_version_mismatch`、`item_not_in_catalog`、`basis_invalid`、`basis_expired`、`ai_link_failed`、`history_unknown`、`out_of_stage_evidence`、`empty_roster`、`empty_evidence`。
- 读调用零模型、零写入；数据库失败返回 5xx，不包装成普通空态。

## 6. 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm validate`（tsc + eslint + stylelint） | 通过（exit 0） |
| `pnpm build`（Next build + tsup） | 通过（exit 0） |
| G0 `check-guide-contract.ts` | 19/19 |
| G1 `check-guide-catalog.ts` | 11/11（5 领域/11 子领域/32 目标/317 条目/87 建议；health_reference=3、sustained=27、requires_independence=20） |
| G2 `check-history-semester.ts` | 33/33；自有容器 `13d23da6ef80`（run `1fvcmuslkaoi`）按 ID+标签清理 |
| G3 fixture `check-child-evidence-book-fixtures.ts` | 63/63 |
| G4 fixture `check-class-evidence-overview.ts` | 42/42 |
| **G5 离线运行时** `check-guide-evidence-runtime.ts` | **138/138**（无 DB、无模型） |
| **G5 路由离线** `check-guide-evidence-routes.ts` | **20/20**（node:test 模块替身；覆盖 applied/deferred/回滚/小结失败不连带/错误映射/GET 零调用） |
| **G5 隔离实库 + HTTP** `check-guide-evidence-db.ts` | **83/83**（direct 67、http 16）；受控双连接交错为真实行锁竞争；`real_model_requests: 0` |
| 回归 agent-flow / organize-retry / growth-profile / activity-support / teacher-clarify / save-consistency / class-reports-pages | 30/30、9/9、13/13、19/19、13/13、24/24、11/11 |
| 回归 homepage-map | 通过 |
| `check-classes.ts` | **NOT_RUN**（危险测试装置，未修未跑） |

隔离实库身份与清理（G5 自检）：一次性本地 Docker Postgres，容器标签 `cga-g5-check=<run>`；写入前核验容器 ID/标签、回环端口映射、`current_database/current_user/inet_server_port` 与空库；清理仅按已核实容器 ID + 标签所有权执行并验证；运行后复查无 `cga-g5-*` 残留、既有 `zzsh-*` 容器未被触碰；未连接 `.env` 托管库；未输出连接串/口令。

反例覆盖（与任务清单对应）：无 AI 手动关联、无效依据整批失败、真实片段/片段+编造、确认稿两个允许位置与三类禁止位置、来源日期/版本变化失效、持续证据跨期、成人帮助双路径、纪要非法日期/短说明/未覆盖、reject/withdraw 历史与终态、重复幂等与内容冲突/过期 409、双连接并发最多一个不同结果成功、迟到 suggest 不覆盖决定、同事务归档与回滚、deferred、小结失败不回滚、NULL/坏 JSON/未知状态/旧版本、中班回看小班、20 人 6/4/10 去重与待核对不计入、partial/unavailable 占比 null、保健参考与空名单、可靠空态、筛选解除恢复、>1000 条不截断、无身份/跨观察 link_id/未知 item_id、suggest 空结果/非法 ID/虚构引用/注入/两次失败/失败保留旧关联。

## 7. G6 接入说明

```ts
// 读模型（服务端）：返回判别式结果，路由/页面按 failure.status 映射
import { loadChildEvidenceBook, loadClassEvidenceOverview } from "@/lib/guide/read-model";
const result = await loadChildEvidenceBook(childId, {
  scope, semester_id, from, to, domain, age_band, goal_id,
}); // { ok: true, value: ChildEvidenceBook } | { ok: false, failure: {status,error,message} }

// 组件（G3/G4 已验收，G6 直接装配）
import { ChildEvidenceBook } from "@/components/guide/child-evidence-book";
import { ClassEvidenceOverview } from "@/components/guide/class-evidence-overview";
// Props：book/overview + semesters?(G2 listSemesters()) + onScopeChange/onFiltersChange/onOpenChildItem/onRecordObservation...
```

请求/响应示例（真实 HTTP 已验证）：

```http
POST /api/observations/{obsId}/guide-evidence
Cookie: cga_teacher=…
{"action":"confirm","expected_guide_revision":0,
 "decisions":[{"item_id":"item.moe.language.listening_speaking.1.3-4.1","support":"clue_only",
   "basis":[{"observation_id":"{obsId}","quote":"请你先玩。","quote_source":"raw_text"}]}]}
→ 200 {"observation_id":"…","revision":1,"links":[{"link_id":"…","status":"confirmed_clue",
   "counts_toward_status":true,"excluded_reason":null,"basis":[{"valid":true,"invalid_reason":null,…}]}]}
```

```http
GET /api/children/{childId}/evidence-book?scope=all_history&domain=language
→ 200 ChildEvidenceBook（catalog/scope/filters/status_counts/goals[].items[]/notices）
```

归档 + 关联：

```json
POST /api/observations/{id}/confirm
{"content":{…},"guide_decisions":{"expected_guide_revision":0,"decisions":[…]}}
→ 200 {"observation":{…,"status":"confirmed"},"guideEvidence":{"status":"applied","revision":1,"links":[…]},"profileUpdateStatus":"updated"}
```

未归档（accept/clarify/review）路径：`guideEvidence:{"status":"deferred"}`，客户端在最终归档请求重试。

## 8. NOT_RUN 与剩余风险

- **NOT_RUN**：G6 正式页面装配与 URL 状态、真实 StepFun/Coze 质量验收（预算耗尽，未调用未重置）、托管库迁移与线上读写、部署；`check-classes.ts` 危险装置未运行。
- 浏览器端 G3/G4 装置本轮未重跑（fixture 检查通过；组件与 fixture 未修改）。
- 剩余风险：AI 候选选择为单领域启发式，跨领域建议可能遗漏（教师可手动关联任意条目）；`adult_help_used` 为契约可选字段，未提交时按 false 记录（字段语义为“本次决定是否使用帮助”，AI 建议不参与正式状态）；损坏容器的可靠性口径与 G0 参考算法一致（全部容器损坏才 unavailable）。
- 验收结论分层：后端证据业务通过 ≠ 正式页面闭环通过 ≠ 真实模型质量通过 ≠ 线上可部署。
