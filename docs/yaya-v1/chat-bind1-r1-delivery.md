# YAYA-DATA-CHAT-BIND1-R1 交付：主评审返修（P1-A / P1-B / P2-C）

状态：R1 三发现已修，反例 RED→GREEN 实跑通过，全部回归与构建重跑绿；停止等主评审，不自行整合。
基线：分支 `codex/yaya-data-chat-bind1`，接首轮提交 `c92405f`（CHAT-BIND1 交付文档 `chat-bind1-delivery.md`）。
评审依据：`%TEMP%\opencode\yaya-data-chat-bind1-review-20261007\REVIEW.md`（P1-A 幂等漏核绑定身份；P1-B 混合片段与坏绑定身份读侧缺口；P2-C http 默认通道可缺省版本）。
约束核验：harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改；未读 `.env`；真实 provider / 模型 / 搜索 / 桶出口 0 次；未动 `package.json` / 锁文件 / 冻结契约（`chat-bind-contract.ts`、`types.ts`、`api-contract.ts`）/ APP runtime / TOOLS / MEDIA / UI / AUTH / G0 / seed；未部署、未 push。

## 1. P1-A：幂等纳入绑定身份（messages.ts + storage-types.ts）

- `computeYayaMessageDigest` 增可选 `binding` 参数：`{run_id, client_request_id, binding_state, execution_state, recovery}` 进入 canonical JSON（键排序递归，摘要确定性）。
- `saveMessage` 仅在 `input.run !== undefined`（即 run 终态通道）时传入 binding；**HTTP / user 通道不传，摘要字节与首轮逐字节一致**，既有 user 幂等重放兼容不变。
- 效果：同一 `client_message_id` 下改 `client_request_id` / `binding_state` / recovery / 执行状态 → 摘要不一致 → `resolveClientMessageReplay` 判 `idempotency_conflict`（原实现误返 `replayed:true` 甚至未知请求返回旧 full）。消息账本不新增行、原行不改写、不从回执反建 expected。

## 2. P1-B：读侧逐片段守门 + 绑定完整性（projection.ts + invariants.ts）

- **混合片段守门** `enforceFragmentTrust`：非 user 消息在 `restrictYayaAssistantProjection` 之后逐片段检查——`sources.length === 0 && !independently_readable` 的片段强制 `hidden / source_unavailable`（不因消息内其他片段的可读来源并集保持正文）；被改动时用 `combineProjectionVisibility` 按 `types.ts` `projectChatMessage` 同一组合口径重算消息级 `visibility`（full/partial/metadata_only/unavailable/hidden + 附件降级规则）。已 hidden 片段保持原样；user 通道豁免。
- **绑定完整性** `effectiveYayaBindingState(bindingState, runId, markMismatch)`：`bound` 必须有非空 `run_id`；恢复标记存在但与行 `owner_account_id / conversation_id / run_id` 关联不符（含结构解析失败）→ 标记按 `null` 下发且绑定降 `unknown`（受限读取）。解析 ≠ 关联证明。
- `projectMessageRow`：先做 recovery 关联核验（`recoveryLinked`），产出 `recovery`（不符为 null）与生效绑定状态，再传入 `projectFragments`；不改写原行、不回填。
- 标题派生：SELECT 增 `run_id`，`matchedBinding` 经同一 helper 计算（缺 run 身份的 `bound` 行标题不再按可信下发）。
- 正向保持：一般 QA 满证明、合法完整来源、无正文空消息、user 全豁免（D8/D10 原断言全绿）。

## 3. P2-C：http 通道版本前提在 repository 边界守门（messages.ts + storage-types.ts）

- `saveMessage` 在 channel gates（锁前）新增：`channel === "http" && (expected_conversation_revision ?? null) === null` → `YayaDataError("invalid_request")`。不再依赖公共 route 的 zod 兜底，任何内部默认 http 调用方同样受限。
- `YayaSaveMessageInput.expected_conversation_revision?: number`（去掉 `| null`）：类型收紧；run 终态通道仍可缺省 / null（跳过 CAS、行锁串行保留），`saveRunTerminalMessage` 委托时 `?? undefined`。
- 全仓调用方已核：无 `: null` 传入；route 层 zod 必填 + 显式 `channel:"http"` 不受影响。

## 4. 测试（反例先 RED 后修）

