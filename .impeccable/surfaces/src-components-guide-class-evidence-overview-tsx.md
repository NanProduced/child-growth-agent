---
version: 1
slug: "src-components-guide-class-evidence-overview-tsx"
primary_target: "src/components/guide/class-evidence-overview.tsx"
related_targets: ["src/components/guide/class-evidence-overview.module.css","src/components/guide/__fixtures__/class-evidence-overview-fixture.ts"]
---

# 班级指南证据概览 ClassEvidenceOverview — 指南证据链 G4（fixture 组件验收）
Mode: Operate. Scope: 只读组件（含期间/领域/参考年龄筛选、三类儿童名单展开与回调意图）。正式路由、API 接入与页面装配由 G6 处理；本轮不接真实 API、不改 `classes/[id]/page.tsx`、不做班级数据驾驶舱。

## Direction contract
THESIS: 教师打开班级页时，先看到“这是在班名单 + 某段时间里的观察证据”，再按五大领域逐条查看三类儿童的分布；人数与占比是读模型核对的结果，不是对幼儿的评价。
OWN-WORLD: 沿用既有“轻量成长观察册”：暖白画布、深墨正文、芽绿只用于“已确认观察到”与主操作、晨光蓝用于“已有相关线索”、中性灰用于“暂无相关记录”、观察琥珀用于下限与流程、柔和珊瑚用于不可读核验；圆角 10–16px、1px 暖灰细线、无卡片嵌套、无阴影堆叠。不引入首页绘本场景、雷达、饼图、进度环或达标符号。
STORY: 班级身份与统计期间/名单口径 → 通知（转入来源、未知历史、排除理由、AI 失败） → 期间与领域/参考年龄筛选 → 综合目标分组 → 具体表现行（分布条 + 文字图例 + 占比 X/N 人 · 期间）→ 按需展开“已确认观察到 / 已有相关线索 / 暂无相关记录”三类幼儿名单 → 查看个人证据（同一筛选范围钻取）/ 记录观察 / 活动支持。
FIRST VIEWPORT: 标题、班级与学年、当前名单 20 人、统计期间、期间与名单口径说明、筛选项与首个目标条目行；核心控件 ≥44px，无横向溢出。
FORM: 契约 docs/guide-evidence-v1/contract.md（G0-R1 冻结）与 DESIGN.md“Guide evidence chain”口径；数据形状只用 `ClassEvidenceOverview` DTO，不新增共享类型。
SIGNATURE: 每条表现使用一条 10px 横向分布条 + 三行文字图例（标签 + 人数），比例由读模型给出；partial 分布以虚线下限处理，unavailable 不画分布。展开名单轻量淡入（160ms ease-out），减少动态偏好下取消。
FINISH: 三种正式状态文案固定；“AI 关联待核对”只作流程提示且明确“不计入人数”；`confirmed_ratio=null` 一律不画正常 0% 并说明原因；技术不可靠不画成第四种状态；fixture 浏览器验收与真实业务链路分开声明。

## Constraints
- 不改 G0 冻结文件、queries.ts、业务 API、`src/app/classes/[id]/page.tsx`、全局 DESIGN.md 与 globals.css。
- 人数、分母、`confirmed_ratio`、三类儿童状态全部读取 DTO，不从 roster 或分页名单重算；组件内不判定儿童能力。
- 占比只有班级页口径，且同时显示 `X/N 人 + 统计期间`；`null` 时按空名单 / 保健参考不统计 / partial 下限 / unavailable 不可读分别说明。
- 班级页不展开来源细节（不渲染片段、不捏造发生班级），钻取到个人证据册核对。
- 所有期间都按 `class_current_roster` 口径：历史期间只回看当前在班幼儿当时的证据，常驻说明“不能还原当时班级名册/不代表教学成效”。
- 不显示达标率、能力总分、弱项排名、领域完成率；无记录固定用“暂无相关记录”，不写“不会”；无红绿等级、无 100% 饼图。
- fixture 自建、纯数据，不写库、不调用模型，不进入生产数据读取链路。

