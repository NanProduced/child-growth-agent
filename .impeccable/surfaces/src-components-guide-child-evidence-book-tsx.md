---
version: 5
slug: "src-components-guide-child-evidence-book-tsx"
primary_target: "src/components/guide/child-evidence-book.tsx"
related_targets: ["src/components/guide/child-evidence-book.module.css","src/components/guide/evidence-route-client.tsx","src/components/guide/__fixtures__/child-evidence-book-fixture.ts","scripts/check-child-evidence-book-fixtures.ts","scripts/check-child-evidence-book-browser.cjs","scripts/__fixtures__/guide-preview-page.tsx","scripts/check-evidence-pages-browser.cjs"]
---

# 个人证据册 — 单列指南列表

Mode: Operate. Scope: 两类证据页面普通扩展中的个人页，正式路由 `/children/[id]/evidence`，只读授权 DTO、受控筛选、按需来源与既有记录入口。当前已接正式页面；早期 G3 fixture-only 结论保留为历史，不再描述当前接线状态。

## Direction contract

THESIS: 教师按具体指南条目回看同一个孩子的观察，从最近记录回到逐字事实；状态属于证据核对，不是对孩子的评分。
OWN-WORLD: 沿用“轻量成长观察册”的暖白、深墨、芽绿和细线；普通网页标题、原生控件、纵向条目与轻量展开，不建立新视觉世界。
STORY: 返回成长档案 → 身份／查看时间 → 领域 → 目标与完整指南条目 → 最近来源及所属备注 → 其他记录／条目说明／关联详情 → 记录相关观察。
FIRST VIEWPORT: 窄屏保留时间与领域，次要年龄／目标／说明渐进展开，先看到至少一条完整条目及资料／证据状态；不压缩正文换首屏容量。
FORM: 用户选择最新 V4 第一稿“单列指南列表”，原图 `docs/design/child-evidence-v4-simple-20261008/01-single-column-list.png`；旧 V2/V3 展示板被否决。按布局方向适配真实 DTO，不照搬图中合成姓名、语言领域、日期或记录数量。
SIGNATURE: 普通单列指南行，完整原文与状态在行内，最近来源就地展开；旧记录与规则按需查阅，备注保持来源归属，无个人百分比、雷达、评分、排名或完成度。

## Implemented layout and local styles

- 标题与身份是普通页面头部，不包大卡；桌面时间／年龄／目标／指南说明在上，领域标签下一行，随后目标标题与单列条目，不做并列概念板。
- 默认选择一个有正式记录的行为目标与条目，没有则回退可用目标；仍可选择“全部目标”。上级 goal_id 优先，focusedItemId 定位并展开对应目标／条目，不丢下钻上下文。
- 视口 ≥1024px 展开全部筛选；<1024px 保留时间、领域与“筛选与说明”按钮，把年龄／目标／说明收在可访问区域内，也解决 768px 说明挤成窄列的问题。
- 视口 <768px 条目头自然换行，来源面板收紧至（12px）内边距，记录按钮全宽；无核心横向滚动，长指南／引用使用 `overflow-wrap: anywhere`。
- 内容最大宽（1160px），区块间距（24px），条目细分隔与（16px 12px）内边距，浅色来源阅读区（16px）内边距／（8px）圆角；不堆阴影或嵌套厚卡。
- 局部页面标题（24px / 700 / 1.4）、目标标题（18px / 650）、正文（16px / 1.65）、引用（16px / 1.8）、身份／日期／备注（14px）；现有短状态标签有（13px），不提升为全站关键状态标准。
- 字体复用 `Home Noto Sans SC / Microsoft YaHei / sans-serif` 栈；正文／引用行宽约（70ch / 65ch）。没有本轮完整 CJK 或任意业务姓名字体加载验收。
- 绿表示已确认／行动，蓝表示线索／资料参考，琥珀表示待核对，灰表示暂无或审计状态；状态有文字，不只靠颜色。局部颜色与（8px）控件圆角从当前 CSS 描述，不改全局 token。
- 原生 button/select/input/summary 最小高度（44px），焦点（3px，偏移 3px），减少动态偏好关闭动画／过渡；不继承旧 brief 中未实现的 160ms 淡入承诺。
- 两页正式 route-shell 的既有助手 launcher 位于文档返回工具栏，随页面滚走，使用共享导航既有 ≤1090px 断点，展开助手时隐藏 launcher；共享 YAYA／导航／AUTH 未变。

## Data, records and teacher boundaries

