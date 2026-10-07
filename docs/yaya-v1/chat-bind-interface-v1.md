# 芽芽 v1 聊天可信绑定与恢复标记接口（chat-bind-interface-v1）

2026-10-07，YAYA-CHAT-BIND0。起点 `b8bf68313e0ac7b1afbf6589ae9e590e50d71153`，独立分支 `codex/yaya-chat-bind0`。
只读参考（**不因此获批，不合并，不抢写其 runtime**）：UI1 `3455d9fd99f5610a033e8965606b7f2870ee6c94`、
APP1 当前候选 `62cc3b784d5cb06764e605f3432229e6412a761e`、TOOLS1 当前候选 `499fc923659e59d2d5b9dc503648c01d50dca7d0`。

状态：`reference_only`。本轮只交**最小接口声明、兼容规则与可运行反例**；不是架构研究，不是新审批系统，不是运行时实现。

CHAT-BIND0-R1（2026-10-07）：按主评审 `C:/Users/nanpr/AppData/Local/Temp/opencode/yaya-chat-bind0-review-20261007/REVIEW.md` 返修 —— 关闭 3 个 P1（混合依赖漏守门 / 回执本体未核验 / 重复矛盾依赖顺序）与 1 个 P2（opaque 身份未按路径编码），并收紧文档（唯一写入 owner ≠ 幂等落账）。**协议本轮不冻结，D1–D6 未因任何报告获得实施批准。**

