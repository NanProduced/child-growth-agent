---
version: 6
slug: "src-components-guide-class-evidence-overview-tsx"
primary_target: "src/components/guide/class-evidence-overview.tsx"
related_targets: ["src/components/guide/class-evidence-overview.module.css","src/components/guide/evidence-route-client.tsx","src/lib/guide/evidence-read.ts","src/components/guide/__fixtures__/class-evidence-overview-fixture.ts","scripts/check-class-evidence-overview.ts","scripts/acceptance/check-class-evidence-ui.cjs","scripts/check-evidence-pages-browser.cjs"]
---

# 班级指南证据概览 — 证据下钻工作台

Mode: Operate. Scope: 两类证据页面普通扩展中的班级页，正式路由 `/classes/[id]/evidence`，只读授权 DTO 与既有记录入口。记录本地候选的实际实现，不建立新的视觉世界或全站规则。

## Direction contract

THESIS: 从指南条目人数分布，进入一个条目的幼儿名单与逐字观察，再同期间下钻个人证据册。
OWN-WORLD: 沿用“轻量成长观察册”的暖白、深墨、芽绿、细线与浅色面；绿色和蓝色辅助识别证据状态，不表达能力等级。
STORY: 班级身份／当前在班名单与期间 → 领域／参考年龄筛选 → 行为条目分布 → 单一详情、名单与引用 → 同范围个人证据册；保健资料独立查阅。
FIRST VIEWPORT: 优先连续可扫读的指南原文与对齐人数条；说明按需展开。窄屏详情是单独阅读状态，可返回指南条目，不能把滚动后的详情截图当初始首屏。
FORM: 用户选择第三稿“证据下钻工作台”；方向图为 `docs/design/class-overview-v2-20261008/03-evidence-workspace.png`。按布局关系适配授权 DTO，不照搬图中合成姓名、20 人分母或短标题。
SIGNATURE: 实际 N 的共同人数标尺、一个选中条目与一个 inspector；保健参考收在独立折叠入口，统计说明用页内中文阅读区。

## Implemented layout and local styles

- 未选条目时主栏全宽；容器宽度 ≥1000px 且存在详情时为主栏 + 360px inspector，间隔 24px，详情顶端 sticky 24px；这是容器断点，不是固定 1024px 视口断点。
- 容器 <1000px 时，选中条目后隐藏主列表、展示同一个详情；“返回指南条目”关闭详情并恢复原触发按钮焦点。Portal 挂到独立详情区域，不叠多个绝对定位面板。
- 行为条目完整原文、人数条和操作对齐；共享图例保留三种正式文案。参考年龄集中在筛选／详情，短占比的完整分母及期间仍有可访问文字。
- 保健参考默认收起，位于主列表底部独立 `details/summary`；展开后原文、来源与个人入口仍可读，不参与行为统计、不作正常／异常判定。
- “统计说明”由 `aria-expanded/aria-controls` 展开页内 section，无模态遮罩；使用“资料完整时”“还有资料待核对”“暂时读不到”等中文，保留分母、期间、三态和参考资料边界。
- 局部页面标题（24px）、工作区／详情标题（18px）、指南原文与引用（16px），辅助标签／日期多为（14px）；其余容器／说明仍有（15px），不写成全站统一字号。
- 字体使用现有 `Home Noto Sans SC / Microsoft YaHei / sans-serif` 栈；原文与引用 `overflow-wrap: anywhere`，不据此宣称完整业务字形或跨系统字体已验收。
- 列表为平面细分隔，详情无阴影；控件（8px）、工具栏（12px）、引用容器（10px）是当前局部尺寸。绿／蓝／琥珀／珊瑚用现有页面 CSS，文字与细线关联全局主题，不提升为新 token。
- 原生 button/select/input 与 summary 最小高度（44px）；清晰焦点（3px，偏移 2px），减少动态偏好下关闭动画／过渡。灰底“暂无相关记录”标签明确保留深色字。
- 两页正式 route-shell 将既有助手 launcher 停靠文档顶部返回工具栏，随页面滚走；使用已有导航 ≤1090px 断点，助手展开时隐藏 launcher。只在这两个页面生效，共享 YAYA、导航与 AUTH 未改。

## Data, source and teacher boundaries

