---
version: 1
slug: "src-components-guide-child-evidence-book-tsx"
primary_target: "src/components/guide/child-evidence-book.tsx"
related_targets: ["src/components/guide/child-evidence-book.module.css","src/components/guide/__fixtures__/child-evidence-book-fixture.ts"]
---

# 个人证据册 ChildEvidenceBook — 指南证据链 G3（fixture 组件验收）
Mode: Operate. Scope: 只读组件（含筛选、展开与回调意图）。正式路由、API 接入与页面重排由 G6 处理；本轮不接真实 API、不改正式详情页。

## Direction contract
THESIS: 教师像翻一本观察册一样，按综合目标逐条回看这个孩子已有的观察证据，随时能回到逐字事实；状态是证据核对的结果，不是对孩子的判断。
OWN-WORLD: 沿用既有“轻量成长观察册”：暖白画布、深墨正文、芽绿只用于主行动与已确认状态、晨光蓝用于线索、观察琥珀用于流程待办、柔和珊瑚用于核验提示；圆角 12–16px、1px 暖灰细线、无卡片嵌套、无阴影堆叠。不引入首页绘本场景、雷达、进度、百分比或达标符号。
STORY: 只读身份与统计期间 → 五大领域切换 → 指南参考年龄段 → 综合目标分组 → 具体表现行（正式状态 / 相关证据数 / 最近证据日期 / 核验提示）→ 按需展开来源（逐字片段、出处、日期、发生班级、成人帮助、教师说明、排除原因）→ “记录相关观察”。
FIRST VIEWPORT: 标题与只读身份、期间控制、领域与年龄段筛选、首个目标的条目行；核心控件 ≥44px，无横向溢出。
FORM: 契约 docs/guide-evidence-v1/contract.md（G0-R1 冻结）与 DESIGN.md“Guide evidence chain”口径；数据形状只用 `ChildEvidenceBook` DTO，不新增共享类型。
SIGNATURE: 条目行展开时来源面板轻量淡入（160ms ease-out），来源按“正式依据 / 流程与审计”分区；减少动态偏好下取消动画，仅保留展开状态与焦点。
FINISH: 三种正式状态文案固定；“AI 关联待核对 / 已撤回 / 已不采用 / 失效依据”只作流程或审计信息；技术不可靠不画成第四种状态；fixture 浏览器验收与真实业务链路分开声明。

## Constraints
- 不改 G0 冻结文件、queries.ts、业务 API、`src/app/children/[id]/page.tsx`、全局 DESIGN.md 与 globals.css。
- 不在组件内另算正式状态、✓ 或百分比；`counts_toward_status`、`excluded_reason`、`reliability` 一律读取服务端字段。
- 自建 DTO fixture 只供组件与临时预览使用，不进入生产数据读取链路。
- 个人历史不按当前学段排除；证据发生时班级只来自 `class_context` 快照，未知即显示未知，不用当前班级回填。
- 保健参考（`evidence_type=health_reference`）只标“保健参考”，不显示能力百分比或达标符号。
- 不显示“完成 X/Y 条”、能力雷达或个人百分比；`status_counts` 不渲染为进度。

## Component interface（G6 接入约定）
```ts
interface ChildEvidenceBookProps {
  book: ChildEvidenceBook;                       // G0 冻结 DTO，只读
  semesters?: SemesterPeriod[];                  // G2 显式学期配置；缺省时仅当前范围、全部历史与自定义日期
  onScopeChange?: (scope: EvidenceScopeIntent) => void;   // {semester|all_history|custom_range}
  onFiltersChange?: (filters: EvidenceViewFilters) => void; // domain_code / age_band（goal_id 透传；切领域时清空 goal_id）
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void; // 不预填已做到
  className?: string;
}
```
- 受控组件：筛选与期间状态来自 `book.filters` / `book.scope`，点击只发出意图，不本地改状态；G6 负责 URL 与重新取数。
- 接口缺口（提请调度协调，不自行扩展契约）：DTO 不含可选学期列表，G3 用 `semesters` 属性承接 G2 配置；缺省时仍可切“全部历史/自定义日期”。

## Shipped rules
- 状态徽章只用三种固定文案；`reliability=partial/unavailable` 时在状态之前先显示核验提示，unavailable 明示“不能按暂无相关记录理解”。
- 来源展开：正式依据（`counts_toward_status=true`）在前，流程与审计（待核对/不采用/撤回/被排除）在后并标注原因；失效依据逐条标注核对失败原因，仍保留审计展示。
- 成人帮助：条目规则（`allowed` / `requires_independence`）与本次 `adult_help_used`、`teacher_note` 如实并列，不降级展示、不改写服务端决定。
- 期间与年龄：统计期间按 `observed_at`（含首尾）；“指南参考年龄段”明确标注只作阅读参考，不等于发生时学段。
- 响应式：390 单列，768 控件自然换行，1440 内容限宽；长文本 `overflow-wrap: anywhere`，无横向滚动；核心目标 ≥44px，焦点 3px 外扩。

## Finish evidence（fixture 组件验收，非业务闭环）
- 方式：本地 `next dev` + 临时未提交 `/guide-preview` 路由（验收后已删除，未产生生产可访问 mock 表面）；Playwright-core 1.63.0 驱动本机 Chrome，43/43 检查通过（脚本与截图存工作树外 `C:\Users\nanpr\AppData\Local\Temp\opencode\g3-evidence\`，results.json 含逐条明细）。
- 断点：1440×900 / 768×1024 / 390×844 均无横向溢出、核心目标 ≥44px；截图 `rich-1440x900.png`、`rich-768x1024.png`、`rich-390x844.png`、`rich-1440-expanded.png`、`unavailable-1440.png`、`large-1440.png`、`rich-390-longtext.png`。
- 已验证交互：领域/年龄段筛选回调、学期/全部历史/自定义日期（非法范围只提示不发意图）、条目展开收起、键盘 Enter 与 Tab 焦点进入记录操作、记录相关观察回调（child_id + item_id）、减少动态偏好（动画/过渡为 none）、三种状态与 AI 待核对/撤回/失效/历史未知/成人帮助/保健参考文案、partial/unavailable 核验提示、大目录 ≥60 条、390 长文本展开。
- NOT_RUN（未执行，不得当作通过）：G5 读模型与 API 未接入（无真实 DTO 数据链路）；真实 StepFun/Coze 调用与实库迁移/写入；正式详情页集成与正式路由（G6）；正式业务全链路验收。浏览器验收仅为 fixture 组件验收。