- 纯协议模块：`src/lib/yaya/chat-bind-contract.ts`（browser-safe，只复用已发布类型 / API0 / DATA 判定，不 fork 同名 DTO）
- 反例检查：`scripts/yaya/check-chat-bind.ts` —— `pnpm exec tsx scripts/yaya/check-chat-bind.ts`（19 项，`reference_only:true`）
- `RTK.md` 不存在（记录，不创建、不安装）；`scripts/harness-safety.ts` blob 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`
- 本轮不使用真实模型额度（留给后续联合 smoke）；不连托管库、不发真实 HTTP、不操作 main / 不 push / 不部署

**落地边界**：APP 现有返修获批后，由 AGENT-APP1 唯一 owner 在获批 SHA 上落实服务端绑定；本任务**不宣称**运行时漏洞已关闭。

## 0. 两个接口缺口与最小关闭方式

| 缺口 | 现状（被测 SHA） | 最小关闭方式 |
|---|---|---|
| 私域答案持久化后绕过投影 | 助手消息由客户端落库，`sources:[]` + `independently_readable:true` 自报；投影对空来源直接 `full` | 助手消息唯一服务端写入 owner + 服务端来源绑定 + 读侧兜底降级 |
| 历史丢失原身份 | `client_request_id` / `run_id` / `proposal_id` / `operation_id` 只在内存或正文里，重载即失 | 服务端投影的浏览器安全恢复标记（只够重新 GET，不是批准） |

## 1. 现状证据（file:line，均取自对应 SHA 的 blob）

### 1.1 助手消息的写入方是客户端，且来源是自报的

- UI1 `3455d9f`：历史 adapter 的 `append()` 是唯一写入路径，user / assistant 共用同一个 POST —— `src/components/yaya/client/adapters.ts:342`（`save`）、`:362-363`（`client_message_id` / `role`）、`:408`（`append`）。
- 同一 SHA：落库形状 `summaryFragment()` 硬编码 `sources: []`（`mapping.ts:37,46`）与 `independently_readable: true`（`mapping.ts:47`）；运行事件里的真实来源在持久化时被丢弃，只在展示时读 `answer` 事件的 `sources`。
- 基线 `b8bf683`：`POST /api/yaya/conversations/{id}/messages` 接受 `user|assistant|tool`（`src/app/api/yaya/conversations/[id]/messages/route.ts:12`），并把请求体里的 `fragments` 原样交给 `saveMessage`（`:73-96`）。
- APP1 候选 `62cc3b7`：`git grep saveMessage -- src/lib/yaya/agent` 为空；交付文档自述“运行不代 UI 保存消息”（`docs/yaya-v1/agent-app1-delivery.md:143`）。=> **当前没有任何服务端助手消息写入**，也没有防重复的第二写入方。

### 1.2 run 的累计依赖、终态与 DATA 消息投影之间没有绑定

- run 侧（APP1 候选）：`YayaRunDependency`（`runtime/store.ts:35`）、`YayaRunRecord.dependencies` / `dependencies_corrupt`（`store.ts:44,57,59`）、只增不覆盖的持久化（`store.ts:360,383` `UPDATE yaya_runs SET dependencies = ...`）、DDL `scripts/upgrade-yaya-runs-v1.sql`（`outcome` / `dependencies` 两列）。
- 数据侧（基线）：`yaya_messages` 无 run / 绑定字段（`src/storage/database/shared/schema.ts:278-307`，无 `run_id` / binding），`git grep run_id -- src/lib/yaya/data` 为空。
- 结论：run 记录里有累计依赖与终态，消息行里没有指向它的绑定，两端只能靠客户端“记得住”联系。

### 1.3 为什么空来源会绕过投影

- `projectFragment`：`accesses.length === 0` ⇒ `visibility: "full", reason: "ok"`（`src/lib/yaya/types.ts:1210-1212`）。
- 正文与 provenance 都只在 `full` 时输出：`projectStoredMessageText`（`src/lib/yaya/data/invariants.ts:193`）、`redactProvenanceForVisibility`（`invariants.ts:386-390`）。
- 即：**来源为空 ⇒ 正文与 provenance 全量可读**。私域答案只要以 `sources:[]` 落库，后续撤权 / 转班 / 重投影都无从限制它。

### 1.4 历史恢复缺原身份

- run 查询五态与 owner 绑定已就绪：`YayaRunLookupResponse`（`src/lib/yaya/api-contract.ts:369-375`）、`classifyYayaRunLookup`（`:414-430`）；APP1 候选按 `owner + conversation + client_request_id` 查行（`runtime/service.ts:423-446`），终态不可展示时返回 `outcome:null` ⇒ `terminal_unreadable`（`service.ts:193,434-460`）。
- 操作查询按原身份 + actor 过滤（`src/lib/yaya/data/operations.ts:101,108,115,122`），HTTP 只读（`src/app/api/yaya/operations/route.ts:7,14,21`）。
- 缺口只剩：**消息历史里没有可机读的原身份**，浏览器重载后无从发起这两类 GET。

## 2. 接口一：可信来源绑定

### 2.1 字段与方法（`src/lib/yaya/chat-bind-contract.ts`）

| 名称 | 形态 | 语义 |
|---|---|---|
| `authorizeYayaMessageWrite({channel, role})` | 方法 | 唯一写入 owner 的**能力边界**：`http` 只放行 `user`（writer `UI1`）；`run_terminal` 只放行 `assistant` / `tool`（writer `AGENT-APP1`）。同一角色最多一个通道放行；**不等于**“重复落账在协议层不可能”——同一允许通道仍可被调用两次，幂等见 §2.4 |
| `YAYA_ASSISTANT_MESSAGE_WRITER` | 常量 | `"AGENT-APP1"` |
| `buildYayaRunSourceBinding(input)` | 方法 | run 记录 → 绑定：`resource_dependencies: YayaMessageSourceRef[] \| null`（`null` = 无法完整核验）；`unmapped_dependency_count`（无法表达为资源级来源的依赖条目，必须是有限非负整数）；`private_dependency_proven_absent`（服务端已证明整段无私域依赖）。**任一依赖条目未映射 / 计数非法 ⇒ `unknown`（整段）**；**模型最终引用不是入参**：引用不作依赖，也不因缺引用缩小依赖 |
| `YayaRunSourceBinding` | 类型 | `{state:"bound", dependencies, general_qa_proven} \| {state:"unknown"}` |
| `resolveYayaAssistantFragmentPolicy(binding)` | 方法 | 整段答案继承 `dependencies`；`independently_readable = general_qa_proven && dependencies.length === 0`；`unknown` ⇒ `sources:[]` + `independently_readable:false` |
| `restrictYayaAssistantProjection(projection, {role, policy})` | 方法 | 读侧兜底：非 `user` 且（绑定未知 或 “无来源且未证明独立”）⇒ 片段 `hidden/source_unavailable`、消息 `visibility:"unavailable"`；正文 / provenance 由 DATA1 现有函数按非 full 置空，派生标题随之回退通用标题；附件不动（继续 MEDIA/DATA 边界）；幂等 |

### 2.2 责任表（字段 / 方法 / 路径 / owner）

| 事项 | 字段 / 方法 / 路径 | Owner | 说明 |
|---|---|---|---|
| 助手消息唯一落账 | `authorizeYayaMessageWrite`、run 终态写入（内部入口，不经 HTTP） | **AGENT-APP1** | 落账内容、run 绑定、依赖继承都在这一步完成 |
| 现有消息写入口 | `POST /api/yaya/conversations/{id}/messages`、`saveMessage` | **DATA1** | HTTP 只写 `user`；助手 / 工具角色由服务端内部入口写 |
| 绑定派生 | `buildYayaRunSourceBinding`（输入来自 `yaya_runs.dependencies` / `outcome`） | **AGENT-APP1** | 依赖不可完整核验 ⇒ `unknown`，不降级为可信 |
| 存储绑定字段 | 消息行 `binding_state ∈ {bound, unknown}`（物理列 / 是否冗余存 `run_id` 归 DATA1） | **DATA1** | 唯一 schema owner；旧行 = `unknown`，不回填 |
| 读投影接线 | `restrictYayaAssistantProjection` 插在 `projectChatMessage` 之后、`projectStoredMessageText` 之前（`src/lib/yaya/data/projection.ts:98-104`） | **DATA1** | 同一处接线同时覆盖正文、provenance、派生标题 |
| 消费与渲染 | 只渲染服务端投影结果，不再为 assistant 角色 POST | **UI1** | `client_request_id` 等身份交给恢复标记 |
| 附件 / 来源授权 | `evaluateAttachmentAccess` / `evaluateFragmentSources` / `decideImageReadAccess` | DATA1 / MEDIA1（现接口） | 不改 |

### 2.3 绑定与投影规则（收敛口径）

1. 落库的 `fragments[].sources` **只能**来自服务端 run 绑定；客户端自报 `sources` / `independently_readable`、模型最终引用（`outcome.sources`）都不作为可信完整依赖。
2. 优先整段答案继承服务端已知依赖；不能证明独立的部分保守受限（`independently_readable:false`）。不引入 NLP 语义切片、不引入逐 token 来源。
3. 一般教育问答只有服务端能证明**整段无私域依赖**（依赖集合为空且无未映射依赖）时才独立可读。
4. 来源撤权、转班降级、损坏、失联或无法完整核验 ⇒ 正文、派生标题、provenance 一并受限，不成为泄漏旁路。
5. 旧消息缺可信绑定保持 `unknown` / 受限，**不回填为可信**。
6. **混合依赖整段判定（R1）**：依赖集合里只要有一条无法映射 / 无法完整核验（图片、历史片段、工具引用等），整段绑定即 `unknown`；已映射的可读来源**不能**让混合集合保持 `bound`，`independently_readable:false` 也**不能**替代依赖完整性。

### 2.4 唯一写入 owner 的能力边界：幂等与原子提交（R1 收紧）

`authorizeYayaMessageWrite` 只证明“同一角色最多一个通道放行”，这是**能力边界**，不是幂等保证：
同一允许通道仍可被调用两次，协议层**不宣称**重复落账不可能。
下列约束由 D2 / D3 / D6 承担，本轮只声明要求，**不实现、不连库、不新建消息账本**：

| 约束 | 精确要求 | 落点（等获批） |
|---|---|---|
| 确定性消息身份 | 助手 / 工具消息的 `client_message_id`（或等价消息身份）由**原 run 确定性派生**（如由 `run_id` 派生），不由调用方自造随机值 | AGENT-APP1（D6） |
| 同事务提交 | **run 终态、助手消息行、绑定字段 / 恢复标记**必须由同一 client 原子提交；故障回滚不得留下“终态已写、消息未写”或反之的半行 | AGENT-APP1 + DATA1（D2/D3/D6） |
| 复用现有消息幂等 | 复用 `yaya_messages_client_id_unique`（`conversation_id, client_message_id` 部分唯一索引）与 `resolveClientMessageReplay`（`src/lib/yaya/data/invariants.ts:150-156`，`messages.ts:88-104`）：**同身份同内容返回原结果（replay），异内容 `409 idempotency_conflict`** | DATA1（D2/D3） |
| 受控竞争 | 同一 run 的并发终态写入由 DB 唯一约束 / 条件更新裁决，不由本协议层判定 | AGENT-APP1 + DATA1 实现后验证 |
| 验证时机 | 故障回滚与受控竞争属于真实 HTTP + DB 验收项，须由 APP/DATA 在获批 SHA 实现后按 `AGENTS.md` “写接口必须实际 curl 走一遍”验证 | 本轮 NOT_RUN |

## 3. 接口二：原身份恢复标记

### 3.1 字段（服务端投影 → 浏览器）

```jsonc
{
  "mark": "yaya-recovery-v1",
  "conversation_id": "conv-1",
  "owner_account_id": "acc-owner",      // 只用于身份核对，owner 先于角色
  "actor_account_id": "acc-teacher",    // 回执核验所需提交者身份（服务端填）
  "run": { "run_id": "run-1", "client_request_id": "req-1" },   // 或 null
  "proposal": { "proposal_id": "prop-1", "batch_id": "batch-1" }, // 或 null
  "operations": [
    { "operation_id": "op-1", "item_key": "item-1", "target_id": "obs-1",
      "content_digest": "<64 hex>" }
  ]
}
```

- 不是批准：不含会话令牌、密码、客户端 Principal / 角色 / scope；`parseYayaChatRecoveryMark` 用严格对象拒绝 `principal` / `role` / `approved` / `scope` 等未知字段，秘密字段扫描复用 API0 `findSecretFields`。
- 完整回执核验身份 = `YayaPlannedOperation` 六元（`batch_id` / `proposal_id` / `item_key` / `operation_id` / `target_id` / `actor_account_id`，`src/lib/yaya/types.ts:799-806`）+ 条目 `content_digest`；与 `receiptIdentifiesPlan`（`types.ts:863-874`）逐字段一致。

### 3.2 判定方法

| 方法 | 输出 | 语义 |
|---|---|---|
| `parseYayaChatRecoveryMark(input)` | `YayaApiParseResult` | 结构核验；无授权语义；**`operation_id` / `item_key` 必须唯一**（R1），重复即 `malformed_request` |
| `verifyYayaRecoveryIdentity(mark, facts)` | `{verifiable:true, outcomes} \| {verifiable:false, reason}` | 核验顺序固定：owner → conversation → run → 标记身份唯一 → operation → actor → target → content → 回执本体 → 矛盾回执。**没有 role 入参**（owner 先于角色）；任一不一致即不可核验；只返回原查询结论，不新建任何身份 |
| `yayaRecoveryLookupRequests(mark)` | `{method:"GET", path, query}[]` | 只派生历史 GET、原运行 GET、提案投影 GET、逐原操作 GET；模板直接引用 `YAYA_API_PATHS.run_lookup` / `operations_query`（proposals 为冻结 `approval` 路径的父路径，由检查锁定），不 fork 路径 |

**事实形状与回执核验（R1 收紧）**：`YayaRecoveryOperationFacts = { planned, content_digest, receipts[] }` ——
事实只提供**身份与回执本体**，不自带结论；`verifyYayaRecoveryIdentity` 的处理顺序：

1. 原计划（`YayaPlannedOperation` 六元）**只由标记派生**，不从回执 / 事实反建 expected（调用方不能自证）；
2. 同 `operation_id` 的事实先分组，组内**每一条**都与标记核对，矛盾即拒绝且**与遍历顺序无关**（多原因按原因枚举固定次序取最优先）；
3. 组内回执合并后交冻结 `queryOperationOutcome(receipts, expected)` **重算**，事实里自带的 `outcome` 不采信：
   - `unknown/identity_mismatch` ⇒ `unverifiable`，并按回执字段精确诊断为 `actor_mismatch` / `target_mismatch` / `operation_mismatch`；
   - `unknown/contradictory_receipts` ⇒ `unverifiable(contradictory_receipt)`；
   - `unknown/invalid_success_proof` / `no_receipt` / `verification_required` 与 `in_progress` / `failed` / `conflict` / `saved` / `saved_detail_unavailable` / `unchanged` **按冻结语义原样返回**（不新增第六种 run 状态）；
4. 完全相同的重复事实 / 重复回执（合法幂等重放）规范为**一个结果**，不产生重复成功；标记内 `operation_id` / `item_key` 重复直接不可核验。

不可核验原因枚举 `YAYA_RECOVERY_UNVERIFIABLE_REASONS`：
`owner_mismatch` / `conversation_mismatch` / `run_missing` / `run_mismatch` /
`operation_missing` / `operation_mismatch` / `actor_mismatch` / `target_mismatch` /
`content_mismatch` / `contradictory_receipt`。

状态结论一律复用现有接口，不新增状态机：

| 需求 | 复用 |
|---|---|
| 原运行 unknown / executing / 查无 / 查询失败 | API0 五态 `missing \| in_progress \| finished \| unverifiable \| service_failure`（`api-contract.ts:369-375`） |
| finished 返回当前可读终态 | `classifyYayaRunLookup` 只在终态可读时给 `outcome`，不可读 ⇒ `unverifiable/terminal_unreadable` |
| 保存详情不可读 vs 未保存 | `queryOperationOutcome`：`saved_detail_unavailable` ≠ `unknown/no_receipt`（`types.ts:1020-1075`） |
| 错回执身份 / 矛盾回执 | `queryOperationOutcome` → `unknown/identity_mismatch` / `contradictory_receipts` |
| 未知只查原身份 | 只 GET 原 `operation_id`；协议不自动重发 POST |

### 3.3 路径与方法（只读）

| 方法 | 路径 | 用途 | Owner |
|---|---|---|---|
| GET | `/api/yaya/conversations/{conversation_id}/messages` | 历史当前投影 | DATA1 |
| GET | `/api/yaya/conversations/{conversation_id}/runs?client_request_id=...` | 原运行五态 | AGENT-APP1 |
| GET | `/api/yaya/proposals?proposal_id=...` | 提案投影（pending proposal-only 消息恢复可核对内容；route 已存在：`src/app/api/yaya/proposals/route.ts` GET 按 `proposal_id` 单条读 + `withPrivateRead` owner 过滤） | DATA1 |
| GET | `/api/yaya/operations?operation_id=...` | 原操作回执结论 | DATA1 |

（`operations` 的 GET / POST 共用路径，方法是唯一区分：本清单硬编码 `method:"GET"`；不派生 `run_start` / `operations_execute` / `approval` / `run_cancel`。）

**编码规则（R1 / P2）**：路径变量用 `encodeURIComponent` 编码后再入 path（保留字符 `/ ? # %` 不得改变目标路径，且解码可完整还原原身份、不删字符）；`query` 保持**独立参数原值**，由消费方用 `URLSearchParams` 拼接，不在模板层拼接字符串。