- 人数、分母与占比读取服务端 `ClassEvidenceOverview`；`peopleTicks(N)` 生成 0–N 整数标尺，段宽按 DTO 人数比例呈现。0 人不产生占比；正式本地样本 N=3 是验收数据，不是显示常量。
- 仅可靠的具体行为条目显示既有“已确认观察到占比”，带分母与期间；不新增领域总分、聚合指标、雷达、排名或教学成效结论，不将跨条目人数相加。
- `partial` 只显示服务端可确认人数下限，不给余数补“暂无”；`unavailable` 不画普通三态分布、不显示正常 0%，保留名单分母与个人入口。UNKNOWN ≠ 0，技术异常不是第四种儿童状态。
- 来源实际读取 `GET /api/children/[id]/evidence-book` 的 `links[].basis[]`，复用既有链接 schema；核对儿童、当前班级／阶段、目录版本、期间、筛选、条目及全部必需依据，不把损坏 JSON 当空记录。
- 读取绑定账号投影、儿童、条目、范围和本次服务端 item 对象；切换／取消后的旧响应不能写回新目标或清除新 loading。401 重新核验身份，损坏／范围变化刷新概览，其他失败保留重试和明确提示，不显示假引用。
- 引用原样呈现来源文字、日期、原始观察／教师确认稿标签与发生时班级快照；未知班级不回填。指南允许成人帮助时不自动降级，独立要求按条目处理。
- 下钻保留期间、筛选、目标与 focused item；记录入口复用原有教师流程，不预填“已做到”。管理员只读，客户端可见性不代替服务端授权；raw_text 与教师确认边界保持不变。

## Historical component acceptance — retained

以下保留旧 brief 的验收历史原文；旧接线范围、装置流程、detector 与 NOT_RUN 只描述当时，不作为当前实现或本轮执行结论。当前证据与最终七项 verdict 见下一节。

### 验收与回归
- 离线 fixture 自检：`pnpm exec tsx scripts/check-class-evidence-overview.ts`：**42/42 通过**；
- 浏览器全景验收装置：`scripts/acceptance/run-class-evidence-ui-check.ps1` 在端口 3123 启动真实 Chromium：
  - 覆盖 1440×900, 768×1024, 390×844 视口；
  - 覆盖 reliable, partial, unavailable, health-reference, empty-roster 各场景；
  - 覆盖键盘 Tab/Enter 导航、无障碍焦点落点、筛选受控与钻取回调；
  - **115/115 全量通过**（exit code 0）；
- 代码质量与类型：`pnpm ts-check`（0 errors）、`pnpm lint:build`（0 errors）、`pnpm lint:style`（0 errors）；
- Impeccable 检测器：`impeccable detect --json`：**0 primary violations**。

### NOT_RUN
非 Windows/非 PowerShell 环境；真实 StepFun/Coze LLM 调用（本轮模型预算为 0）；生产数据库写入。

## Evidence and scoped disposition

- 交付记录：`docs/guide-evidence-v1/evidence-ui-polish-delivery.md`；正式页面结果：`output/playwright/evidence-pages-206ffba5/results.json`，保存记录 103/103、errors=[]、model_requests=0、guard_attempts=0、cleanup_issues=[]。
- 正式套件基于真实 Next 生产 HTTP + AUTH + 自有隔离 PostgreSQL + Chrome，使用合成名册；包括真实分母、逐字引用、唯一详情、关闭焦点、越班拒绝与管理员只读。注入 HTTP 故障和受控迟到响应单独标注。
- `class-long-token-1440.png / class-long-token-390.png` 是明确标注的 DOM 排版替身，只证明换行；不证明长文本持久化业务链路。
- 班级原组件浏览器覆盖 115/115（`output/g4-verdict/results.json`，合成 fixture），不冒充实库统计验收；纯检查分别 34/34（parser/Response 替身）、42/42（班级 fixture）、63/63（个人 fixture）。
- `pnpm validate` 与 Next + tsup 构建通过见交付记录；本次仅文档核对，没有复跑、启动服务、访问 DB／provider／网络、安装依赖或再次运行 context／detector。
- 初始 `.impeccable/review/evidence-ui-polish/REVIEW.md` 保留 FIX 历史；最终 `VERDICT-1.md` disposition: ship，F1–F7 全部 resolved，仅限 ORIGINAL SEVEN FIXES ONLY，不等于两页全范围、全站或生产认证。
- 人工布局比较与选定原图、正式捕获记录见 `design-qa.md` 的本任务追加段；没有补造 comp-diff 分数、FORM seed、QUALITY BAR 或 hero gate PASS。
- 本轮无新 shipped UI raster assets。方向图相邻 `PROMPTS.md / provenance.json` 保留生成来源；班级 provenance 的 pending/approved:false 是生成时历史，最新用户选择与交付记录决定本轮方向，不改元数据。

## Drift and NOT_RUN

既有 DESIGN 的非首页色彩／字体占位及“尚未实现”口径仍有漂移，home-* 仍只约束首页。两页比方向图更暖的背景是继承主题的有意适配；本轮仅记录，不修复、不固化为新全站标准，不改 DESIGN、sidecar 或 config。

NOT_RUN：真实 provider、托管 DB／对象桶、生产数据／部署、真实手机／软键盘、Safari、人工屏幕阅读器；未 push／merge。
