# TEST-DATE1 交付报告（本地返修与验收，等待主评审）

- 基线：`d8825e6e46f606adabb0e220225bc33d188ccc3e`（CLOSE0 candidate baseline）
- 分支：`codex/test-date-business-access`（独立工作树 `C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-test-date1`，未整合其他分支）
- 提交：
  - `9f596be` `test: expose business-access date drift with saved-enrollment counterexample`（先加能暴露问题的反例）
  - `cbc98c5` `fix: anchor business-access success path to saved enrollment start`（再修复）
  - 交付头 = 本文件提交（SHA 见交付消息 / `git log`；本文件不写入自身 SHA，避免自引用）
- 文件清单：`scripts/check-business-access.ts`（+16 / -1）、`docs/auth-v1/test-date1-delivery.md`（新增）。`src/**`、业务 API、queries、日期工具、schema、迁移、冻结契约、`scripts/harness-safety.ts` 均未改动。
- `scripts/harness-safety.ts` blob：`6702f2ddf3b436e79f8c92ae8756c33f611a8503`（与要求一致，未修改）
- `RTK.md`：工作树中不存在；已记录，未创建。
- `AGENTS.md` / `PRODUCT.md` / `DESIGN.md`：开工前已核对（本任务无 UI 改动，未触碰首页与视觉资产，未触发 Impeccable 返工）。

## 根因

1. `POST /api/children` → `createChild`（`src/lib/queries.ts:397`）把首次分班 `child_class_enrollments.start_date` 写为 `isoDateInShanghai()`，即**运行日**的亚洲/上海日历日。
2. 原检查在该幼儿建档后用固定 `observed_at: "2026-10-04"` 创建观察并断言 201。
3. `POST /api/observations` 按 `observed_at` 查分班窗口（`start_date <= observed_at` 且 `end_date IS NULL 或 >= observed_at`）；运行日超过 2026-10-04 后不存在覆盖该日期的归属，业务**正确**返回 409 `class_context_confirmation_required` / `reason=no_attribution`。
4. 即：不是业务缺陷，是测试把固定日历日当作仍在归属窗口内；运行日一旦漂移，成功断言把正确的拒绝误判为失败。

本轮运行事实（本地 `isoDateInShanghai()`，无数据库）：`shanghaiToday=2026-10-05`，固定样本 `2026-10-04` 早于入班起始日。

## 修改内容（仅测试与文档）

1. 成功路径锚定保存事实：建档后在隔离库读取该幼儿 `end_date IS NULL` 的已保存归属 `start_date`，成功观察使用该日期；不再使用固定日历日。增加覆盖断言（覆盖后为回归哨兵：一旦有人改回固定日期即失败）。
2. 反例（保留在最终版本）：`enrollmentStart - 1 天` 的观察必须 409、`error=class_context_confirmation_required`、`reason=no_attribution`，且该幼儿观察行数为 0（不得落库）。
3. 其余固定历史样本保持固定日期不变（fixture 观察 `2026-01-02`、fixture 入班/转班日期、撤权写入样本 `2026-02-03` 等）；未改业务代码、未关闭班级语境校验、未把成功断言改成接受 409、未跳过任何原检查。
4. 受控并发、撤权/停用/过期、迟到写入、CSRF、服务端授权、revision/幂等/事务、raw_text 不可改写、草稿/确认稿分离、证据版本与引用、模型等待后权限重核等既有检查全部原样保留。

## 实际结果

| 阶段 | 命令 | 结果 |
|---|---|---|
| 修复前（基线 `d8825e6`） | `pnpm exec tsx scripts/check-business-access.ts` | 失败：`{"error":"class_context_confirmation_required","reason":"no_attribution",...}` `409 !== 201` |
| 反例提交（`9f596be`，成功路径仍为固定日期） | 同上 | 失败：`success-path observation date is covered by the child's saved enrollment`（明确暴露漂移） |
| 修复后（`cbc98c5`） | 同上 | 通过：`{"passed":113,"total":113,...,"real_model_requests":0,"cleanup":"verified",...}` |
| 静态校验 | `pnpm ts-check` / `pnpm lint:build` | 均通过（exit 0） |

- 相对基线记录的 107/107，本轮为 113/113（+6 为新增断言，未删除或放宽任何既有断言）。
- 真实模型请求：0（守门 `hits=0`）；隔离容器、连接、进程与守门均经核验清理（`cleanup=verified`）。
- 两次失败运行后核查 `label=cga.business.check` 无残留容器。

## 证据标注（测试替身与真实证据分开）

- 真实证据：隔离库中已保存的归属事实由测试直连读取；API 为进程内真实 Request/Response handler 直调，成功写入由同一隔离库复查；隔离库为本轮唯一自有 PostgreSQL 容器，容器 ID/标签/库名/用户/端口/空库均经身份核验。
- 测试替身：provider 出口被本地守门服务器改道并计数（`real_model_requests=0`，不触达外部模型）；“模型返回”“并发竞争者连接”为离线/可控替身。
- NOT_RUN：完整 Next HTTP/浏览器验收、真实 LLM 调用、托管数据库、部署与安全认证（与脚本输出 NOT_RUN 一致）。

## 约束遵守

- 仅本地返修与验收：未 push、未部署、未操作 `main`、未连接或迁移托管数据库、未读取/复制 `.env` 实际凭证。
- 仅使用 pnpm（`pnpm install --frozen-lockfile`），未新增依赖。
- 仅修改负责的两个文件；提交均精确 `git add <文件>`，未使用 `git add .`。

## 剩余风险 / 说明

- 修复后覆盖断言为恒真（固定日期回归哨兵）；真正的防回归来自“读取已保存归属事实”本身。
- 日期为天粒度（`YYYY-MM-DD`）；跨午夜由“读取已保存事实”规避，不依赖两次进程时钟一致。
- `docs/auth-v1/business-access-home.md` 记录为 107/107，现为 113/113；该文档不在本任务负责范围，未改动，建议主评审决定是否随后修订。
- 状态：**返修候选，等待主评审**，不自行整合，不自行宣布通过。
