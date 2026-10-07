# YAYA-DATA-CHAT-BIND1 交付：写入通道分离与绑定 / 恢复存储

状态：实现完成，专属检查 RED→GREEN 与全部相关回归实跑通过；停止等主评审，不自行整合、不开始 APP1 / UI1。
起点：`be1818268733713b91801ee7462e96fc7e024819`（`codex/yaya-chat-bind0` 头，CHAT-BIND0-R1-FINAL）。
接口依据：`docs/yaya-v1/chat-bind-interface-v1.md` §5 精确差异 D1–D6；主评审：`%TEMP%\opencode\yaya-chat-bind0-review-20261007\FINAL-REVIEW.md`。
约束核验：harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改；未读 `.env`；真实 provider / 模型 / 搜索 / S3 出口 0 次；未动 `package.json` / 锁文件 / AUTH / G0 / `types.ts` / `api-contract.ts`；未部署、未 push、未按端口或名称前缀清理他人资源。

## 1. 写入通道分离（D1 + D2/D6 内部原语）

- `authorizeYayaMessageWrite({channel, role})` 能力矩阵：`http` 仅放行 `user`；`run_terminal` 仅放行 `assistant|tool`；每角色恰好一条放行通道。
- `route.ts`：`role ∈ {assistant, tool}` → `400 invalid_request`（§4.2 预期：旧客户端助手 POST 失败，UI1 改为读回）；请求体顶层出现 16 个绑定 / run 键（`run_id`、`binding_state`、`binding`、`recovery`、`recovery_mark`、`channel`、`write_channel`、`internal_channel`、`run`、`writer`、`sources`、`independently_readable`、`general_qa_proven`、`private_dependency_proven_absent`、`resource_dependencies`、`unmapped_dependency_count`）→ `400 invalid_request`（`findForbiddenHttpMessageKeys`；片段内 `sources` / ir 不受限）。
- `saveMessage(client, principal, schoolId, input, channel = "http")`：内部调用方默认 http；`channel === "http"` 且携带 `run` / `binding_state` / `recovery` → `invalid_request`。
- **发布给 APP 的内部原语** `saveRunTerminalMessage(...)`（`messages.ts` + `data/index.ts` 挂载）：authorize run_terminal → 校验 `run:{run_id, client_request_id}` 非空、`binding_state ∈ {bound, unknown}`、`recovery` 经 `parseYayaChatRecoveryMark` 校验 → 派生 `client_message_id` → 委托 `saveMessage(..., "run_terminal")`。**不自开事务**，与调用方共用同一 `TransactionClient`。
- 派生规则 `deriveYayaRunClientMessageId(runId, role, part?)`：`yaya-run:{runId}:{role}:{part}`，`part` 缺省等于 `role`；`run_id ≤ 64`、`part ≤ 44`、禁 `:`、总长 `≤ 128`，违规抛 `invalid_request`。
- `expected_conversation_revision` 语义：`number` 严格 CAS；`null` / 缺省跳过 CAS，但会话行仍 `FOR UPDATE`。

## 2. 绑定字段、恢复标记与读投影（D2 / D3 / D4 / D5）

- `yaya_messages` 增 3 列：`run_id varchar(64)`、`binding_state text`、`recovery_mark jsonb`（`schema.ts` + 迁移文件含名字守卫 CHECK）；旧行 `NULL` → 读侧解析为 `unknown`，**不回填**。
- `buildRecoveryMark(input, ownerAccountId)`：owner 取自锁后会话行，标记经 `parseYayaChatRecoveryMark` 双向校验（含秘密字段扫描），非法标记 → `invalid_request`。
- `MESSAGE_COLUMNS` / INSERT 扩 3 列；`YayaProjectedMessageView.recovery: YayaChatRecoveryMark | null`（损坏 / 缺失 / 旧行为 `null`，corrupt 路径同样返回 `null`）。
- `projectFragments(role, bindingState)`：`role !== "user"` 时在 `projectChatMessage` **之后**调用 `restrictYayaAssistantProjection`，正文 / provenance / 标题均基于受限后投影（D5）；`role === "user"` 原样返回。
- 读策略 `yayaAssistantReadPolicy(bindingState, fragments)`：非 `bound` → `unknown / sources:[] / ir:false`；`bound` → sources 取片段去重并集、ir = `fragments.every(ir)`（空片段为 true，不误伤）。
- 标题派生 SELECT 扩为 `id, fragments, owner_account_id, conversation_id, role, binding_state`，受 binding 状态影响。
- 同事务不变量：run 终态、消息、绑定字段 / 恢复标记同一 client 原子提交（§2.4），幂等复用 `yaya_messages_client_id_unique` + `resolveClientMessageReplay`。

锁顺序（本 owner 承诺，供 APP1 对齐）：`yaya_conversations FOR UPDATE` → 幂等 SELECT `yaya_messages` → `yaya_attachments`（按 id 排序）→ `INSERT yaya_messages` → `INSERT yaya_attachment_refs` → `UPDATE yaya_conversations`。

## 3. 迁移文件

- 新增 `scripts/upgrade-yaya-chat-bind-v1.sql`：3×`ADD COLUMN IF NOT EXISTS` + `DO $$` 名字守卫 CHECK；只改 `yaya_messages`；幂等（实测连跑两遍）。
- 顺序依赖：必须在 `upgrade-yaya-v1.sql` **之后**执行；APP DDL 不复制本迁移。