- 只使用服务端 `ChildEvidenceBook` DTO；不在组件重算正式状态，`counts_toward_status / excluded_reason / reliability` 读取正式字段。相关记录数按 observation_id 展示，是来源数量，不是儿童发展指标。
- 三种正式文案固定为“暂无相关记录、已有相关线索、已确认观察到”；AI 待核对、撤回、不采用及失效依据只作流程／审计信息，不成为第四种状态。
- `unavailable` 隐藏确定性“暂无”展示，说明暂时读不到；`partial + no_records` 提示还有记录待核对，不断言不存在观察。UNKNOWN ≠ 0，不把损坏／未读当成功或真实空值。
- 原文、教师确认稿来源、观察日期与发生班级快照逐字可查；历史不按当前学段排除，缺少 class_context 显示“当时班级未记录”，不回填当前班级。
- 正式来源按 observation_id 分组、按日期倒序，先展示最近记录；其他记录由原生 details 展开，同源不同片段保留且去除重复引用。
- `renderRecord` 仅把所有依据都属于该 observation_id 的关联备注／连续纪要放在此记录内；跨记录关联的备注留在带完整依据的“查看关联详情”，旧备注不能误挂最新引用。
- 关联详情保留成人帮助、教师备注、连续纪要期间、撤回日期／原因与逐条核验失败提示；允许帮助的条目不自动降级，明确要求独立完成的条目按规则保留线索。
- 保健参考为“资料参考／参考资料”查阅分支，不套用行为确认徽章、不参与行为统计、不作正常／异常评价；内部关联状态仍保留供审计。
- “记录相关观察”只带儿童／条目与合法返回上下文，复用原流程，不预填“已做到”，不直接写正式证据。管理员无教学写入口，最终权限仍来自服务端；raw_text 永不改写，AI 与教师确认分离。

## Controlled interface and route integration

`ChildEvidenceBookProps` 使用现有 book、semesters、onScopeChange、onFiltersChange、onRecordObservation、focusedItemId、className，不新增共享契约。

- 期间值严格来自 book.scope；自定义日期是草稿，标明尚未应用／已应用。拒绝／读取失败后编辑区仍可达，复用 parseIsoDateStrict 拒绝空值、非法日历与倒置期间。
- 领域切换含“全部”清空 goal_id；上级目标限制有明确范围与解除入口。组件内“查看目标”只改变阅读子集，不伪造正式数据。
- EvidenceRouteClient 以当前授权 DTO 装配正式路由；期间／筛选经 URL 导航重新读取，pending 有读取提示。班级下钻带入相同期间／筛选、目标与 item_id，个人页展开后可回到记录流程。
- 生产组件没有固定“合成数据”徽章；实际合成名册内容与验收 fixture 的标记保留在各自证据层，不从方向图补造业务事实。

## Historical G3 / QA1 fixture record — retained

以下保留旧 brief 的验收历史原文；旧接线范围、装置流程、detector 与 NOT_RUN 只描述当时，不作为当前实现或本轮执行结论。当前证据与最终七项 verdict 见下一节。

### Fixture 自洽（脚本化检查）
- 正式来源全部通过核对且落在所选期间内；跨期记录（`basis_out_of_period`）只作审计，不计入正式状态、不降可靠性。
- `unavailable` 样本无可读依据；`partial` 覆盖“无可读关联”和“仅失效审计关联”两种样本；同源多片段内容不同且 key 唯一。
- 引文主体与档案主角一致（完整示例=小雨；大目录=禾禾，发生班级为大班快照）。
- 保健参考为身高/体重测量资料示意（不含午睡/洗手），`counts_in_behavior_stats=false`，文本与引文无正常/异常/达标判断，内部关联状态保留。
- 检查命令：`pnpm tsx scripts/check-child-evidence-book-fixtures.ts`（输出 `fixture_only: true`）。

### 可复现浏览器验收（一键，含清理）
```
node scripts/check-child-evidence-book-browser.cjs <证据输出目录>
```
- 装置：`scripts/check-child-evidence-book-browser.cjs`（runner）+ `scripts/__fixtures__/guide-preview-page.tsx`（预览模板，非路由）。
- 流程：把模板复制为临时 `src/app/guide-preview/page.tsx`（已存在则拒绝、绝不覆盖）→ 启动 `next dev`（默认端口 3210，可用 `G3_PORT` 覆盖；启动前检测端口占用并立即报错，不误杀他人进程）→ 运行 127 项断言 → `taskkill` 结束服务 → 只删除本次创建的临时路由与空目录，并移除 `.next` 中引用 `guide-preview` 的生成类型，保证验收后 `pnpm ts-check` 可直接复跑。
- 依赖解析：playwright-core 依次取 `G3_PLAYWRIGHT_CORE` → 项目 node_modules → 临时目录 `pnpm add playwright-core --prefer-offline`；浏览器依次取 `G3_CHROME` → 常见 Chrome/Edge 路径 → `channel: chrome`。
- 预览逻辑：每次筛选都从完整初始 fixture 重新计算展示子集（`buildFixtureView`），不在已缩小的 `book.goals` 上继续过滤、不修改原 fixture；清除目标/领域/年龄后恢复对应全部内容，保留其他生效筛选与当前期间。预览页有常驻免责声明：“不代表 G5 读模型或真实期间统计；期间选择不会重算证据”，并由断言固定。
- 不保留生产可访问 mock 路由；不写数据库、不调用模型。

