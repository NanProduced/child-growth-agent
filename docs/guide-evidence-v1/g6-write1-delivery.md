# G6-WRITE1 交付：教师指南证据关联写入流程

- 状态：**实现与本地验收完成，等待主评审**。不 push、不部署、不改 main、不合并其他任务。
- 分支：`codex/g6-guide-write-flow`；工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g6`。
- 基线（B0_SHA）：`d8825e6e46f606adabb0e220225bc33d188ccc3e`（CLOSE0 候选基线：首页 v2、账号、业务访问）。
- 提交：
  - `fdc9fcb` wip：本任务在 e877f3b 上的在制改动（17 个文件的精确清单）。
  - `d8990e1` merge：`git merge --no-ff d8825e6`；3 个冲突逐文件协调。
  - 交付提交：浏览器验收装置修复 + 本文件（见 `git log`；不写自引用 SHA）。

## 1. 基线对齐（B0）

- `git merge-base --is-ancestor d8825e6 HEAD` → 0；合并提交双亲为 `fdc9fcb` 与 `d8825e6`。
- 冲突与协调（不是整文件任选）：
  - `src/app/observations/[id]/review/page.tsx`：保留 B0 `scopedGetObservation/scopedGetChild` 与
    `can_write` 只读早退（历史只读/管理员只读）；可写路径嫁接指南上下文，基来源改用 `scopedListObservations`。
  - `src/app/observations/[id]/review/review-client.tsx`：整理/追问/确认/澄清改用 B0 `fetchWithAccountAuth`（会话 CSRF）；
    保留 `guide_decisions`、deferred 保留、applied/detail_unavailable、网络不确定先读回。
  - `src/app/observations/new/page.tsx`：保留本任务服务端页 + 客户端；移植 B0 `fetchWithAccountAuth`、
    `/api/classes?catalog=true`、园所账号登录文案。
- 旧口令已退役：`write-access` 只认 `resolveServerAuth` 的园所账号；证据页写入口用
  `withBusinessRead` 解析出的 Principal + 纯规则逐人判定；无旧口令回退。
- 对 B0 的差异恰为本任务文件；`src/lib/auth.ts`、`src/lib/accounts/*`、`queries.ts`、`pg-client.ts`、`schema.ts` 零差异；
  `scripts/harness-safety.ts` blob 保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。

## 2. 文件清单

相对 B0 的改动（17 + 1）：

```
scripts/check-guide-write-flow.ts                 新增：离线纯逻辑检查（67 项）
scripts/check-guide-write-flow-browser.ts         新增：真实浏览器 + 隔离库 + 园所账号验收（54 项）
src/lib/child-list-client.ts                      新增：幼儿列表加载状态与形状校验
src/lib/guide/association-types.ts                新增：关联视图类型与引用片段候选
src/lib/guide/decision-draft.ts                   新增：决定草稿校验（与服务端同口径的最小前置）
src/lib/guide/write-access-rules.ts               新增：纯写权限规则（管理员/越界/停用/身份不可用）
src/lib/guide/write-access.ts                     新增：服务端身份解析（resolveServerAuth，不缓存 Principal）
src/lib/guide/navigation.ts                       修改：item_id/return_to 白名单、录入链接、返回聚焦
src/components/guide/guide-association-section.tsx 新增：关联操作区（手动/AI 建议核对/不采用/撤回）
src/components/guide/evidence-route-client.tsx    修改：接通“记录相关观察/活动支持”回调与返回上下文
src/components/guide/class-evidence-overview.tsx  修改：新增可选 canRecordChild（逐人入口）
src/app/children/[id]/evidence/page.tsx           修改：withBusinessRead Principal + 记录入口
src/app/classes/[id]/evidence/page.tsx            修改：withBusinessRead Principal + 逐人记录入口
src/app/observations/new/page.tsx                 修改：服务端写权限门 + 白名单关注点/返回上下文
src/app/observations/new/new-observation-client.tsx 新增：录入表单（加载状态、可重试、园所账号+CSRF）
src/app/observations/[id]/review/page.tsx         修改：B0 只读/B0 scoped 读取 + 指南上下文装配
src/app/observations/[id]/review/review-client.tsx 修改：guide_decisions 与关联区装配
```

## 3. 实现要点与需求映射

1. **证据页接通“记录相关观察”**：携带 `child_id`、`item_id`、`return_to`（白名单校验，仅站内证据册路径）；
   item_id 只是关注点：不预填内容、不自动关联；录入→Review 保留关注点，归档完成返回原条目与期间
   （`withEvidenceItemFocus` 覆盖 `item_id`，保留期间/筛选）。目录外 item_id 由 Review 服务端核对并显式提示。
2. **录入页加载状态**：HTTP 401/403/503、非法 JSON、形状不可信、网络失败进入显式可重试错误态，
   不显示“暂无幼儿”；原文保留；AbortController + 请求代次防止迟到响应覆盖新身份/新选择；
   幼儿列表加载失败期间不展示建档空状态。
3. **Review“关联指南条目”**：默认折叠、按需展开（带关注点时自动展开）；317 条目不铺满，按关键词搜索；
   手动选择条目 + 真实依据（逐字片段候选来自原文/确认稿事实位置）；AI 建议只在点击时请求；
   展示建议理由、引用与来源；两种决定（已有相关线索/已确认观察到）；成人帮助说明、持续性纪要、
   跨日依据均按既有规则采集；默认不选中、不确认。
4. **未归档宿主**：选择先进入“待随归档提交”，确认请求携带 `guide_decisions`，与归档共用现有事务；
   `deferred` 时保留待提交选择且不显示已生效；不通过独立指南接口提前确认未归档宿主（服务端 host guard 保留）。
5. **已归档宿主**：手动关联、AI 建议核对、不采用、撤回均走正式接口；使用当前 revision；
   终态不原地复活，重新手动关联产生新 link 并保留旧审计；409（basis_expired/catalog_version_mismatch/
   state_conflict）提示重新读取核对，不自动重放、不偷换依据。
6. **applied + detail_unavailable**：明确告知已保存；只触发重新读取，不再次提交归档；
   网络中断等结果不确定时先 `router.refresh()` 读回，不无依据显示成功、不自动重复 POST。
7. **权限**：写入口由服务端 `withBusinessRead` Principal + `authorizeAction` 逐资源判定；
   管理员、越界（原班历史只读/无权限）不出现写控件；班级名单逐人判定；活动支持回调连接现有成长档案活动区
   （`/children/{id}#activity-support-title`），不宣称指南定向生成。

## 4. 验收证据

全部在隔离本地 PostgreSQL（`harness-safety`，唯一 RUN_ID、容器 ID+标签核验，结束按身份清理）上执行；
真实浏览器（Chrome headless，1440×900 / 768×1024 / 390×844）；真实园所账号登录 + 会话 CSRF。
**真实模型请求：0**（provider 凭证留空 + 守门服务器，`guard_paths: []`）。

### 4.1 主路径（真实 HTTP + 真实数据库 + 真实浏览器）

- 浏览器登录任教教师 → 个人证据册展开条目 → “记录相关观察” → 录入原文（真实 POST /api/observations）
  → Review 保留关注点。
- 整理步骤使用**测试进程内替身**（直接写入 ai_draft，等价于离线 organize 替身；标注 `in_process_substitute`）。
- 手动关联 + 确认归档：真实 confirm 请求携带 `guide_decisions`，与归档同事务写入；
  `basis.source_confirmed_at` 与来源 `confirmed_at` 一致；revision=1。
- 返回原条目与期间（URL 含 item_id 与 age_band）；个人证据册显示“已确认观察到”并可展开来源；
  班级页同期间聚合该幼儿显示“已确认观察到”（分母与期间口径由既有读模型给出）。

### 4.2 已归档与规则（真实 API + 真实数据库）

- 撤回：真实写入 `withdrawn`，保留 support/依据/撤回时间/原因；随后手动重新关联生成新 link，旧审计保留。
- 不采用：预置 `ai_suggested` 工作流建议（fixture，不计入正式状态）→ 真实 reject 写入终态、support=null、理由保留。
- 持续性：单日依据 + 结构化纪要（期间覆盖依据、说明 ≥10 字）真实写入 `sustained`。
- 成人帮助：要求独立条目在“已确认观察到”下禁用成人帮助；改为线索后可写入 `confirmed_clue` + adult_help_used。
- 服务端规则直探（真实 HTTP）：要求独立 + 成人帮助 + 表现 → 400；持续条目单次支持 → 400；
  过期 revision → 409 state_conflict；缺会话 CSRF 的写请求 → 403 csrf_rejected（B0 保护未绕过）。
- AI 建议按钮：仅在教师点击时发出请求；`suggest` 响应使用改写替身（不触达模型），失败提示可见；
  打开页面不自动调用。

### 4.3 结果替身场景（明确标注）

| 场景 | 方式 | 证据类别 |
|---|---|---|
| deferred（未归档保留选择） | 确认响应替身，数据库保持 ai_organized | interface_double |
| basis_expired（保留选择、不重放） | 409 响应替身 | interface_double |
| applied + detail_unavailable | 真实写入 + 响应改写，确认仅 1 次、数据库已归档/已关联 | real_write+response_double |
| AI 建议请求/失败 | 路由改写 + provider 阻断 | interface_double |
| ai_suggested 工作流建议 | SQL fixture | fixture |

### 4.4 权限

- 任教教师（小班）：证据页记录入口、Review 关联写入口可见。
- 其他班教师：越界证据页不泄露数据（错误边界“资料暂时不可读”），Review 无关联区段。
- 管理员：可读证据册但无记录入口；Review 显示“管理员只读”，无写控件；录入页不渲染表单。
- 原班历史只读：转班幼儿旧观察显示“原班历史观察 · 只读回看”，不挂载写客户端。

### 4.5 命令与计数

| 检查 | 结果 |
|---|---|
| `pnpm exec tsx scripts/check-guide-write-flow-browser.ts` | 54/54；`real_model_requests: 0` |
| `pnpm exec tsx scripts/check-guide-write-flow.ts` | 67/67（离线） |
| G3 浏览器（既有装置） | 127/127 |
| G4 浏览器（既有装置，含新增逐人入口的兼容） | 115/115 |
| `pnpm validate` | ts-check / eslint / stylelint 全部 0 |
| `pnpm next build` + tsup `src/server.ts` | 成功（新/改路由均在路由表） |
| 指南契约 / 目录 / 导航 / G5 路由替身 / G3 fixture / G4 fixture | 19/19、11/11、18/18、26/26、63/63、42/42 |
| 回归：agent-flow / organize-retry / growth-profile / activity-support / teacher-clarify / save-consistency / class-reports / homepage-map | 30/30、9/9、13/13、19/19、13/13、24/24、11/11、通过 |

证据目录（保留在 Temp 供主评审）：
`C:\Users\nanpr\AppData\Local\Temp\opencode\g6-write1-evidence`（`results.json`、4 张截图、G3/G4 子目录、`dev-server.log`）。

## 5. 已知问题与 NOT_RUN

- **B0 既有检查日期漂移（非本任务回归）**：`scripts/check-business-access.ts` 使用硬编码
  `observed_at: "2026-10-04"`，而新建幼儿的归属起始日为运行日（亚洲/上海日历日）。2026-10-05 运行该检查时，
  建档后立即创建该日期观察得到 409 `class_context_confirmation_required(no_attribution)`。
  本任务未修改该脚本与建档/班级语境代码；本任务验收全部使用运行当日日期。请基线负责人或后续任务处理。
- `NOT_RUN`：真实 StepFun/Coze provider 调用（预算耗尽，禁止调用）；托管/线上数据库与部署；
  AUTH2 全路由授权切换（属 B0 后续范围）；非 Windows 浏览器；真实模型质量。
- 浏览器中的 model 相关均为测试替身或响应改写，已在 `results.json` 中逐条标注证据类别；
  接口替身不构成真实模型全链路验收。
- 关联操作区在未归档阶段不提供“不采用/撤回”（契约只允许对已归档宿主独立执行），
  页面显式说明“归档后可以处理”，不绕过 host guard。

---

# 附录：G6-WRITE1-R1 修复

- 基线：`b500d8c`；沿 `codex/g6-guide-write-flow` 追加提交，不重做 B0 合并历史。
- 新增/修改文件：
  `src/lib/guide/mutation-response.ts`（新增，响应核对与读回解析）、
  `src/components/guide/guide-association-section.tsx`、
  `src/app/observations/[id]/review/page.tsx`、`review-client.tsx`、
  `src/lib/guide/decision-draft.ts`、`src/lib/guide/association-types.ts`、
  `scripts/check-guide-write-flow.ts`、`scripts/check-guide-write-flow-browser.ts`、本文件。

## A. 不完整响应不能显示成功

- 新增 Zod 形状核对（`parseGuideMutationResponse` / `parseReviewConfirmResponse`）：
  必须核对 `observation_id` 与宿主一致、`revision` 为非负整数、`links` 为完整 `EvidenceLinkView` 形状；
  HTTP 200 + `{}`、非法 JSON、错误宿主、非法 links 一律进入“待核对”，不显示成功、不自动重发。
- 允许幂等：revision 相等/更小都可接受，不要求递增。
- 区分“AI 失败 notice（ai_link_failed）”与“没有新增建议”：前者 warning 且提示可手动关联，
  后者明确说明本次没有新增待核对建议。
- 每次目标结果单独核对（`mutationTargetOutcome`）：确认必须出现正式状态，
  不采用/撤回必须出现对应终态；缺失/不符不显示成功。
- 无法核对时保留输入与写入锁，只能通过“重新读取核对”（GET `/api/observations?child_id=`）决定后续；
  读回权威容器可读但目标缺失 → “确认本次没有写入”，教师可重试；容器不可读/读回失败 → 继续待核对。
- 浏览器反例（真实库 + 客户端保留）：归档确认依次注入 `200 {}`、非法 JSON、错误宿主、非法 links
  四种响应，各只发出 1 次写入、编辑器引用不丢、读回后确认未写入、不自动重发，最后教师重试真实写入成功落库；
  AI 建议按钮同样覆盖 `200 {}`（接口替身）。Review 确认覆盖路由中断与 `200 {}`，
  并验证数据库仍未归档、本地备注保留、重试后真实归档且待提交关联同事务写入。

## B. 刷新不粗暴清空未提交内容

- 去掉 `key=updated_at` 造成的重挂载；以观察 id 为稳定身份，增加显式 props 同步效果：
  同步服务端状态、`guide revision`、links、依据来源；仅在教师未修改时同步 AI 草稿与教师备注，
  已修改内容保留；宿主从“未归档”变为“已归档”或本端刚保存时才清空待提交草稿。
- 账号身份（`viewerKey=account_id`）变化时清空本组件内全部私人草稿，旧账号草稿不展示给新账号。
- 待提交决定记录建立时的 `basedOnRevision` 与依据指纹；服务端修订或依据来源变化即标记“需重新核对”，
  从提交集合中排除且不静默更新 `expectedRevision`；编辑器在修订变化后要求教师显式再次保存才继续。
- 真实版本变化反例（隔离库 + 两端真实写入）：
  - 已归档宿主：另一端真实写入使 revision 变化 → 本端旧修订 409 →
    props 同步后编辑器仍保留已填引用、显示“需重新核对”；首次点击不发送请求，
    教师明确再次保存后使用新修订真实写入成功。
  - 未归档宿主：另一端先完成真实归档 → 本端 409 → 读回确认已归档；
    本端不重复归档、本地修改未静默进入正册、待提交关联未写入、读回后不可再归档
    （`pending-decisions` 与归档入口均消失）。

## C. 已保存与结果不确定分开处理

- `applied + detail_unavailable`：按有效确认响应立即视为已保存（status confirmed），
  清除待提交、禁止再次归档；只做详情重新读取（`router.refresh()`），确认请求不重复。
- 网络中断/响应不可核对：保留未决标记与写入锁（`guide-unresolved` / `confirm-unresolved`），
  只有读回成功且核对后才决定：已写入 → 已保存并待详情；未写入 → 保留输入可重试。
- 读回 401/403/503、非法响应、网络失败或列表未找到宿主：不假定未保存、不恢复直接重复写入，
  只能继续重试“读取”。
- 归档与关联 busy 协调：归档/整理/追问进行中禁止修改关联草稿；关联写入进行中禁用归档与澄清提交。

## D. 保健参考语义

- 编辑器、待提交、已核对展示按 `evidence_type` 分支：保健参考使用“资料已核对 / 资料线索已核对 /
  单次资料 / 参考线索 / 教师核对关联 / AI 建议关联”，不出现“已确认观察到”“成人帮助后确认表现”等能力判断，
  不显示持续观察纪要字段，规则行明确“不参与行为统计、不构成发展确认”，不输出正常/异常结论。
- 内部状态与审计字段不变，行为条目保持原三状态与成人帮助规则。
- 浏览器反例：身高体重条目编辑器文案、无成人帮助开关、无持续纪要、真实写入
  `confirmed_performance`，已核对展示为“资料已核对”且无医疗结论词。

## R1 验收结果

| 检查 | 结果 |
|---|---|
| `check-guide-write-flow-browser.ts` | **99/99**（保留原 54 项 + 新增 45 项反例）；`real_model_requests: 0` |
| `check-guide-write-flow.ts` | **112/112**（离线；新增响应核对/读回/幂等/目标结果/失效草稿/保健语义反例） |
| G3 浏览器（既有装置，复跑） | 127/127 |
| G4 浏览器（既有装置，复跑） | 115/115 |
| `pnpm validate` / `pnpm next build` + tsup | 全部通过 |
| 指南契约 / 目录 / 导航 / G5 路由替身 / G3 fixture / G4 fixture | 19/19、11/11、18/18、26/26、63/63、42/42 |
| 回归：agent-flow / organize-retry / growth-profile / activity-support / teacher-clarify / save-consistency / class-reports / homepage-map | 30/30、9/9、13/13、19/19、13/13、24/24、11/11、通过 |
| 断点 1440×900 / 768×1024 / 390×844 | 无横向溢出、核心目标 ≥44px、键盘可操作（沿用原 54 项中的响应式与键盘断言） |

证据目录：`C:\Users\nanpr\AppData\Local\Temp\opencode\g6-write1-r1-evidence`
（`results.json` 按证据类别标注：`real_http+real_db(+browser)`、`interface_double`、`real_http+interface_double`、
`real_write+response_double`、`fixture`、`in_process_substitute`、`model_guard`）。

## 文档修正

- 指南目录实际为 **317 条**（5 领域 / 11 子领域 / 32 目标 / 87 教育建议）；前文一处“327”已更正。
- **B0 已含授权接入**：`withBusinessRead`/`scoped-queries`/`runBusinessWrite`/`fetchWithAccountAuth`（会话 CSRF）
  均已在 B0 落地；本任务与 R1 均在其上装配页面，未重新验收 AUTH2 不等于尚未实现或未接入。
- 证据边界：主链路为真实浏览器 + 真实 HTTP + 隔离 PostgreSQL；接口替身仅用于模型相关与指定故障注入；
  真实 StepFun/Coze provider 调用为 `NOT_RUN`（预算耗尽，凭证留空 + 守门服务器，计数 0）。