## 4. 既有 DATA 检查的最小迁移（3 个文件）

- `check-data-db.ts` / `check-data-r1-db.ts` / `check-data-r1-media-db.ts`：初始化序列补跑 `upgrade-yaya-chat-bind-v1.sql`（`check-data-db` 连跑两遍，纳入其"迁移幂等 + 业务表形状不变"断言）。
- `check-data-db` 1 处、`check-data-r1-db` 2 处助手 HTTP POST 改走 `saveRunTerminalMessage`（`binding_state:"bound"` 保留访问驱动语义；投影 / 越权 / 幂等断言原样保留），`check-data-r1-db` 新增 1 条 `replayed === true` 断言；user 消息通道与直写 `saveMessage(role:"user")` 不变。

## 5. RED→GREEN

- 专属检查 `scripts/yaya/check-data-chat-bind1.ts`：P 段（新 API 存在性）+ D1–D16（隔离 PG + 直调 route）。
- RED（基线实跑）：`11 passed / 69 failures`（该轮求值 80 项），run `dcb1-muxnkjn4-2adfa270`。
- GREEN（实现后实跑）：`144/144, failures:[]`，run `dcb1-muxolwyb-50c44846`。

## 6. 验收（本轮全部实跑）

| 检查 | 结果 |
|---|---|
| `check-data-chat-bind1.ts`（专属） | 144/144（RED 11/69F → GREEN） |
| `check-chat-bind.ts` / `check-api-contract.ts` | 22/22 / 57/57 |
| `check-data.ts` / `check-data-r1.ts` | 27/27 / 10/10 |
| `check-data-db.ts`（迁移两次 + 业务表形状不变） | 116/116 |
| `check-data-r1-db.ts` / `check-data-r1-media-db.ts` | 59/59 / 67/67 |
| `check-contract.ts` / `check-preflight.ts` / `check-guide-contract.ts` | 68/68 / 15/15 / 19/19 |
| `check-media-r1.ts` | 25/25（清理 removed） |
| `check-business-access.ts` | 113/113（cleanup verified） |
| `check-auth-core.ts` / `check-auth-contract.ts` | 28/28 / 36/36 |
| `check-auth-role-ux.ts` / `check-auth-core-repairs.ts` | 44（截图 17）/ repairs 5、cleanup verified |
| `check-integration-http.ts` / `check-integration-media-db.ts` | 17/17 / 88/88（不经消息路径） |
| `check-integration-prep-joint.ts` | **RED（下游 seed，见 §7）**，`cleanup_ok:true` 无残留 |
| `pnpm validate`（tsc + eslint + stylelint） | 0 告警 |
| 构建 | `pnpm next build` + `pnpm tsup src/server.ts ...`（build.sh 两步等价执行）通过 |
| `git diff --check` | 无空白错误 |

备注：`bash scripts/build.sh` 在本机因 `core.autocrlf=true` 的 CRLF 检出与 WSL bash 组合在 `set -o pipefail` 行报错（环境问题，非本轮代码），故直接执行其两条真实命令，命令与参数逐字一致。

## 7. 下游影响与 NOT_RUN（按范围未改，交对应 owner）

- `scripts/yaya/acceptance/seed.ts` 受两处影响：(a) `runMigrations` 未含 `upgrade-yaya-chat-bind-v1.sql` → 首条消息即 `column "run_id" does not exist`；(b) 4 处 `saveMessage(role:"assistant")` 走默认 http 通道 → 迁移补上后将被 `invalid_request` 拒绝。修复 = 初始化补一行迁移 + 助手写入改 `saveRunTerminalMessage`（或等价补 run / binding 入参）。
- `check-integration-prep-joint.ts` 实测 RED，首个失败即 (a)：`AcceptanceSeedError: column "run_id" does not exist`（`seed.ts:251` 包装，`cleanup_ok:true`）；`acceptance/verify.ts` 同源。二者本轮按范围未改。
- 浏览器验收（UI1 读回 / 恢复渲染）、真实模型依赖采集、托管库 / 部署 NOT_RUN；本轮模型请求 0。
- 新库部署顺序：`initialize-demo-db` → `upgrade-yaya-v1.sql` → **`upgrade-yaya-chat-bind-v1.sql`**（缺失将使消息读写整体 500）。

## 8. 文件清单与停止点

- 代码：`src/lib/yaya/storage-types.ts`、`src/lib/yaya/data/{messages,projection,invariants,rows,index}.ts`、`src/app/api/yaya/conversations/[id]/messages/route.ts`、`src/storage/database/shared/schema.ts`。
- 迁移 / 检查：`scripts/upgrade-yaya-chat-bind-v1.sql`、`scripts/yaya/check-data-chat-bind1.ts`（新增）；`scripts/yaya/check-data-db.ts`、`check-data-r1-db.ts`、`check-data-r1-media-db.ts`（§4 最小迁移）。
- 文档：本文件。
- 停止：不改 APP runtime / TOOLS / MEDIA / UI / AUTH / G0 / 冻结类型与契约；不 push；等主评审后再进入整合。
