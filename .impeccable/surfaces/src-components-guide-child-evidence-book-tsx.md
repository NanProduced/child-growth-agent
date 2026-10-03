---
version: 2
slug: "src-components-guide-child-evidence-book-tsx"
primary_target: "src/components/guide/child-evidence-book.tsx"
related_targets: ["src/components/guide/child-evidence-book.module.css","src/components/guide/__fixtures__/child-evidence-book-fixture.ts","scripts/check-child-evidence-book-fixtures.ts"]
---

# 个人证据册 ChildEvidenceBook — 指南证据链 G3/G3-R1（fixture 组件验收）
Mode: Operate. Scope: 只读组件（含筛选、展开与回调意图）。正式路由、API 接入与页面重排由 G6 处理；本轮不接真实 API、不改正式详情页。

## Direction contract
THESIS: 教师像翻一本观察册一样，按综合目标逐条回看这个孩子已有的观察证据，随时能回到逐字事实；状态是证据核对的结果，不是对孩子的判断。
OWN-WORLD: 沿用既有“轻量成长观察册”：暖白画布、深墨正文、芽绿只用于主行动与已确认状态、晨光蓝用于线索与目标范围、观察琥珀用于流程待办、柔和珊瑚用于核验提示；圆角 12–16px、1px 暖灰细线、无卡片嵌套、无阴影堆叠。不引入首页绘本场景、雷达、进度、百分比或达标符号。
STORY: 只读身份与统计期间 → 五大领域切换 → 指南参考年龄段 → 目标范围说明（如上级限定了目标）→ 综合目标分组 → 具体表现行（正式状态 / 相关证据数 / 最近证据日期 / 核验提示）→ 按需展开来源（逐字片段、出处、日期、发生班级、成人帮助、教师说明、排除原因）→ “记录相关观察”。
FIRST VIEWPORT: 标题与只读身份、期间控制、领域与年龄段筛选、首个目标的条目行；核心控件 ≥44px，无横向溢出。
FORM: 契约 docs/guide-evidence-v1/contract.md（G0-R1 冻结）与 DESIGN.md“Guide evidence chain”口径；数据形状只用 `ChildEvidenceBook` DTO，不新增共享类型。
SIGNATURE: 条目行展开时来源面板轻量淡入（160ms ease-out），来源按“正式依据 / 流程与审计”分区；减少动态偏好下取消动画，仅保留展开状态与焦点。
FINISH: 三种正式状态文案固定；技术不可靠先以核验提示呈现，不画成第四种状态；“AI 关联待核对 / 已撤回 / 已不采用 / 失效依据”只作流程或审计信息；fixture 浏览器验收与真实业务链路分开声明。

## Constraints
- 不改 G0 冻结文件、queries.ts、业务 API、`src/app/children/[id]/page.tsx`、全局 DESIGN.md 与 globals.css。
- 不在组件内另算正式状态、✓ 或百分比；`counts_toward_status`、`excluded_reason`、`reliability` 一律读取服务端字段；技术提示不改变正式状态算法。
- 自建 DTO fixture 只供组件与临时预览使用，不进入生产数据读取链路。
- 个人历史不按当前学段排除；证据发生时班级只来自 `class_context` 快照，未知即显示未知，不用当前班级回填。
- 保健参考（`evidence_type=health_reference`）只标“保健参考”并说明只作资料参考，不套用表现确认与成人帮助规则，不显示能力百分比或达标符号。
- 不显示“完成 X/Y 条”、能力雷达或个人百分比；`status_counts` 不渲染为进度。

## Component interface（G6 接入约定）
```ts
interface ChildEvidenceBookProps {
  book: ChildEvidenceBook;                       // G0 冻结 DTO，只读
  semesters?: SemesterPeriod[];                  // G2 显式学期配置；缺省时仅当前范围、全部历史与自定义日期
  onScopeChange?: (scope: EvidenceScopeIntent) => void;   // {semester|all_history|custom_range}
  onFiltersChange?: (filters: EvidenceViewFilters) => void; // domain_code / age_band；切领域（含“全部”）一律清空 goal_id
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void; // 不预填已做到
  className?: string;
}
```
- 受控组件：期间控件值严格等于 `book.scope`；筛选来自 `book.filters`；点击只发意图，不本地改业务状态；G6 负责 URL 与重新取数，**无需强制换 key 重挂载**。
- 接口缺口（提请调度协调，不自行扩展契约）：DTO 不含可选学期列表，G3 用 `semesters` 属性承接 G2 配置；缺省时仍可切“全部历史/自定义日期”。

