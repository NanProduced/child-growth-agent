# CLOSE-QA1 整合记录：AUTH-UX1-R1 + G6-WRITE1-R1 + TEST-DATE1

- 状态：**本地整合、组合检查与联合浏览器验收完成；等待主评审**。未合并 main、未 push、未部署、未连接托管库。
- 分支：`codex/flow-close-integration`；工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-flow-close`（从 B0 新建，不在 main 或来源工作树内操作）。
- 最终候选 SHA：本记录所在提交（docs-only，父提交为工具提交 `b26054ff82981871b509dfc4e8949759609d14e9`，其父为被测产品候选 `47a7935`）；确切 SHA 见交付消息，避免自引用。
- `scripts/harness-safety.ts` 未修改，四个来源与最终候选 blob 均为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。

## 1. 固定来源与合并

| 角色 | 分支 | 完整 SHA |
|---|---|---|
| 共同基线 B0 | codex/home-v2-craft | `d8825e6e46f606adabb0e220225bc33d188ccc3e` |
| AUTH-UX1-R1 | codex/auth-role-ux-close | `a6ba3297ed698e5bed7bf4443e7bc324d3543c8a` |
| G6-WRITE1-R1 | codex/g6-guide-write-flow | `a7e8a127624131fbe2ce5b612d8668ea2f015ddb` |
| TEST-DATE1 | codex/test-date-business-access | `13bf1161ca8729ead423b11848534f85b9f5338f` |

核验：四个 SHA 均为 commit；B0 是三个来源的 `merge-base --is-ancestor` 祖先（exit 0）；三个来源工作树 `git status --porcelain` 为空（B0 工作树仅有既存 untracked `.impeccable/review/`，本轮未触碰）。合并按顺序 `--no-ff`，全部保留来源历史：

1. `00614ab` merge AUTH-UX1-R1（16 文件，1629+/155-）
2. `35ce6d7` merge G6-WRITE1-R1（19 文件，6823+/556-）
3. `47a7935` merge TEST-DATE1（2 文件，76+/1-）

三次合并均无文本冲突（三个来源改动文件集不重叠：AUTH 改 app 页面/教师管理；G6 改观察/证据/指南组件与库；TEST-DATE1 只改 `scripts/check-business-access.ts` 与交付文档）。组合正确性由下方运行时检查证明，不以祖先关系代替行为验收。

## 2. 必要兼容修改

产品代码零修改；仅测试装置两处必要整合兼容：

1. `scripts/check-class-reports-pages.ts`（B0 时代离线页面装置）：
   - 补 `resolveServerAuth` mock —— AUTH-UX1-R1 的 `reports/page.tsx`、`classes/[id]/page.tsx` 改用该入口，旧 mock 缺此导出导致 `TypeError`。
   - 班级管理场景改用 admin principal，并断言读取失败为“读取暂未完成”通用文案（AUTH-UX1-R1 已批准：管理区 admin-only、读取失败不回显原始 DB 错误）。
   - 修复后 `11/11`；不涉及认证、事务、证据口径。
2. 新增最小联合 runner `scripts/check-flow-close-joint.ts`（22 项）——不 import 任何会在顶层执行 main 的验收脚本，只复用 `harness-safety` 无副作用原语与真实路由/账号/隔离库。

已知不在要求集内的过时脚本：`scripts/check-guide-evidence-db.ts` 调用 B0 已退役的 `createSessionToken`（`src/lib/auth.ts` 自 B0 起按设计抛 `unauthenticated`，该脚本与 auth.ts 相对 B0 零 diff），在 B0 上即失败，属 B0 时代遗留，本轮未修改、未计入通过数；必跑项 `check-guide-evidence-r1 / routes / runtime` 全部通过。

## 3. 组合检查实测（全部在本候选工作树重新运行，非复制来源报告）

| 检查 | 结果 | 证据类别 |
|---|---|---|
| `pnpm validate`（ts-check / eslint / stylelint） | 0 / 0 / 0 | 静态 |
| `pwsh scripts/build.ps1`（next build + tsup） | exit 0，路由含新页面 | 构建 |
| `check-guide-write-flow.ts` | 123/123 | 离线 |
| `check-guide-write-flow-browser.ts` | 102/102，real_model_requests 0 | 真实浏览器+隔离 PG+账号 CSRF；模型替身 |
| `check-guide-evidence-r1.ts` | 91/91 | 离线 |
| `check-guide-evidence-routes.ts` | 26/26（授权替身） | 离线 |
| `check-guide-evidence-runtime.ts` | 140/140 | 离线 |
| `check-role-entries.ts` | 21/21（替身） | 离线 |
| `check-teacher-management.ts` | 37/37（替身） | 离线 |
| `check-home-account-client.ts` / `check-home-v2-data.ts` | 33/33 / 40/40 | 离线 |
| `check-business-access.ts` | **113/113**，real_model_requests 0，cleanup verified | 隔离 PG 真实 handler |
| `check-guide-contract.ts` / `check-guide-catalog.ts` | 19/19 / 11/11（317 条） | 离线 |
| `check-evidence-navigation.ts` / `check-save-consistency.ts` | 18/18 / 24/24 | 离线 |
| `check-auth-contract.ts` | 36/36 | 离线 |
| `check-agent-flow` / `organize-retry` / `growth-profile` / `activity-support` / `teacher-clarify` / `class-reports-pages` | 30/30 / 9/9 / 13/13 / 19/19 / 13/13 / 11/11 | 离线 |
| `check-homepage-map` / `check-child-evidence-book-fixtures` / `check-class-evidence-overview` | 通过 / 63/63 / 42/42 | 离线 |
| `check-auth-role-ux.ts`（AUTH-UX1 正式浏览器验收） | 44/44，17 截图，real_model_requests 0 | 真实浏览器+隔离 PG |
| `check-flow-close-joint.ts`（联合链路） | 22/22，real_model_requests 0 | 真实浏览器+隔离 PG |
| Impeccable `detect`（guide/accounts/页面范围） | 0 条非 advisory；102 条 advisory 均为 home-only 色板/字号规则用于非首页，属 DESIGN.md 明文范围外 | 代码级 |

`docs/auth-v1/business-access-home.md` 中的历史 107/107 保留为当时记录；本次实测为 113/113（+6 为 TEST-DATE1 新增断言）。

## 4. 联合浏览器验收（同一候选）

单条贯通路径（`scripts/check-flow-close-joint.ts`，真实 Next 路由、真实园所账号/会话 CSRF、本轮隔离 PostgreSQL）：

1. 管理员在 `/admin/teachers` 页面创建教师（真实落库 teacher/active）并分配班级（真实任教关系）。
2. 管理员在 `/children/new` 建档 → 进入 `/children/{id}` 成长档案；无记录观察/生成活动支持等教学写控件。
3. 新教师真实登录 → 从个人证据册条目“记录相关观察”进入录入（URL 带 `child_id`/`item_id`/`return_to`）。
4. 浏览器录入原始观察真实落库，`raw_text` 原文保存。
5. 整理步骤使用**测试进程内替身**（直接写入 `ai_draft`，标注 `in_process_substitute`），不触达 provider。
6. 教师手动关联 + 确认归档：真实 confirm 携带 `guide_decisions`，观察归档与指南关联**同一事务**生效（`confirmed` + `confirmed_performance`/`manual`，revision=1）；`basis.source_confirmed_at` 与来源 `confirmed_at` 一致；发生时班级快照 stage=small。
7. 个人证据册显示“已确认观察到”并可展开逐字引用。
8. 班级同期聚合同条目显示该幼儿“已确认观察到”（分母与期间由读模型给出）。
9. 班级下钻保持幼儿、条目与期间（URL 保留 `item_id` 与期间参数）。
10. 教师建档仍进入录入观察（A 项回归）。

额外验证分工（均在本候选上执行）：
- **A 账号与角色**：AUTH-UX1 浏览器 44/44 覆盖管理员活动支持只读、教师建档去向、密码重置后旧会话失效/旧密码失败/新密码可登录、未分配教师与越界只读；身份不可用分支为替换 I/O 的离线替身（浏览器未执行，如实标注）。
- **B 指南与恢复**：G6 浏览器 102/102 覆盖非 2xx+合法 JSON 不误判成功、空/非法响应/错误宿主待核对不自动重发、撤回/不采用/完整决定精确核对、真实两端版本变化保留输入并需重新核对、applied+detail_unavailable 不重复归档、幂等 revision 不变读回后恢复、持续性/成人帮助/保健参考与审计规则。
- **C 页面**：AUTH/G6 浏览器装置在 1440×900、768×1024、390×844 断言无横向溢出、核心目标 ≥44px、键盘可操作；登录/首页/教师管理无组合回归；空态/无权限/读取失败/结果未决文案分离。Impeccable audit/adapt 批量检查未发现可证明的整合缺陷，未做任何 UI 修改。

## 5. 测试安全与资源

- 全部隔离资源使用唯一 RUN_ID + 容器 ID/标签/回环端口/数据库身份核验；端口占用即退出；未按端口或名称前缀杀进程。检查后 `docker ps -a` 无 `label=child-growth-agent` 残留容器；各装置 `assertCleanupComplete` 通过（business-access `cleanup=verified`）。
- 生成物按 `harness-safety` 快照/恢复；构建产生的 `next-env.d.ts` import 已恢复。
- 模型守门拦截与真实 provider 请求分开：真实 provider 请求 = 0（凭证留空 + 守门服务器；守门命中数为 0）。模型能力均为测试替身，不构成真实模型质量证据。
- 凭证、连接串、密码、会话令牌未进入日志/截图/提交；本记录不含任何凭证。

## 6. 本地预览（保留的自有运行资源）

- 入口：`http://127.0.0.1:5020/`（若 5020 被占用则改用其它空闲端口，见交付消息）。
- 启动：本工作树 `pnpm exec tsx scripts/start-home-review.ts`（`LOCAL_HOME_PORT` 指定端口）；停止：`pnpm exec tsx scripts/stop-home-review.ts`（不按端口杀其他服务）。
- 账号：管理员/任教教师/其他班教师/未分配教师；凭证仅通过受控本地文件 `logs/home-review/local-credentials.json` 交付，不提交、不在聊天或日志中打印。
- 数据：仅本轮隔离合成数据（6 班/94 名幼儿、预置草稿与已确认记录）；预览种子不作为端到端验收证明。
- 模型出口保持守门，不能宣称可真实生成 AI；真实 provider 请求为 0。
- 监督脚本启动后 4 小时自动按身份与标签清理资源与临时凭证；到期或主动停止后预览资源即回收。预览资源是本轮明确保留的自有运行资源，不是测试残留。

## 7. NOT_RUN 与分层结论

- `NOT_RUN`：真实 StepFun/Coze 调用与质量、LLM Judge、托管库迁移/写入、部署、生产安全认证、非 Windows 浏览器、稀有动态姓名跨系统排版。
- 分层：**代码组合通过**（validate/build/离线/隔离库/真实浏览器联合链路）≠ **真实模型质量通过**（替身，NOT_RUN）≠ **可部署**（未部署、未做生产安全认证、未迁移托管库）。自动视觉 gate 的历史 FAIL 与人工裁定边界保持不变，未改写为整站或生产 PASS。
