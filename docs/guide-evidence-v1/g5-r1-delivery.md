# G5-R1 证据业务守门、读取语义与 AI 引用来源返修交付说明

- 分支：`codex/g5-r1-business-guards`
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g5-r1`
- 共同返修基线：`6a45636b75f0d853f485b6438754d8911036e22e`（已核实 = G5 来源工作树 HEAD）
- 本记录提交：包含本文件的 `fix:` 提交
- 状态：A–G 离线返修完成并通过全部要求的离线检查与构建；**实库事务与真实模型未在本任务执行**，待 QA1 评审后由组合任务补入安全装置实际执行。
- `RTK.md`：主仓库与 G5 工作树均不存在（已核实），本任务未创建、不补造。

## 1. 文件清单（仅负责文件）

修改：

| 文件 | 变更 |
|---|---|
| `src/lib/guide/decisions.ts` | 新增 `GuideEvidenceBasisExpiredError`、`hostObservationConflictError`；`ApplyDecisionsContext.confirmingObservationId`；旧目录 `link_id` 守门；沿用依据的来源版本/日期核对与首次归档豁免；写入依据版本必须非空可解析 |
| `src/lib/guide/runtime.ts` | `sameTimestamp` 严格化（null/非法不算一致）；`evaluateLink` 依据独立核对 + 读取支持条件；`rollupChildItem` 可读性口径；`rollupClassItem` 混合可靠性；mutation 视图依据核对；`suggestionSourceSnapshotStillMatches` |
| `src/lib/guide/read-model.ts` | 依据通知只针对正式关联；basis 视图兜底改为真实核对（不再制造 `valid=false, reason=null` 假失败） |
| `src/lib/guide/suggest.ts` | 输出 schema 增加必需 `quote_source_id`；Prompt 给出当前观察 id 并要求声明来源；按 id + quote_source + quote_field 核对；定性词守门只作用于 AI 理由 |
| `src/lib/llm.ts` | StepFun strict JSON Schema 增加 `quote_source_id`（required） |
| `src/lib/queries.ts` | 共享保存边界宿主归档守门；同事务归档 ctx 传 `confirmingObservationId`；AI 建议保存前来源快照核对 |
| `src/app/api/observations/[id]/confirm/route.ts` | 详情补查失败非阻塞（保持 applied + detail_unavailable）；`basis_expired` → 409 |
| `src/app/api/observations/[id]/guide-evidence/route.ts` | `basis_expired` → 409 |
| `scripts/check-guide-evidence-runtime.ts` | 保留原断言并适配来源 id；新增 2 条 Prompt 来源断言（138 → 140） |
| `scripts/check-guide-evidence-routes.ts` | 保留原断言；新增响应详情补查失败 6 条断言（20 → 26） |

新增：

| 文件 | 职责 |
|---|---|
| `scripts/check-guide-evidence-r1.ts` | G5-R1 专属离线反例（A–G，68 项）；含假事务客户端直接验证共享保存边界，不写数据库、不调用模型 |
| `docs/guide-evidence-v1/g5-r1-delivery.md` | 本记录 |

未修改：G0 契约/冻结类型/契约 fixture/`check-guide-contract.ts`、G1 目录、G2 迁移与学期配置、G3/G4 组件与 fixture、正式页面、`scripts/check-guide-evidence-db.ts`、旧 `g5-delivery.md`；无新增依赖；未连接托管库、未调用真实模型。

## 2. 逐项 RED → GREEN

RED 证据：`pnpm tsx scripts/check-guide-evidence-r1.ts` 在返修前输出 35 条失败（A–G 全覆盖）；修正测试装置后 34 条失败；修复后 68/68 通过。路由 C 反例在 `check-guide-evidence-routes.ts` 中先失败后通过。

### A) 独立操作必须检查宿主观察已归档

- RED：宿主 `draft` / `needs_input` / `ai_organized` 上独立 `confirm` / `reject` / `withdraw` 均无 409（实际无异常或后续 400）；幂等重复被 `invalid_request` 掩盖；引用另一条合法 confirmed 来源可绕过。
- GREEN：守门下移到 `applyGuideEvidenceMutationWithClient`（锁宿主后、任何写入前），`hostObservationConflictError` 返回 409 `state_conflict`；幂等重复同样不得绕过；宿主已归档后合法操作与完全重复幂等保持可用且 revision 不增长；`suggest` 仍可在未归档观察上产生待核对建议；归档接口 `guide_decisions` 同事务路径不变。
- 反例：三种未归档状态、reject/withdraw、另一条合法 confirmed 来源、幂等重复、正常归档后合法/幂等。

### B) 目录版本与依据版本不能静默刷新

- RED：旧 `catalog_version` 关联按 `link_id` 确认成功并保存旧版本；来源 `confirmed_at` 漂移时生成新快照静默替换旧版本；`null/null` 与相同非法字符串读取判有效；独立确认沿用空版本快照成功。
- GREEN：
  1. `link_id` 确认前先核实 `catalog_version`，不一致 → 409 `catalog_version_mismatch`（不因 `item_id` 仍存在而兼容）；
  2. 同一来源观察的沿用依据必须核实保存时的 `source_confirmed_at` 与 `observed_at`，漂移 → 409 `basis_expired`，整批不写入；
  3. 写入依据版本必须非空且可解析；读取 `sameTimestamp` 对 null/非法一律判不一致；
  4. 教师明确换用另一来源依据、新手动关联仍可用；改写同一来源片段时仍先核对版本，版本一致才写入新片段；
  5. 拒绝/撤回/旧依据审计路径不变；
  6. 区分首次归档：仅当来源就是本次同事务归档的宿主（`confirmingObservationId`）且保存版本为 null 时豁免，写入新 `confirmed_at`；独立路径空版本 → `basis_expired`，不会一刀切使正常建议永久 409。
- 反例：旧目录、旧来源版本、同来源改写片段、空/非法版本、批量一条过期、正常首次归档、明确更换依据、新手动关联、合法重复幂等。

### C) 提交成功不能被响应补查改报失败

- RED：`confirmObservation` 已提交后 `buildGuideResponseLinks` 抛错 → HTTP 500。
- GREEN：详情补查作为非阻塞步骤；失败时返回 `200 + guideEvidence.status="applied" + detail_unavailable=true + message`，**不含 `links`**（不用空数组冒充成功），revision 由已提交的 `guide_evidence` 解析；成长小结失败同样不影响归档与关联；提交前失败仍回滚/返回错误。
- 反例：详情补查失败（6 条断言）、小结失败不连带、提交前失败回滚。

### D) 读取校验与可靠性

- RED：缺 `item_id` 的 confirmed 关联被所有条目跳过 → reliable + 0%；同容器有效+未知状态 → unavailable；班级一人不可读 → 整班 unavailable；`confirmed_performance + clue_only`、`requires_independence + adult_help_used`、成人帮助无说明、纪要非法日期均被计入。
- GREEN：
  - 容器可读性按“是否存在可归属、可解析关联”判定：无 `item_id` / 结构损坏 → 不伪装为正常未关联；全部不可读才 unavailable，混合 partial；
  - 班级：全部幼儿不可读才 unavailable，混合 partial，保留 counts、名单分母与逐幼儿受限标记，占比 null；
  - 读取支持条件：`clue_only`/null 不得计为表现；`requires_independence` 有成人帮助不得计为表现；`adult_help_used` 无说明不得计为表现；持续纪要日期必须真实、起止有序、说明 ≥10 字且覆盖全部依据；
  - NULL 正常未关联仍 reliable；期间/学段口径排除不降可靠性；保健参考不新增状态与占比。
- 反例：缺 item_id、有效+未知同容器、班级混合/全不可读、四类支持条件（另保留可靠 6/4/10、可信 0%、空名单、历史回看、跨期排除、健康参考原覆盖）。

### E) 审计依据独立核对

- RED：工作流提前返回使 basis 视图默认 `valid=false, invalid_reason=null`（撤回/不采用/待核对/旧目录关联）。
- GREEN：`evaluateLink` 对全部关联独立执行 `checkBasis`；个人读模型与 mutation 响应共用同一规则；`valid=false` 只来自真实核对（source_missing/cross_child/not_confirmed/quote_not_found/version_mismatch）；撤回后来源版本漂移仍能给出 `version_mismatch`。
- 反例：有效撤回 valid=true、撤回后来源失效 version_mismatch、不采用/待核对/旧目录分别正确展示且均不进入正式状态、mutation 响应一致。

### F) AI 引用必须绑定明确来源

- RED：同句同时存在于当前观察与历史来源时，服务端按“第一个匹配”绑定当前观察 id/日期/版本，与模型理由描述的历史情境不符。
- GREEN：
  - 内部输出 schema（zod 与 StepFun strict JSON Schema）新增必需 `quote_source_id`；Prompt 明确给出当前观察 id 与已确认来源 id；
  - 服务端只接受提供列表内的 id，按 `quote_source_id + quote_source + quote_field` 逐字核对；错误/跨幼儿 id、位置不符、虚构引用均拒绝；来源元数据仍由服务端生成；
  - 不保留“旧格式第一个匹配”兼容：缺 id 视为 schema 失败并有限重试；
  - 保存前在同一事务内核对所用来源仍符合生成快照（日期/版本），迟到变化返回 409 冲突，不写旧建议。
- 反例：同句不同日期/情境正确绑定、错误 id、跨幼儿 id、错误引用位置、虚构引用、缺 id 旧格式拒绝、来源生成后归档/版本漂移不写、正确明确来源通过。

### G) 事实引用不能被当作 AI 评分

- RED：真实原文“他说：游戏不按分数排名。”的引用使整条建议被拒，错误指向建议理由。
- GREEN：定性词守门只扫描 AI 自创理由；事实引用以真实性核对为准，不删除原文词语；AI 理由主动打分/排名/诊断仍拒绝；虚构引用仍拒绝。
- 反例：否定评分事实引用通过、AI 打分/诊断拒绝、虚构引用拒绝。

## 3. 验证结果（本工作树）

| 检查 | 结果 |
|---|---|
| `pnpm validate`（tsc + eslint + stylelint） | 通过（exit 0） |
| `pnpm build`（next build + tsup） | 通过（exit 0；本机默认 `bash` 为不可用 WSL，使用 Git Bash 执行同一 `scripts/build.sh`） |
| G5 离线运行时 `check-guide-evidence-runtime.ts` | **140/140**（原 138 + 新增 2 条来源 Prompt 断言） |
| G5 路由离线 `check-guide-evidence-routes.ts` | **26/26**（原 20 + 新增 6 条详情补查断言） |
| **G5-R1 专属离线** `check-guide-evidence-r1.ts` | **68/68**（返修前 RED 35 条失败） |
| G0 `check-guide-contract.ts` | 19/19 |
| G1 `check-guide-catalog.ts` | 11/11 |
| G3 `check-child-evidence-book-fixtures.ts` | 63/63 |
| G4 `check-class-evidence-overview.ts` | 42/42 |
| 回归 agent-flow / organize-retry / growth-profile / activity-support / teacher-clarify / save-consistency / class-reports-pages | 30/30、9/9、13/13、19/19、13/13、24/24、11/11 |
| 回归 homepage-map | 通过 |

测试数量变化：运行时 138→140、路由 20→26、新增 68；无删除断言或放松规则。全部模型路径使用注入替身，`real_model_requests: 0`。

## 4. 未执行项（NOT_RUN）

- `scripts/check-guide-evidence-db.ts`：**NOT_RUN**（属并行 G5-QA1，未修改、未运行；本任务未自建第二套实库装置）。
- `scripts/check-classes.ts`：**NOT_RUN**（危险装置，未修未跑）。
- 真实 StepFun/Coze provider 调用、托管库读写、迁移执行、部署与环境变量：**NOT_RUN**。
- 浏览器/UI 验收：**NOT_RUN**。
- 结论分层：离线返修通过 ≠ 实库事务通过 ≠ 真实模型质量通过 ≠ 线上可部署。

## 5. 待 QA1 实库验证的业务反例清单

A（宿主守门）：draft / needs_input / ai_organized 宿主分别独立 confirm、reject、withdraw（含依据指向另一条合法 confirmed 来源）→ 409 `state_conflict`，容器与 revision 不变；幂等重复同样 409；宿主 confirmed 后合法操作成功、完全重复 200 幂等且 revision 不增长；未归档宿主上 `suggest` 仍可写入待核对建议且不产生正式状态。

B（版本）：旧 `catalog_version` 关联 `link_id` 确认 → 409 `catalog_version_mismatch`；来源 `confirmed_at` 漂移 → 409 `basis_expired` 且整批不写入；空/非法版本独立确认 → 409；同事务归档宿主首次获得 `confirmed_at` → 成功并写新快照；明确换用另一已确认来源/新手动关联 → 成功；批量一条过期 → 全批回滚。

C（响应）：归档+关联已提交后详情补查失败 → 200 + `applied` + `detail_unavailable`，DB 中 `confirmed_content`/`guide_evidence` 已提交、无重复写入；提交前失败（无效依据/前提变化）→ 回滚，观察保持未归档。

D（读取）：唯一容器缺 `item_id` 的 confirmed 关联 → 不返回 reliable；同容器有效+未知状态 → partial 且有效关联计入；班级一人不可读、其余可读 → partial，counts 之和=分母、占比 null；全部不可读 → unavailable；四类支持条件（clue_only 表现、requires_independence+成人帮助、成人帮助无说明、非法纪要日期）不计入表现。

E（审计）：撤回/不采用/待核对/旧目录关联的 basis 视图显示真实 `valid`/`invalid_reason`；撤回后来源版本漂移 → `version_mismatch`；均不进入正式状态。

F（引用来源）：同句跨来源时按模型声明 id 绑定；错误/跨幼儿/未提供 id、位置不符、虚构引用拒绝；建议生成后来源归档或版本漂移再保存 → 409 冲突且不写旧建议。

G（事实引用）：原文含“分数/排名”的真实引用 + 中性理由通过；AI 理由打分/排名/诊断拒绝；虚构引用拒绝。

## 6. 不变量与边界确认

- `raw_text` 未改写；草稿/确认稿分离；现有修改审核与澄清流程未动；AI-R1 快照保护未动。
- children→observations 锁顺序、同 client 短事务、模型调用在事务外保持不变。
- 写入只触碰 `guide_evidence`/`updated_at`（独立路径）或与归档同事务单条 UPDATE；未触碰 `raw_text`/`ai_draft`/`confirmed_content`（独立路径）/`agent_context`/`status`。
- 未修改 G0 冻结类型与契约、G1 目录、G2 迁移、G3/G4 UI、正式页面；无新依赖；未 push、未合回 main、未部署。