### Finish evidence（fixture 组件验收，非业务闭环）
- QA1 复测：浏览器 **127/127** 通过；离线 fixture 检查 **63/63** 通过。截图与 results.json：`C:\Users\nanpr\AppData\Local\Temp\opencode\g3-evidence-qa1\`（rich 三断点、rich-1440-expanded、unavailable-1440、large-1440、rich-390-longtext）。主组件自 R2 起冻结，QA1 只改验收装置。
- QA1 新增内容断言（不只回调/控件/横幅）：完整 6 目标/12 条目基线；领域语言 2 目标/4 条目 → 切回全部恢复 6/12；年龄 4～5 共 6 条 → 切回全部恢复 12；目标限定 1 目标/2 条目 → 解除恢复 6/12；组合筛选（领域+年龄+目标）逐项解除后按 2/2 → 6/6 → 6/12 恢复；只读探针确认原 fixture 未被修改（6/12）；免责声明常驻。临时路由、服务与 `.next` 生成类型全部清理（验收后 `pnpm ts-check` 直接通过）。
- R2 反例断言保留：保健参考收起/展开均无表现确认徽章与达成式反馈（含具体分组“可查阅的参考资料”、标签“资料已核对/教师核对关联/单次资料”、`data-status` 审计保留）；partial+links=[] 不断言“没有记录”、提示改“未计入当前状态”；partial 仅失效关联仍在审计区；custom→all_history / custom→semester 被拒后编辑区仍可达且日期可编辑、成功切换与外部恢复范围一致；非法日期不发回调；同源多片段全部显示且无重复 key 警告。
- Impeccable detector（primary/advisory 分开）：**primary 0 anti-patterns**；advisory 21 条（组件样式 18 条为非首页设计值未写入 DESIGN.md 的已知项，预览模板 3 条为验收装置内联色）——均不属反模式，不为消除 advisory 改动既有画风。
- NOT_RUN（未执行，不得当作通过）：G5 读模型与 API 未接入（无真实 DTO 数据链路）；真实 StepFun/Coze 调用与实库迁移/写入；正式详情页集成与正式路由历史返回（组件无内部路由状态，返回等价于外部 scope 变更，已用外部切换覆盖）；正式业务全链路验收。浏览器验收仅为 fixture 组件验收。

## Evidence and scoped disposition

- 交付记录 `docs/guide-evidence-v1/evidence-ui-polish-delivery.md`；正式套件 `output/playwright/evidence-pages-206ffba5/results.json` 保存 103/103、errors=[]、model_requests=0、guard_attempts=0、cleanup_issues=[]。
- 套件使用真实 Next 生产 HTTP + AUTH + 自有隔离 PostgreSQL + Chrome、合成验收数据；视口 1440×900、1440×1024、1024×768、768×1024、390×844。真实读链路与注入 HTTP 故障、受控迟到响应分别记录。
- 个人组件 `output/g3-verdict-final/results.json` 为 133/133（旧 127 + 新 6 项备注归属检查），班级组件 `output/g4-verdict/results.json` 为 115/115；均是合成组件 fixture，不升级为实库或正式持久化业务证明。
- `output/g3-verdict-final/notes-1440.png / notes-390.png` 显示新旧备注各归其 observation，属于组件合成 fixture；其中旧固定 launcher 不代表正式两页的工具栏定位回归。
- `class-long-token-1440.png / class-long-token-390.png` 是 DOM 排版 double，不是业务引用或持久化长文本证据；正式套件注入 403/503 的预期 console 日志另列，无 JS crash 的记录不等于无预期 HTTP 错误。
- 纯检查 34/34（来源 parser/Response 替身）、42/42（班级 fixture）、63/63（个人 fixture）；validate 与 Next + tsup 构建通过见交付记录。本次仅核对已有结果／源码／捕获，没有复跑验收。
- 初始 `.impeccable/review/evidence-ui-polish/REVIEW.md` 保留历史；最终 `VERDICT-1.md` disposition: ship，仅原七项 F1–F7 resolved，不代表两页全范围重评、整站／生产／真实模型认证。
- 人工布局比较见 `design-qa.md` 本任务追加段；没有 comp-diff 分数、FORM seed、QUALITY BAR 或 hero gate PASS。本轮无新 shipped UI raster assets，方向图的 `PROMPTS.md / provenance.json` 保留来源。

## History, drift and NOT_RUN

早期 G3/G3-R1/G3-R2、QA1 的 127/127 浏览器与 63/63 纯检查属于组件 fixture 阶段；本次正式 HTTP／AUTH／隔离 DB 接线证据独立记录，不 retroactively 改成早期业务验收。旧 detector 的 primary/advisory 记录仍属历史，本次不再次运行 context／detector。

既有 DESIGN 非首页色彩／字体占位及“尚未实现”文字仍有漂移；home-* 不扩展到本页。当前背景比方向图更暖，是保留全局主题的有意适配，不修复、不把局部字号／圆角提升为系统标准，不改 DESIGN／sidecar／config。

NOT_RUN：真实 provider、托管 DB／对象桶、生产数据／部署、真实手机／软键盘、Safari、人工屏幕阅读器；本次未启动服务、访问 DB／provider／网络、安装依赖、push／merge。
