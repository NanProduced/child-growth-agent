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
3. **Review“关联指南条目”**：默认折叠、按需展开（带关注点时自动展开）；327 条目不铺满，按关键词搜索；
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