**提案投影恢复责任（R1）**：恢复清单按 `mark.proposal.proposal_id` 派生 `GET /api/yaya/proposals?proposal_id=...`，
UI1 已有 `fetchProposalProjection`（`src/components/yaya/client/actions.ts:32-40`）可直接消费；
即“保留 ID”必须落到**可读取的提案投影入口**，而不是只把 `proposal_id` 存着。

### 3.4 责任表

| 事项 | 字段 / 方法 / 路径 | Owner |
|---|---|---|
| 标记投影到消息视图 | `YayaProjectedMessageView.recovery: YayaChatRecoveryMark \| null` | DATA1（DTO / 路由），身份取值依赖 AGENT-APP1 的 run 记录与 DATA1 的回执账本 |
| 身份事实提供 | `YayaRecoveryFacts`（owner / conversation / run / 每条 `planned` + `content_digest` + **`receipts[]` 回执本体**，不自带结论） | DATA1（操作事实与回执）+ AGENT-APP1（run 事实） |
| 核验与渲染 | `verifyYayaRecoveryIdentity`、`yayaRecoveryLookupRequests` | UI1 消费（只读），服务端仍各自独立做 owner 过滤 |
| 提案投影恢复 | `GET /api/yaya/proposals?proposal_id=...`（清单派生）+ UI1 现有 `fetchProposalProjection` | DATA1（route，已存在）+ UI1（读取渲染） |
| 批准 / 执行 | `POST /proposals/{id}/approval`、`POST /operations` | DATA1 / TOOLS1（不变，本接口不触碰） |