## Component interface（G6 接入约定）
```ts
type ClassEvidenceScopeIntent =
  | { kind: "semester"; semester_id: string }
  | { kind: "all_history" }
  | { kind: "custom_range"; from: string; to: string };

interface ClassEvidenceDrilldown {
  child_id: string;
  item_id: string;
  child_status: "no_records" | "has_clues" | "confirmed_observed";
  scope: EvidenceScope;          // G0 类型，同一筛选范围原样透传
  filters: EvidenceViewFilters;  // domain_code / age_band / goal_id
}

interface ClassEvidenceOverviewProps {
  overview: ClassEvidenceOverview;                       // G5 getClassEvidenceOverview 的 DTO，只读
  semesters?: SemesterPeriod[];                          // G2 显式学期配置；缺省时仅当前范围、全部历史与自定义日期
  onScopeChange?: (scope: ClassEvidenceScopeIntent) => void;
  onFiltersChange?: (filters: EvidenceViewFilters) => void;   // 切领域时清空 goal_id
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void; // 钻取到个人证据册对应条目
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  className?: string;
}
```
- 受控组件：期间/筛选状态来自 `overview.scope` / `overview.filters`，点击只发出意图，不本地改统计；G6 负责 URL 与重新取数（`GET /api/classes/[id]/evidence-overview`）。
- G6 建议路由形态：`/classes/[id]?scope=semester:<id>|all_history|custom&from&to&domain&age_band`；钻取 `/children/<child_id>?item=<item_id>&...同一区间`（具体由 G6 决定）。
- 接口问题（提请调度协调，不自行扩展契约）：`ClassEvidenceScopeIntent` 与 G3 的 `EvidenceScopeIntent` 形状相同但各自私有命名；建议 G6 接入时统一转换，或在 G0-R2 收敛为共享类型。班级 DTO 未提供“转入前证据”的结构化来源摘要，本轮按 notices 文案展示；若 G6/G5 需要结构化展示，请扩 DTO。

## Shipped rules
- 摘要区固定四项：当前在班名单 N 人、统计期间（含首尾）、指南参考年龄、统计方式（按 observed_at、按幼儿去重）。
- 分布按 `counts/total` 展示，条 + 图例双通道；partial 加“可核验下限”；unavailable 只显示核验提示并保留分母，不画 20 个“暂无”。
- 占比行：`已确认观察到占比 P%（C/N 人 · 期间）`；`confirmed_ratio=null` 按原因显示“占比暂不可用：…”。
- 展开面板按三类状态分组，逐名幼儿显示计入证据数（多记录仍按 1 人）、待核对条数（标注不计入人数）、最近证据日期、该幼儿 reliability 提示，以及三个入口（查看个人证据/记录观察/活动支持）。
- 参考年龄只作阅读参考的提示常驻；切换领域不改变统计口径的提示常驻。
- 响应式：>900px 条目左右两栏（原文 + 统计），≤900px 单列；≤480px 图例与摘要改单列；长文本 `overflow-wrap: anywhere`，无横向滚动；焦点 3px 外扩。

## Finish evidence（fixture 组件验收，非业务闭环）
- 方式：本地 `next dev`（127.0.0.1:3101）+ 临时未提交 `/guide-preview-class` 路由（验收后已删除，未产生生产可访问 mock 表面）；Playwright-core 1.63.0 驱动本机 Chrome，**70/70 检查通过**（脚本与截图存工作树外 `C:\Users\nanpr\AppData\Local\Temp\opencode\g4-browser\`、`...\g4-evidence\`，results.json 含逐条明细）。
- 断点：1440×900 / 768×1024 / 390×844 均无横向溢出、核心目标 ≥44px；截图 `main-1440x900.png`、`main-768x1024.png`、`main-390x844.png`、`expanded-1440.png`、`tablet-expanded-768.png`、`empty-roster-1440.png`、`narrow-longtext-390.png`。
- 已验证交互与口径：班级/学年/名单 20 人/期间/参考年龄摘要；转班前来源+排除理由、未知历史、partial 下限、AI 失败按通知展示；6/4/10 分布条+文字等价（无 %、无“不会”）；占比含 30%（6/20 人 · 期间）；全无记录条目显示可信 0%（0/20）；保健参考 ratio=null 且不显示 0%；partial 下限条与 null 占比；unavailable 不渲染分布、显示核验提示、保留分母；展开三类名单 6/4/10、20 人去重、待核对不计入；键盘 Enter 与 Tab 进入名单操作；钻取回调带 child_id+item_id+scope+filters；记录/活动回调；领域与参考年龄筛选回调与数据切换；学期/全部历史/自定义日期（非法范围只提示不发意图）；空名单 0 人无 NaN；减少动态（面板动画 none、按钮过渡 0s）；390 长文本展开；无达标率/完成率/排名/雷达/能力总分/100% 饼图/生成班级 AI 方案按钮。
- NOT_RUN（未执行，不得当作通过）：G5 读模型与 API 未接入（无真实 DTO 数据链路）；真实 StepFun/Coze 调用与实库迁移/写入；`classes/[id]/page.tsx` 正式页面装配（G6）；登录态/权限与正式业务全链路验收。浏览器验收仅为 fixture 组件验收。