- `check-data-chat-bind1.ts` 新增常量与 helper：`saveAttempt` / `httpSaveAttempt`（类型收紧后以 `Record` + cast 构造 NULL 版本用例）、段 `r1IntegrityStage`（接 `channelDefaultsStage` 之后），共 23 断言：
  - **D17** 绑定幂等（8）：异 `client_request_id` / 异 `binding_state` 拒绝、同身份重放、user 摘要兼容；
  - **D18** 混合片段（8）：空来源未证明片段不下发、消息级非 full、响应不含正文、撤权后仍不下发、合法有来源与 ir=true 空来源不误伤；
  - **D19** 坏绑定身份（4）：缺 run 身份降级、消息级受限、关联不符标记不下发；
  - **D20** 版本前提（5）：缺省版本拒绝、NULL 版本拒绝、拒绝后无落库、带版本仍成功、run 终态仍可缺省。
- **RED**：`153 passed / 167 total`，14 failures（D17×2、D18×4、D19×4、D20×4），run `dcb1-muxqo5tf-141b315c`——14 项与三发现一一对应。
- **GREEN**：`167/167, failures:[]`，run `dcb1-muxqvbvn-7a338602`（144 旧项 + 23 新项）。

## 5. 既有检查的最小适配（1 个文件）

- `check-data-r1-db.ts`：删除硬编码 `status: 201` / `replayed ? 201 : 200` 伪状态 shim（该写路径已迁 repository 层，HTTP 状态断言恒真、不再代表验收）——改为实际断言：`replayed === false && message.role === "assistant"`（保存成功身份）、幂等回放保留 `replayed === true`，正文 / provenance / 标题不泄漏断言改为对保存结果 JSON 检查。断言条数不变（59）。seed 适配仍归其 owner（§7）。

## 6. 验收（R1 轮全部实跑）

| 检查 | 结果 |
|---|---|
| `check-data-chat-bind1.ts`（专属，含 D17–D20） | RED 153/167 → **GREEN 167/167**（run `dcb1-muxqvbvn-7a338602`） |
| `check-chat-bind.ts` / `check-api-contract.ts` | 22/22 / 57/57 |
| `check-data.ts` / `check-data-r1.ts` | 27/27 / 10/10 |
| `check-data-db.ts`（迁移两次 + 业务表形状不变） | 116/116 |
| `check-data-r1-db.ts`（§5 适配后） / `check-data-r1-media-db.ts` | 59/59 / 67/67 |
| `check-contract.ts` / `check-preflight.ts` / `check-guide-contract.ts` | 68/68 / 15/15 / 19/19 |
| `check-media-r1.ts` | 25/25（清理 removed） |
| `check-business-access.ts` | 113/113（cleanup verified） |
| `check-auth-core.ts` / `check-auth-contract.ts` | 28/28 / 36/36 |
| `check-auth-role-ux.ts` / `check-auth-core-repairs.ts` | 44（截图 17）/ repairs 5、cleanup verified |
| `check-integration-http.ts` / `check-integration-media-db.ts` | 17/17 / 88/88 |
| `pnpm validate`（tsc + eslint --quiet + stylelint） | exit 0 |
| 构建 | `pnpm next build` + `pnpm tsup src/server.ts ...`（build.sh 两步等价执行）通过 |
| `git diff --check` | 无空白错误 |

## 7. 下游影响（与首轮一致，未改，交对应 owner）

- `scripts/yaya/acceptance/seed.ts`：初始化缺 `upgrade-yaya-chat-bind-v1.sql` + 4 处 assistant `saveMessage` 走默认 http（R1 后还缺版本前提）→ `check-integration-prep-joint.ts` 仍 RED（`cleanup_ok:true`）。修复 = 补迁移 + 助手写入迁 `saveRunTerminalMessage`。
- 浏览器验收（UI1）、真实模型依赖采集、托管库 / 部署 NOT_RUN；本轮模型请求 0。
- 部署顺序不变：`initialize-demo-db` → `upgrade-yaya-v1.sql` → `upgrade-yaya-chat-bind-v1.sql`。

## 8. 文件清单与停止点

- R1 修改：`src/lib/yaya/storage-types.ts`、`src/lib/yaya/data/messages.ts`、`src/lib/yaya/data/invariants.ts`、`src/lib/yaya/data/projection.ts`；`scripts/yaya/check-data-chat-bind1.ts`（D17–D20）、`scripts/yaya/check-data-r1-db.ts`（§5 断言）；本文件。
- 未触碰：首轮已提交文件除上述外全部保持 `c92405f` 原样；`next-env.d.ts` 构建产物漂移已还原。
- 停止：不 push、不整合、不进入 APP1 / UI1；等主评审复核 R1。