## Shipped rules（R1 修正后）
- **可靠性优先**：`reliability=unavailable` 时行首先显示“资料暂不可读”核验提示（珊瑚描边 + 图标，非第四种状态徽章），隐藏普通“暂无相关记录”徽章与确定性空态，展开区说明无法核对；`partial` 时行首提示“以下呈现只依据已核验的资料；另有部分资料未通过核对……”，不写“下限”或能力判断，且不把正常期间排除写成数据异常（期间排除条目保持 `reliable`、无核验提示）。
- **受控期间与日期草稿**：期间控件值只来自 `book.scope`；自定义日期草稿可保留并明确标注“（尚未应用）/（已应用）”，不冒充生效范围；外部切换、父级拒绝或恢复旧 scope 时控件与数据一致；应用日期复用 `parseIsoDateStrict`，空值/非法日历日期/起止倒置只提示、不发意图。
- **筛选一致性**：切任何领域（含“全部”）均发 `goal_id: null`；上级限定 `goal_id` 时显示目标范围横幅与“查看全部目标”解除入口；全部领域模式在目标标题上补“领域 · 子领域”定位，避免重复目标序号混淆。
- **来源展开**：正式依据（`counts_toward_status=true`）在前，流程与审计（待核对/不采用/撤回/被排除）在后并标注原因；失效依据逐条标注核对失败原因，仍保留审计展示；同源多片段以 `link_id + observation_id + 序号` 作 key。
- **展示文案**：确认稿出处显示“教师确认稿 · 原文引用 / 证据片段”（内部字段仍为 `highlight_quote` / `highlights`）；成人帮助按条目规则与本次事实并列；保健参考支持标签使用“单次资料/连续资料/参考线索”，规则行不出现“可确认表现”。
- **响应式**：390 单列，768 控件自然换行，1440 内容限宽；长文本 `overflow-wrap: anywhere`，无横向滚动；核心目标 ≥44px，焦点 3px 外扩。

## Fixture 自洽（脚本化检查）
- 正式来源全部通过核对且落在所选期间内；`first/latest_observed_at` 同样受期间约束。
- 跨期记录（`basis_out_of_period`）只作审计，不计入正式状态、不降可靠性。
- `unavailable` 样本无可读依据；`partial` 样本含未通过核对的资料；同源多片段内容不同且 key 唯一。
- 引文主体与档案主角一致（完整示例=小雨；大目录=禾禾，发生班级为大班快照）；保健参考 `counts_in_behavior_stats=false`。
- 检查命令：`pnpm tsx scripts/check-child-evidence-book-fixtures.ts`（输出 `fixture_only: true`）。

## Finish evidence（fixture 组件验收，非业务闭环）
- 方式：本地 `next dev` + 临时未提交 `/guide-preview` 路由（验收后已删除，未产生生产可访问 mock 表面）；Playwright-core 1.63.0 驱动本机 Chrome。
- R1 复测：浏览器 **84/84** 通过；离线 fixture 检查 **51/51** 通过。截图与 results.json 存工作树外 `C:\Users\nanpr\AppData\Local\Temp\opencode\g3-evidence-r1\`（`rich-1440x900.png`、`rich-768x1024.png`、`rich-390x844.png`、`rich-1440-expanded.png`、`unavailable-1440.png`、`large-1440.png`、`rich-390-longtext.png`）。
- 浏览器断言覆盖：真实 DOM 顺序（核验提示为行首元素）、控件值（select 严格反映 `book.scope`）、回调参数（filters/scope/record payload）、unavailable 无普通空态、partial 提示优先且不含“期间”、外部切换 scope、父级拒绝、日期未应用、非法日期不发回调、goal_id 进入后“全部”确实清空、跨期不进入正式计数、保健参考无普通表现判定文案、同源多片段全部显示且无重复 key 警告、三断点无横向溢出与 ≥44px。
- 可重跑浏览器检查（需本机 Chrome 与临时 playwright-core；脚本存工作树外）：
  `node C:\Users\nanpr\AppData\Local\Temp\opencode\g3-browser\check.cjs <证据输出目录>`（先启动 `next dev -p 3100`）。
- Impeccable detector：`0 anti-patterns`；18 条 advisory 均为非首页设计值未写入 DESIGN.md 的已知状态（DESIGN.md 明示非首页值未解析，本地色板见本 brief）。
- NOT_RUN（未执行，不得当作通过）：G5 读模型与 API 未接入（无真实 DTO 数据链路）；真实 StepFun/Coze 调用与实库迁移/写入；正式详情页集成、正式路由与浏览器返回的真实路由历史（组件无内部路由状态，返回等价于外部 scope 变更，已用外部切换覆盖）；正式业务全链路验收。浏览器验收仅为 fixture 组件验收。
