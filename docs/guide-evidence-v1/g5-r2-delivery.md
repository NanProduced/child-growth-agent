# G5-R2 引用字段修改与首次归档日期豁免返修交付说明

- 分支：`codex/g5-r2-basis-fixes`
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g5-r2`
- 基线：`118690ac70d6c5f59c67ec7d3b37b5dd5c86a099`（已核实 = G5-R1 工作树 HEAD，含 `a078c9d`/`118690a` 两次提交）
- 本记录提交：包含本文件的 `fix:` 提交
- 状态：两处返修完成并通过全部要求的离线检查与构建；**实库事务与真实模型未在本任务执行**，mock 事务替身结果不等于实库验收。
- `RTK.md`：本工作树不存在（已核实），未创建、不补造。
- 历史：从 R1 交付 SHA 直接建树，保留 R1 全部守门与两次提交历史，未 rebase/amend。

## 1. 文件清单（仅负责文件）

修改：

| 文件 | 变更 |
|---|---|
| `src/lib/guide/decisions.ts` | `buildBasis` 依据复用改为完整定位匹配（observation_id + quote + quote_source + quote_field）；日期一致性独立核对，不再随首次归档版本豁免跳过；版本守门仍按来源进行；`findSavedBasis` / `findSavedSourceBasis` 分离 |
| `scripts/check-guide-evidence-r1.ts` | 新增 R2-A（6 项）、R2-B（5 项）、R2-四 恢复路线（10 项）反例；保留 R1 全部 68 项 |

新增：

| 文件 | 职责 |
|---|---|
| `docs/guide-evidence-v1/g5-r2-delivery.md` | 本记录 |

未修改：G0 契约/冻结类型/fixture、G1 目录、G2 迁移、G3/G4 UI 与 fixture、正式页面、QA 装置（`check-guide-evidence-db.ts`）、`check-guide-evidence-runtime.ts`、`check-guide-evidence-routes.ts`、其他业务源码；无新增依赖。

## 2. 逐项 RED → GREEN

RED 证据：`pnpm tsx scripts/check-guide-evidence-r1.ts` 在修复前输出 `passed: 86, failed: 5`：

```
R2-A1 新位置必须反映在结果中
R2-A2 反向新位置必须反映在结果中
R2-A4 多字段并存时按完整定位选择 highlights，不误用第一个旧依据
R2-B2 空版本 + 日期漂移必须 basis_expired（实际 null）
R2-B4 批量日期不符整批失败（实际 null）
```

修复后：`{"passed":91,"total":91,"offline":true,"r1":true}`。

### A) quote_field 修改被吞掉

- 根因：复用判定只看“同一来源观察”，返回保存快照时带回旧 `quote_field`；当 quote 与 quote_source 相同而字段不同时，既吞掉新位置又因内容等价判 `changed=false`。
- 修复：
  1. 依据完整定位为 `observation_id + quote + quote_source + quote_field`；只有四项全一致才复用保存快照；
  2. 教师明确更换合法字段/片段时返回新定位快照，写入结果；
  3. 同一来源多片段/多字段并存时按完整定位选择，不取第一个旧依据；
  4. 版本/日期守门仍按来源执行，字段切换不能绕过；
  5. 完全相同的重复提交仍幂等、不增长 revision。
- 反例：A1 `highlight_quote → highlights`（同句）生效；A2 反向生效；A3 完全重复不增长 revision；A4 同来源多字段并存按定位选择、不相互覆盖；A5 新声明位置没有该片段仍拒绝（`invalid_request`）；A6 来源版本漂移时切换字段仍 `basis_expired`。

### B) 首次归档不能豁免日期一致性

- 根因：`firstArchive` 分支把版本与日期核对一起跳过，空版本 + 日期漂移被静默重建为新日期。
- 修复：日期一致性独立核对（`savedSource.observed_at !== fresh.observed_at` → 409 `basis_expired`），先于版本豁免执行；首次归档豁免只处理“空版本 → 本次首次 `confirmed_at`”；批量仍全有或全无。
- 反例：B1 空版本 + 同日期首次归档成功；B2 空版本 + 日期漂移失败；B3 已有版本 + 日期漂移失败（R1 口径保留）；B4 批量一条日期不符整批失败且输入容器不变（零部分写入）。
- 保留：正常首次归档成功（B1 + R1 `testNullAndInvalidVersion`）、归档与选中关联同事务生效、旧确认版本漂移拒绝、批量一条无效全批失败、`raw_text`/草稿/既有审核保护不变（全部回归通过）。

## 3. 旧空版本建议的既有 API 恢复路线（离线执行证据）

严格口径不变（未放宽 `null/null`）。既有 API 流程与恢复路线在离线假事务客户端上逐步执行（`check-guide-evidence-r1.ts` 的 `R2-四`，10 项断言全部通过）：

| 步骤 | 操作（既有 API） | 结果 |
|---|---|---|
| 起点 | 未归档观察 `suggest` 生成 AI 建议（依据来源=宿主、`source_confirmed_at=null`）；随后普通归档不携带 `guide_decisions` | 宿主 `confirmed`，旧建议 `ai_suggested` 保留 |
| 1 | 独立 `confirm` 旧空版本建议（`link_id`，expected revision=1） | **409 `basis_expired`**；宿主保持已归档；revision 不增长 |
| 2 | `reject` 旧建议（expected revision=1，理由写入） | revision=2；旧建议 `rejected`，审计保留 |
| 3 | 手动 `confirm`（`item_id` 当前目录条目，依据=宿主 raw_text） | revision=3；新关联 `confirmed_performance` |
| 4 | 核对新依据 | 来源=宿主、`observed_at=2026-09-20`、`source_confirmed_at=归档 confirmed_at`（非空） |
| 5 | 完全重复提交（expected revision=3） | 幂等：revision 仍为 3，关联数不增加；`raw_text` 未改写 |

- 恢复路线可达且只用现有 API：**拒绝旧待核对建议 → 手动建立当前目录关联**；无需新恢复 API、生产开关或契约修改。
- 限制（供 G6 设计错误恢复交互）：旧空版本建议不可原地确认；`basis_expired` 的界面必须提供“拒绝旧建议 + 手动关联”的实际入口与预期 revision；建议生成后来源已归档/日期或版本漂移的迟到建议一律冲突不写入。
- **证据分层**：以上为离线假事务客户端（mock）执行结果，**不是实库验收**；实库版本见第 5 节待验证清单。

## 4. 验证结果（本工作树）

| 检查 | 结果 |
|---|---|
| `pnpm validate`（tsc + eslint + stylelint） | 通过（exit 0） |
| `pnpm build`（next build + tsup） | 通过（exit 0；本机默认 `bash` 为不可用 WSL，使用 Git Bash 执行同一 `scripts/build.sh`） |
| `check-guide-evidence-r1.ts` | **91/91**（R1 68 + R2 新增 23；修复前 RED 5 条失败） |
| `check-guide-evidence-runtime.ts` | 140/140 |
| `check-guide-evidence-routes.ts` | 26/26 |
| G0 `check-guide-contract.ts` | 19/19 |
| G1 `check-guide-catalog.ts` | 11/11 |
| G3 `check-child-evidence-book-fixtures.ts` | 63/63 |
| G4 `check-class-evidence-overview.ts` | 42/42 |
| save-consistency / teacher-clarify / agent-flow / organize-retry / growth-profile / activity-support / class-reports-pages | 24/24、13/13、30/30、9/9、13/13、19/19、11/11 |
| homepage-map | 通过 |

无删除断言或放松规则；全部模型路径使用离线替身，`real_model_requests: 0`。

## 5. 待组合实库验证的反例清单

- A1/A2：同一来源同句 `highlight_quote ↔ highlights` 互换 → 结果 `quote_field` 随之改变，`changed=true`、link revision +1、容器 revision +1。
- A3：完全重复提交 → 200 幂等，link/容器 revision 不增长。
- A4：同一来源多条依据（同句两个字段）并存 → 按提交定位更新，不误用第一条。
- A5：声明位置不含片段 → 400 `invalid_request`，不写入。
- A6：来源 `confirmed_at` 漂移 + 切换字段 → 409 `basis_expired`，整批不写入。
- B2：空版本快照 `observed_at` 与来源当前 `observed_at` 不一致 + 同事务归档 → 409 `basis_expired`，宿主/容器不被部分修改。
- B4：批量中一条日期不符 → 全批回滚，容器 revision 不变。
- 恢复路线：实库按第 3 节步骤执行，逐步核对 revision、旧建议审计、新依据非空版本、重复幂等、`raw_text` 不变。
- 以上需在 QA1 安全装置评审通过后由组合任务执行；在此之前不得宣称实库通过。

## 6. 未执行项（NOT_RUN）

- `scripts/check-guide-evidence-db.ts`：**NOT_RUN**（未获批/属 QA1，未修改、未运行；未自建第二套实库装置）。
- `scripts/check-classes.ts`：**NOT_RUN**（危险装置）。
- 真实 StepFun/Coze 调用、托管库读写、迁移、部署与环境变量：**NOT_RUN**。
- 浏览器/UI 验收：**NOT_RUN**。
- 结论分层：离线返修通过 ≠ 实库事务通过 ≠ 真实模型质量通过 ≠ 线上可部署。