## 4. 兼容规则（旧客户端 / 旧记录）

1. **旧记录（无绑定）**：`binding_state=unknown` ⇒ assistant / tool 正文片段 `hidden/source_unavailable`、消息 `visibility:"unavailable"`；正文与 provenance 走现有“非 full 置空”规则；派生标题回退通用标题；附件与来源仍按 MEDIA/DATA 当前投影。不回填、不改写、不删除。
2. **旧客户端仍 POST assistant / tool**：`400 invalid_request`（“助手消息由服务端写入”）。UI1 需同步收敛：只 POST `user`，助手消息由 `GET .../messages` 读回（UI1-R1 收敛项，不在本任务实现）。
3. **旧客户端只在内存里存 run / 操作身份**：重载后无标记 ⇒ 走“身份缺失”只读路径（历史 + 不可恢复提示），不重发、不新建身份；有标记的服务端消息即可恢复只读查询（历史 / 原运行 / 提案投影 / 原操作）。
4. **user 消息不受影响**：原输入属于 owner 本人，无 run 绑定，不因绑定缺失被降级（`restrictYayaAssistantProjection` 对 `role==="user"` 直接返回原投影）。
5. **标记是增量字段**：旧消息 `recovery:null` ⇒ 只能读当前投影，不提供 run / proposal / operation 恢复入口；标记结构变化必须走本文件的差异流程。

