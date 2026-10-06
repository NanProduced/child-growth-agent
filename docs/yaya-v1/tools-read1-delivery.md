# TOOLS-READ1 交付：真实只读工具注册与授权读取（含 R1 来源协议返修）

2026-10-06。任务：实现芽芽助手的第一批**真实只读工具**——把现有平台读取能力封装为
可运行的 registry/dispatcher，供第二波 TOOLS1/AGENT-APP1 装配，不重新实现这些读取工具。

最终候选 SHA 见交付回复（本文件随候选提交落地）。起点：
`24b0588c07ce68968178660ba7dc1382292e8bdc`（**核心整合候选提交**，codex/yaya-api0 tip；
已批准的核心基线 `44d2303` 不受本轮影响）。分支 `codex/yaya-tools-read1`，
独立工作树，不从 main 开工、不修改其他工作树。

R1（主评审限定返修）只改结果投影、来源封装、两专属检查与文档，保留原 100/63 项覆盖，
不重写授权服务、不改冻结内核、不开始写工具。

## 1. 范围与不变式

独占交付（全部新增，未改既有文件）：

- `src/lib/yaya/tools/read/**`：types / ports / registry / index
- `scripts/yaya/check-tools-read.ts`：离线真实模块 + 替身端口检查（189 项）
- `scripts/yaya/check-tools-read-db.ts`：自有一次性 PostgreSQL 真实授权链检查（87 项）
- 本文件与 `docs/yaya-v1/tool-coverage.md` 的追加补列章节

未修改：API0 协议文件、冻结 `src/lib/yaya/types.ts` 与 AUTH/G0 冻结类型、
`src/lib/accounts/**`、业务 `src/lib/queries.ts`/routes、Agent/MEDIA 内核、schema、
`package.json`/`pnpm-lock.yaml`、`scripts/harness-safety.ts`
（blob 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`）。未创建 operations POST、
未执行任何写工具、未调用模型、未新增依赖。

核心不变量：**工具结果是数据，不是权限**。授权判定始终由现有服务端链路完成，
模型引用/工具来源不改变可读范围；`raw_text` 永不被本模块改写（本模块零写入）。

## 2. 导出签名

```ts
// src/lib/yaya/tools/read/index.ts
export { createYayaReadPorts } from './ports';
export { createYayaReadRegistry } from './registry';

export function createYayaReadRegistry(options?: { ports?: YayaReadPorts }): YayaReadRegistry;

export function createYayaReadPorts(): YayaReadPorts;

interface YayaReadRegistry {
  registrations: readonly YayaReadToolRegistration[];   // definition + auth 依赖
  definitions: readonly YayaReadToolDefinition[];       // 模型可见白名单（与引擎同类型）
  dispatch(
    input: { tool: string; params: unknown },
    context?: { request?: HeaderCarrier },
  ): Promise<YayaReadToolOutcome>;
  readTool(input: YayaReadToolInput): Promise<YayaReadToolOutcome>; // 引擎适配签名
}

