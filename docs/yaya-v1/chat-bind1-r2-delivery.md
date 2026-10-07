# YAYA-DATA-CHAT-BIND1-R2 交付：派生标题共用恢复关联核验

状态：R2 唯一 P1 已修，反例 RED→GREEN 实跑通过，全量回归与构建重跑绿；停止等主评审，不自行整合。
候选基线：`0637d1556c91b0ec9351c9c9ad43ae51ab8c5516`（R1 提交，评审核验通过）。
评审依据：`%TEMP%\opencode\yaya-data-chat-bind1-review-20261007\REVIEW-R1.md`（剩余 P1：恢复标记与消息行不一致时正文已 unavailable，派生标题仍经消息列表 / 会话详情 / 会话列表返回且 `title_restricted=false`）。
约束核验：harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改；未读 `.env`；真实 provider / 模型 / 搜索 / 桶出口 0 次；未动冻结契约（`chat-bind-contract.ts`、`types.ts`、`api-contract.ts`）、APP runtime / TOOLS / MEDIA / UI / AUTH / G0 / seed / package / 锁文件；未部署、未 push。

## 1. 根因与修复（共享边界，一处规则）

- 根因：同一消息行存在两个判定——正文路径（`projectMessageRow`）核验 recovery mark 与 owner/conversation/run 关联，标题路径（`projectConversationView`）只 `SELECT` 到 `run_id` 并仅判断非空，损坏标记下仍按 `bound` 放行标题。
- 修复：在 `projection.ts` 提取共享函数 `resolveRowBindingIntegrity(row)`——结构解析（`parseRecoveryMark`）+ 关联核验（`conversation_id` / `owner_account_id` / `run.run_id` 三字段等于行值，解析失败也算不符）→ 返回 `{ recovery（不符为 null）, bindingState（不符降 unknown） }`，内部复用既有 `effectiveYayaBindingState`。
- 正文路径：`projectMessageRow` 改为调用该函数（判定逻辑整体迁入，无第二分支，行为与 R1 一致）。
- 标题路径：`SELECT` 增 `recovery_mark` 列，命中片段时用同一 `resolveRowBindingIntegrity(message).bindingState` 替代原 `effectiveYayaBindingState(binding_state, run_id)`——绑定降 unknown 后经既有 `yayaAssistantReadPolicy` → `restrictYayaAssistantProjection` → 片段 hidden → `projectConversationTitle` 回退通用受限标题（`projected_title="受限会话"`, `title_restricted=true`）。
- 未新增授权、未新增账本、未隐藏全部标题；合法无标记 / 关联一致的 bound、一般问答、原始 user、手工标题路径不变。

## 2. 反例（先 RED 后修，原 167 项不删）

`check-data-chat-bind1.ts` 新增 `r2TitleStage`（D21，15 断言）+ `assertTitlePackages`（同一消息三个对外整包：消息列表 raw JSON + 解析、会话详情、会话列表 raw JSON + 解析）：

- **合法对照**：bound + 合法关联标记 + 片段派生标题 → 三包标题可读（`title_restricted=false`）。
- **坏 run 关联**：`jsonb_set(recovery_mark,'{run,run_id}',…)` → 三包受限 4 断言。
- **坏 owner 关联**：`jsonb_set(recovery_mark,'{owner_account_id}',随机 UUID)` → 三包受限 4 断言。
- **损坏标记**：`recovery_mark='{"bogus":true}'`（结构解析失败）→ 三包受限 4 断言。
- 消息列表整包同时断言不含正文与原标题；`getMessages` helper 扩展返回解析后的 `conversation` 摘要（原调用方不破坏）。
- **RED**：`174/186`，12 failures（3 tamper × 4 整包，对照组与原 167 项全过），run `dcb1-muxry00q-9f6b9e04`。
- **GREEN**：`186/186, failures:[]`，run `dcb1-muxryyuf-133ab93e`。

## 3. 验收（R2 轮全部实跑）

| 检查 | 结果 |
|---|---|
| `check-data-chat-bind1.ts`（含 D1–D21） | RED 174/186 → **GREEN 186/186**（run `dcb1-muxryyuf-133ab93e`） |
| `check-chat-bind.ts` / `check-api-contract.ts` | 22/22 / 57/57 |
| `check-data.ts` / `check-data-r1.ts` | 27/27 / 10/10 |
| `check-data-db.ts` | 116/116 |
| `check-data-r1-db.ts` / `check-data-r1-media-db.ts` | 59/59 / 67/67 |
| `check-contract.ts` / `check-preflight.ts` / `check-guide-contract.ts` | 68/68 / 15/15 / 19/19 |
| `check-media-r1.ts` | 25/25（清理 removed） |
| `check-business-access.ts` | 113/113（cleanup verified） |
| `check-auth-core.ts` / `check-auth-contract.ts` | 28/28 / 36/36 |
| `check-auth-role-ux.ts` / `check-auth-core-repairs.ts` | 44（截图 17）/ repairs 5、cleanup verified |
| `check-integration-http.ts` / `check-integration-media-db.ts` | 17/17 / 88/88 |
| `pnpm validate`（tsc + eslint --quiet + stylelint） | 三项 exit 0 |
| 构建 | `pnpm next build` + `pnpm tsup src/server.ts ...`（build.sh 两步等价执行）通过 |
| `git diff --check` | 无空白错误 |

## 4. 下游影响（与首轮 / R1 一致，未改，交对应 owner）

- `scripts/yaya/acceptance/seed.ts` 缺 `upgrade-yaya-chat-bind-v1.sql` + 4 处 assistant 默认 http 写入 → `check-integration-prep-joint.ts` 仍 RED（`cleanup_ok:true`）；归 seed owner。
- 浏览器验收（UI1）、真实模型依赖采集、托管库 / 部署 NOT_RUN；本轮模型请求 0。
- 部署顺序不变：`initialize-demo-db` → `upgrade-yaya-v1.sql` → `upgrade-yaya-chat-bind-v1.sql`。

## 5. 文件清单与停止点

- R2 修改：`src/lib/yaya/data/projection.ts`（`resolveRowBindingIntegrity` 共享边界 + 标题路径 `recovery_mark` SELECT 与同规则判定）；`scripts/yaya/check-data-chat-bind1.ts`（D21 + `assertTitlePackages` + `getMessages` 扩展 + `conversationsListGet` 导入）；本文件。
- 未触碰：R1 已提交内容（`0637d155`）其余全部不变；`next-env.d.ts` 构建产物漂移已还原。
- 停止：不 push、不整合、不进入 APP1 / UI1；等主评审复核 R2。