## 5. 精确差异清单（唯一 owner，**等主评审确认**）

本轮**未修改**任何冻结 / 已发布接口。以下为落地必需的精确差异，未经确认不得实施：

| # | 文件 / 接口 | 精确差异 | 唯一 owner | 兼容规则 |
|---|---|---|---|---|
| D1 | `POST /api/yaya/conversations/{id}/messages`（`route.ts:12,88-99`） | `role ∈ {assistant, tool}` 拒绝，改为 `400 invalid_request`；`user` 行为不变 | DATA1 | §4.2（旧客户端助手 POST 失败，UI1 改为读回） |
| D2 | `YayaSaveMessageInput`（`storage-types.ts:325-335`） | 增加服务端绑定入参（`run_id` / `binding_state` / 服务端派生的 `sources`），HTTP 入口不得携带；**同一次写入必须与 run 终态、绑定字段 / 恢复标记同一 client 原子提交**（§2.4） | DATA1 | HTTP 请求体不新增字段，旧请求形状不变 |
| D3 | `yaya_messages`（`schema.ts:278-307`） | 增加绑定字段（物理列名归 DATA1），旧行读为 `unknown`；**复用 `yaya_messages_client_id_unique` 与 `resolveClientMessageReplay`：同身份同内容 replay 返回原结果、异内容 `409`**（§2.4，不新建消息账本） | DATA1（唯一 schema owner） | §4.1，不回填 |
| D4 | `YayaProjectedMessageView`（`storage-types.ts:309-323`） | 增加 `recovery: YayaChatRecoveryMark \| null`（新类型，不同名，不 fork） | DATA1 | 增量字段，旧消费方忽略即可 |
| D5 | `projectMessageRow` / `projectFragments`（`projection.ts:98-104`） | 在 `projectChatMessage` 之后调用 `restrictYayaAssistantProjection` | DATA1 | §4.1 / §4.4 |
| D6 | 助手消息写入时序 | run 终态落账助手消息 + 绑定（内部入口，不经 HTTP）；**`client_message_id` 由原 run 确定性派生**；终态、消息、绑定 / 标记同一事务提交，故障回滚不留半行，并发由 DB 约束裁决（§2.4） | AGENT-APP1 | §4.2 |
| D7（可选） | `api-contract.ts` | 导出内部 `parseWith` 供复用（本轮未改，模块内自带最小解析） | YAYA-API0 | 纯重构，无协议变化 |