interface YayaReadPayload<T> {
  tool: string;
  scope_policy: 'business_scope' | 'authenticated_reference';
  /** 唯一可引用来源：ref_id 非空、稳定、无隐私；=== outcome.source */
  citable_source: YayaSourceRef;
  /** 服务器重核依赖（含 citable_source，去重）；仅供 APP 重核，不是模型引用来源 */
  recheck_dependencies: readonly YayaSourceRef[];
  data: T;
}
```

`YayaReadPorts` 是数据与授权边界端口（`types.ts`）：默认实现直接调用现有
`scopedListChildren` / `scopedListClasses` / `withBusinessRead` + `getClass` /
`resolveClassContextAt` / `scopedListObservations` / `scopedGetObservation` /
`getChild` / `loadChildEvidenceBook` / `loadClassEvidenceOverview` / `listTeachers`，
测试注入替身；端口不允许用 0/空列表伪装失败。

## 3. 真实工具清单（13 个，全部有真实服务）

| 工具 | 真实服务出处 | 授权依赖 | scope_policy |
|---|---|---|---|
| `list_children` | `scopedListChildren` | `scope_query`（会话范围裁剪） | business_scope |
| `list_classes` | `scopedListClasses({catalog})` | `scope_query`；catalog=true 只给基础目录 | business_scope |
| `get_class` | `getClass` + `getClassChildren` + `getClassHistoryCounts`（同一 `withBusinessRead` 事务） | `class.read` / class | business_scope |
| `resolve_child_class` | `resolveClassContextAt`（分班历史唯一命中；异常/重叠不猜） | `child.read` / child | business_scope |
| `list_observations` | `scopedListObservations`（历史只读投影） | `scope_query` | business_scope |
| `get_observation` | `scopedGetObservation`（full / historical_read_only） | `observation.read` / observation | business_scope |
| `get_child_growth_profile` | `getChild`（`growth_profile` + `activity_support`） | `child.read` / child | business_scope |
| `get_child_evidence_book` | `loadChildEvidenceBook`（G5 读模型，零写入） | `child.read` / child | business_scope |
| `get_class_evidence_overview` | `loadClassEvidenceOverview`（G5 读模型，零写入） | `class.read` / class | business_scope |
| `list_guide_items` | `listGuideItems`（静态目录） | 登录且账号有效 | authenticated_reference |
| `get_guide_item` | `getGuideItem`（条目 + 目标教育建议） | 登录且账号有效 | authenticated_reference |
| `list_education_suggestions` | `listEducationSuggestions` + 目录目标存在性核验 | 登录且账号有效 | authenticated_reference |
| `list_teacher_accounts` | `listTeachers`（脱敏） | `teacher.manage` / school | business_scope |

未注册：任何生成/修改/删除、公网搜索、RAG、任意 URL/HTTP、SQL 或万能执行器；
没有真实服务的活动反馈/学期快照等仍不登记。

参数协议与校验同源：每个工具用 `zodToolParams(schema)`（引擎既有助手）从同一
Zod strict schema 导出模型可见 JSON Schema；dispatcher 用同一 schema 再校验一次。
`list_observations` 的 status 枚举取自 `OBSERVATION_STATUSES`，证据筛选枚举取自
`GUIDE_DOMAIN_CODES` / `GUIDE_AGE_BANDS`，日期用 `parseIsoDateStrict`，学期/范围
语义复用 `resolveEvidenceScope`（经 `loadChildEvidenceBook`）。

## 4. R1 来源协议

### 4.1 可引用主来源（citable_source）与重核依赖（recheck_dependencies）

- 每个工具（含列表/目录/管理员列表/合法空列表）都返回**非空、稳定、无隐私**的
  `citable_source.ref_id`；`outcome.source === payload.citable_source`，
  引擎把它登记进 knownSources，模型引用它即可正常回答。
- `recheck_dependencies` 含 citable_source（去重）与全部底层业务对象，
  **仅供 APP 按当前授权逐项重核**；其中未被引擎登记的 ID 不是可引用来源，
  模型引用会被既有 `source_mismatch` 守门保守拦截（引擎未改动）。
- 工具描述向模型显式声明该契约；payload 字段名区分两者。

列表类主来源 ID（稳定、无隐私）：

| 工具 | citable_source.ref_id |
|---|---|
| `list_children` | `children:current_scope` |
| `list_classes`（任教） | `classes:assigned` |
| `list_classes`（catalog=true） | `classes:catalog` |
| `list_observations` | `observations:current_scope` |
| `list_guide_items` | `guide_catalog:items` |
| `list_teacher_accounts` | `teacher_accounts:school` |

单对象/聚合工具沿用对象主来源：`child:<id>`、`class:<id>`、`observation:<id>`、
`guide_item:<id>`、`guide_goal:<id>`。依赖 ref_id 约定不变：
`child:` / `class:` / `observation:` / `guide_item:` / `guide_suggestion:` / `teacher:`。

### 4.2 观察来源分层（不把混合内容整体标为事实）

`get_observation` 的工具信封固定为 `tool_result`（不冒充 `child_fact`）；
结果内 `content_sources` 逐部分表达真实来源语义：

| 内容 | kind | 说明 |
|---|---|---|
| `raw_text` | `child_fact` | 已保存观察原文；label 区分“已确认观察原文”/“观察原文（未经确认，不能单独作为正式证据）”/“原班历史观察原文（只读投影）” |
| `confirmed_content` | `child_fact` | 教师确认内容；仅 confirmed 记录存在 |
| `ai_draft` | `model_text` | AI 整理草稿/未来建议，不是幼儿事实 |
| `workflow`（agent_context） | `tool_result` | 追问/教师复核工作流，平台数据 |
| `guide_evidence` | `tool_result` | 证据关联账本；正式证据仍需 G5 确认/版本核对 |

`formal_evidence_eligible` 复用冻结口径 `basisIsFormalEvidence`：只有
`confirmed` 且带 `confirmed_at` 的记录为 true；draft / needs_input /
ai_organized 一律 false，不强迫归档、不误隐藏合法内容。观察列表每条同样带
`status` 与 `formal_evidence_eligible`。证据册中的依据观察只有
`basis.valid && observation_status === 'confirmed'` 才以 `child_fact` 表达，
否则不冒充已核验事实。

### 4.3 成长小结/活动支持的依据重核依赖

`get_child_growth_profile` 把**实际返回内容**的依据观察并入
`recheck_dependencies`：成长小结 `source_observation_ids` 与活动支持
`source_observation_ids` 合并、去重；条目以
`observation:<id>`（`tool_result`，label 标注“未经本工具核验，须按当前授权重核”）
表达；缺失/坏来源仍保留在依赖列表，不伪造为已核验事实，也不隐藏。
`data` 中 `growth_profile.source = 'ai_summary' | 'fallback'`、
`activity_support.source = 'ai_summary'` 标注保留，并附 notes 说明。

**APP 装配状态**：本模块只发布依赖图与替身级重核检查；正式
AGENT-APP1 重核装配尚未开始（NOT_RUN），APP 必须按当前授权核这些依赖，
不能退化成只核幼儿或只比较 scope 数组。

## 5. 权限与边界实现

1. **不缓存 Principal**：每次工具调用都经 `withScopedRead`/`withBusinessRead`
   重新解析会话、账号状态与任教关系；`readTool` 收到的 `identity` 只作运行上下文，
   不参与授权判定。撤会话后同一 registry 立即返回 `unauthenticated`（隔离库实测）。
2. **空任教 ≠ 全园**：业务工具经 `requireBusinessPrincipal` 返回 `empty_scope`，
   不返回全园；管理员按 `school` 范围读取。
3. **静态教育参考**：`requireReferenceAccess` 只要求登录 + 账号 active，
   有效未分配账号可读；匿名/停用/身份不可用分别拒绝，不返回空目录。
4. **目录与名单/统计分离**：`list_classes catalog=true` 仅基础信息，无名单/统计；
   名单与历史计数需要 `class.read`。
5. **历史只读裁剪**：复用 `projectObservation` 的聊天契约投影（剥离
   `guide_evidence`/`agent_context`/`ai_draft`/模型元数据，`can_write=false`），
   `content_sources` 同步只暴露只读原文来源；列表只发索引，不发正文。
6. **失败与空态分离**：错误映射为 `unauthenticated` / `identity_unavailable` /
   `forbidden_role` / `out_of_scope` / `empty_scope` / `not_found` / `denied` /
   `failed`；真实空列表/空统计仍为 `ok:true`（含非空 citable_source），
   不填 0、不伪造统计。
7. **管理员边界**：教师列表按 `teacher.manage`/school 判定，教师显式
   `forbidden_role`；本模块不提供任何聊天/私有会话读取，管理员不自动获得他人聊天。
8. **候选不代选**：`resolve_child_class` 在多归属/无归属时返回
   `needs_confirmation` 与当前可读候选，不默认选第一个；不提供按姓名找人的工具，
   不扩大范围。

## 6. 验收

### 6.1 离线：真实模块 + 替身端口（`pnpm exec tsx scripts/yaya/check-tools-read.ts`）

`{"passed":189,"total":189}`。原 100 项全部保留，新增 R1 项覆盖：

- 13 个工具全部返回非空 citable_source、`outcome.source === citable_source`、
  `recheck_dependencies[0] === citable_source`；
- 列表主来源稳定（两次调用同 id）与合法空列表仍可引用、无伪造依赖；
- 观察四态（draft/needs_input/ai_organized/confirmed）的
  `formal_evidence_eligible` 与 raw_text label 对照，历史只读对照；
  `content_sources` 的 child_fact/model_text/tool_result 分层；
- 成长小结/活动支持依据不同、重复依据去重、缺失依据保留，
  APP 式重核替身能识别撤权依据（只核幼儿会漏掉）；
- 真实 registry + 真实引擎循环：列表/合法空列表/静态目录/管理员列表
  正向引用 citable_source 成功；引用依赖 ID 或任意 ID 均
  `stopped/source_mismatch`（守门保留）。

不连数据库、不读 `.env`、无网络。

### 6.2 隔离库：真实授权链（`pnpm exec tsx scripts/yaya/check-tools-read-db.ts`）

`{"passed":87,"total":87,"real_model_requests":0,"cleanup":"verified"}`。
一次性 PostgreSQL 容器（ID + 标签 + 回环端口 + 空库核验，按 ID/所有权清理）内
经真实 AUTH 会话 + scoped 读取验证：

- 正常：教师读任教班级幼儿/班级/观察/档案/证据册/概览；管理员全园读；
- 越权：跨班 `get_class`/档案/证据册/概览 `out_of_scope`；范围拒绝先于存在性；
- 空任教：`empty_scope`（不等于全园）；空班级真实空名单 `ok`；
- 撤会话：同一 registry 第二次读取 `unauthenticated`（无缓存身份）；
- 撤任教：`out_of_scope` 且列表收缩为剩余班级，不是错误也不是全园；
- 转班：原教师丢当前责任读（`out_of_scope`）、保留历史只读投影（私有工作流
  字段 `must-not-leak` 未泄漏、`content_sources` 只留只读原文）；新教师读完整记录；
- 管理员/教师差异：教师账号列表 `forbidden_role`，管理员脱敏列表无密码字段；
- 未分配教师读静态指南成功，匿名失败；
- R1 新增：观察信封 `tool_result`、确认/未确认的 `content_sources` 与
  `formal_evidence_eligible`、证据册依据 kind、成长档案依据观察进入重核依赖、
  列表主来源稳定；真实 registry + 真实引擎循环正向引用 `children:current_scope`
  成功，引用依赖 ID / 任意 ID 被 `source_mismatch` 拦截。

### 6.3 组合回归

`pnpm validate` 通过（tsc/eslint/stylelint）；`check-contract` 68/68、
`check-agent-engine` 29/29、`check-preflight` 15/15 复跑通过；
harness blob 未变。

### 6.4 NOT_RUN

真实模型/搜索/S3/托管库请求、正式聊天 API/运行接口装配、
**AGENT-APP1 正式依赖重核装配**、浏览器/Next HTTP、真实 provider 质量、
生产部署与安全认证。本模块未接入任何路由，也未调用模型。

## 7. 给 TOOLS1 / AGENT-APP1 的接续

- TOOLS1 聚合写工具时**不要重新实现**这些读取：直接消费
  `createYayaReadRegistry()` 的 `definitions` 与 `readTool`（或 `dispatch`），
  写工具另建 `write_tools` 目录；同一 `YayaToolCatalog` 组合。
- AGENT-APP1 装配 `readTool` 时把当前请求载体（Next headers）传入
  `dispatch(..., { request })`；默认实现会回退 `serverRequest()`。
- APP 重核按 §4：模型可引用来源只有 citable_source；`recheck_dependencies`
  是服务端重核图（含成长档案/活动支持的依据观察），必须按当前授权逐项核，
  不能只核幼儿或只比较 scope 数组。

## 8. 覆盖表补列

`docs/yaya-v1/tool-coverage.md` 追加“TOOLS-READ1 补列”：补 Q9（观察详情）、
Q10（成长档案与活动支持只读），并标注 Q1–Q10、A0 的真实只读实现位置。