**零修改**：AUTH 冻结（`src/lib/accounts/**`）、G0 冻结（`src/lib/guide/**`）、`src/lib/yaya/types.ts`、`src/lib/yaya/api-contract.ts`、PRODUCT / DESIGN、依赖锁、`.env`；不新增第二状态库、审批系统、万能工具或重复认证逻辑。

## 6. 反例清单（`scripts/yaya/check-chat-bind.ts` 实际覆盖，19 项；1–14 为原组，15–19 为 R1 新增）

| # | 反例 | 判定 |
|---|---|---|
| 1 | 私域答案丢来源（客户端落 `sources:[]` / `independently_readable:true`，run 依赖含幼儿） | 依赖被继承；撤权后 `hidden`，兜底后 `unavailable`，正文与 provenance 置空 |
| 2 | 只给模型引用但漏依赖（`resource_dependencies:null`；或资源依赖空但存在未映射依赖） | `unknown` ⇒ 不独立可读、不补可信来源（R1：未映射 ⇒ 整段 `unknown`） |
| 3 | 一般问答正向对照（依赖空 + 服务端证明无私域依赖） | `bound` + `independently_readable:true`，投影仍 `full`，不被兜底降级 |
| 4 | 错 owner / 会话 / run / 内容 | `owner_mismatch` / `conversation_mismatch` / `run_mismatch` / `content_mismatch`；非本人（含管理员）投影 `hidden/owner_mismatch`、metadata `null` |
| 5 | 历史恢复不执行 | 清单 = 历史 + 原运行 + 提案投影 + 原操作，全为 `GET`，不含 `run_start` / `approval` / `run_cancel`，路径占位符全替换，查询只带身份参数 |
| 6 | 错回执身份 | 标记 / 计划层 `actor_mismatch` / `target_mismatch` / `contradictory_receipt`；冻结层 `unknown/identity_mismatch` |
| 7 | 终态撤权 | `unverifiable/terminal_unreadable`（不冒充 `missing`）+ 正文受限 + 派生标题回退 |
| 8 | 旧无绑定消息 | 兜底前 `full`（缺口本身）⇒ 兜底后 `unavailable`；正文 null；附件 / 元数据不变；幂等；`user` 不受影响 |
| 9 | 重复持久化 | `http+assistant` 与 `run_terminal+user` 均拒绝；每角色最多一个放行通道；**能力边界**：同一允许通道可重复放行，幂等交 §2.4 |
| 10 | 未知只查原身份 | `operation_missing`；`queryOperationOutcome([], plan)` = `unknown/no_receipt`；只按原 `operation_id` 发 GET |
| 11 | 保存详情不可读 ≠ 未保存 | `saved_detail_unavailable` ≠ `unknown/no_receipt` |
| 12 | finished 必须带可读终态 | `status:"finished"` + `outcome.content`，且响应可被 `parseYayaRunLookupResponse` 解析 |
| 13 | 标记不是批准 | `principal` / `approved` / `role` → `malformed_request`；`token` → `secret_field_present`；缺提案带操作 → 拒绝 |
| 14 | 浏览器边界 | 源码无 `node:` / Next / DB / 模型依赖；esbuild `platform=browser` 真实打包通过 |
| 15 | **混合依赖漏守门**（P1-A） | 已映射可读来源 + `unmapped_dependency_count:1` ⇒ `unknown`、`sources:[]`、投影 `unavailable`；正向对照（同依赖、计数 0）仍 `bound`/`full`；计数 `-1` / `1.5` / `NaN` / `Infinity` ⇒ `unknown` |
| 16 | **回执本体未核验**（P1-B） | 计划全一致但回执换 `operation/batch/actor/target` ⇒ `unverifiable(operation_mismatch)`；只换 actor / target ⇒ `actor_mismatch` / `target_mismatch`；`saved + effect:unknown + 无业务标识` ⇒ `unknown/invalid_success_proof`（不返回 `saved`）；无回执 ⇒ `unknown/no_receipt`；正向对照仍 `saved` |
| 17 | **重复 / 矛盾依赖顺序**（P1-C） | 同 operation 正常 + 矛盾事实，两序判定同为 `target_mismatch`；重复事实 / 重复回执规范为**一个**结果；同操作矛盾回执 ⇒ `contradictory_receipt`；重复 `operation_id` / `item_key` 标记 ⇒ 解析 `malformed_request` + 核验 `operation_mismatch`（不返回 2 份结果） |
| 18 | **opaque 身份未按路径编码**（P2） | `c/../../admin/teachers?a=1#b%20c` ⇒ path 为 `encodeURIComponent` 结果、解码完整还原、路径段无残留 `/ ? #`；`query` 保持原值并经 `URLSearchParams` 往返 |
| 19 | **提案投影恢复** | `proposals_query` 由冻结 `approval` 路径父路径派生（检查锁定）；proposal-only 标记（无 run / 无操作）仍派生 `GET /api/yaya/proposals?proposal_id=...`；无提案身份不派生；不派生批准写路径 |

## 7. 证据分级

| 级别 | 本轮状态 | 内容 |
|---|---|---|
| **纯检查**（已跑） | ✅ 通过 | `check-chat-bind.ts` **19 项**；`tsc -p tsconfig.json` 0 错；`eslint --quiet` 两个新文件 0 告警；`check-api-contract.ts` 57 项回归通过 |
| **主评审独立复跑**（已有） | ✅ 通过 | 主评审报告：原 14 组独立实跑 14/14（含真实 `platform=browser` 打包）+ 6 个补充探针；本轮把 6 个探针适配到新事实形状复跑，逐条显示 P1-A `unknown/unavailable`、P1-B `unverifiable` / `invalid_success_proof`、P1-C 两序一致 + 重复标记拒绝、P2 路径编码（临时脚本，跑完即删，不入库） |
| **浏览器 fixture** | NOT_RUN | UI1 去掉 assistant append、重载后按标记恢复、错误身份文案、受限消息渲染 |
| **真实 HTTP + DB** | NOT_RUN | D1 拒绝助手 POST、D3 绑定字段读写、D4 `recovery` 随消息视图返回、D5 读投影降级、旧消息 `unknown` 降级、owner 过滤；§2.4 的同事务 / 故障回滚 / 受控竞争 |
| **真实模型** | NOT_RUN（本轮不占额度） | run 依赖采集是否覆盖整段答案（`dependencies` 完整性）、真实撤权 / 转班 / 失联场景 |

以上 NOT_RUN 项必须由对应 owner 在获批 SHA 上实现后，按 `AGENTS.md` 的“写接口必须实际 curl 走一遍”与浏览器验收流程验证。

## 8. 明确不宣称 / 停止点

- 本轮**不宣称**“私域答案绕过投影”或“历史丢失原身份”的运行时漏洞已关闭：只交付接口、兼容规则与反例。
- **协议本轮不冻结**；**D1–D6 不因任何报告获得实施批准**，仍等主评审确认。
- 不合并 UI1 / APP1 / TOOLS1 候选，不修改其 runtime，不抢写其路由、schema 或仓储。
- 不新增审批、认证或状态库；接口缺口（如 D1–D6）交唯一 owner 与主评审决定。
- `authorizeYayaMessageWrite` 是能力边界，**不宣称**“重复落账在协议层不可能”；幂等与原子提交要求见 §2.4，落地与验证归 APP1 / DATA1。
- 完成后停止，等待主评审，不自行整合、不进入下一阶段。
