---
version: 2
slug: "src-components-guide-class-evidence-overview-tsx"
primary_target: "src/components/guide/class-evidence-overview.tsx"
related_targets: ["src/components/guide/class-evidence-overview.module.css","src/components/guide/__fixtures__/class-evidence-overview-fixture.ts","scripts/check-class-evidence-overview.ts"]
---

# 班级指南证据概览 ClassEvidenceOverview — 指南证据链 G4-R1（fixture 组件验收）
Mode: Operate. Scope: 只读组件（期间受控 + 草稿、领域/参考年龄/目标筛选、可靠性优先的名单下钻与回调意图）。正式路由、API 接入与页面装配由 G6 处理；本轮不接真实 API、不改 `classes/[id]/page.tsx`、不改 G0 冻结类型与全局样式。

## Direction contract（R1 修订）
THESIS: 教师看到的每一组人数都必须先回答“这份统计可不可信”；不可读取的记录不能被画成“暂无相关记录”，保健参考不能被画成行为表现。
OWN-WORLD: 沿用“轻量成长观察册”（暖白/深墨/芽绿/晨光蓝/观察琥珀/柔和珊瑚、10–16px 圆角、1px 暖灰线、无卡片嵌套与阴影堆叠）；不引入健康测评、雷达、饼图、排名或班级 AI 方案。
STORY: 摘要与口径 → 严重通知直显、普通 info 窄屏汇总 → 期间/领域/参考年龄/目标筛选 → 目标定位（领域 · 子领域）→ 表现行（可靠分布 / 下限 / 核验提示 / 查阅参考）→ 按需展开三类名单或受限名单。
SIGNATURE: 可靠性优先——unavailable 不画三类分布，展开为“相关记录暂不可读取”名单（无状态徽章）；partial 分布为虚线下限，不可读取/未知幼儿单独进“核验受限，未计入普通名单”。
FINISH: 期间选择器永远显示已应用的数据期间；日期草稿明确“尚未应用”；未接受意图或非法日期不改变统计展示。

## R1 修正清单（对应反例）

| # | 反例（修复前） | R1 规则 |
|---|---|---|
| 1 | unavailable 展开显示“暂无相关记录 20 人”普通分组与徽章 | 条目整体不可用时：不渲染三类分布；展开只显示“相关记录暂不可读取”名单，保留 20 人名单与个人证据入口，无普通状态徽章；技术异常不成为第四种儿童状态 |
| 2 | partial 条目中不可读取幼儿混入普通“暂无相关记录” | 普通组只含可靠幼儿与 partial 中已核验的线索/表现；unavailable 幼儿、partial 且 no_records 的幼儿进入“核验受限，未计入普通名单”并逐人说明；服务端 `counts` 原样展示（下限），前端不重算 |
| 3 | 文案把“期间外排除”与完整性失败混写 | partial 提示只描述核对/读取限制；“期间外的证据不参与本期统计（正常口径）”写入常驻口径说明 |
| 4 | 保健参考仍渲染行为分布条、三类人数、占比行与成人帮助确认规则 | `counts_in_behavior_stats=false` 的条目只显示参考说明（身高/体重等只作日常保育对照，不作正常/异常判定）与“查阅相关记录”入口；展开为有相关观察记录的幼儿查阅列表，无三类行为分组、无达成式状态徽章、无成人帮助确认规则；fixture 改为真正的体态/身高体重示意 |
| 5 | `customOpen` 覆盖 `overview.scope`：父级从 custom_range 更新为 semester 后选择器仍显示 custom_range | 选择器值恒由已应用 `overview.scope` 派生；`draft` 只表示正在编辑的日期草稿并显示“尚未应用：当前统计期间仍是…”；外部 props/返回导航更新后草稿关闭、展示一致；父级拒绝意图时选择器与摘要不变；提供“取消编辑”回到实际期间；应用前用 `parseIsoDateStrict` 拒绝缺失/不存在/倒序日期 |
| 6 | 目标组无定位；goal_id 不可见且无法清除 | 全领域模式下目标组显示“领域 · 子领域”定位（筛选领域时保留子领域）；goal_id 生效时显示目标筛选条与“清除”回调 |
| 7 | 窄屏 info 通知与错误通知同等占位 | 窄屏（≤640px）普通 info 通知汇总为“其他提示 N 条”并按需展开；warning/error 始终直显，宽屏全部直显 |
| 8 | fixture 切换自定义范围只改标题、日期仍在范围外 | 证据日期从所选期间起点顺延并夹在结束日内；`scripts/check-class-evidence-overview.ts` 校验四种期间下日期、分母、比例与可靠性自治 |

## Constraints
- 不改 G0 冻结文件、queries.ts、业务 API、`src/app/classes/[id]/page.tsx`、globals.css、PRODUCT.md、DESIGN.md。
- 人数、分母、`confirmed_ratio`、儿童正式状态全部读取 DTO；组件只做展示分类（可靠性优先），不重算统计。
- 占比仅在班级页口径展示且带 `X/N 人 + 统计期间`；`confirmed_ratio=null` 按空名单/不可读/下限/统计不可用分别说明，不显示正常 0%。
- 班级页不展开来源细节；所有期间均 `class_current_roster` 口径，历史期间不代表当时名册或教学成效。
- 无达标率、完成率、弱项排名、能力总分、红绿等级、100% 饼图；“暂无相关记录”不写“不会”。
- fixture 自建、纯数据；不写库、不调用模型，不进入生产数据读取链路。

## Component interface（G6 接入约定，R1 更新）
```ts
type ClassEvidenceScopeIntent =
  | { kind: "semester"; semester_id: string }
  | { kind: "all_history" }
  | { kind: "custom_range"; from: string; to: string };

interface ClassEvidenceDrilldown {
  child_id: string;
  item_id: string;
  child_status: "no_records" | "has_clues" | "confirmed_observed";
  scope: EvidenceScope;          // 已应用的数据期间，原样透传
  filters: EvidenceViewFilters;  // domain_code / age_band / goal_id
}

interface ClassEvidenceOverviewProps {
  overview: ClassEvidenceOverview;                       // G5 getClassEvidenceOverview 的 DTO，只读
  semesters?: SemesterPeriod[];                          // G2 显式学期配置
  onScopeChange?: (scope: ClassEvidenceScopeIntent) => void; // 受控：未接受时不改展示
  onFiltersChange?: (filters: EvidenceViewFilters) => void;  // 切领域时清空 goal_id
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  className?: string;
}
```
- 受控语义：`overview.scope` 是唯一“已应用”真相；组件内日期草稿不覆盖它，外部更新（路由/返回/取数）后选择器与摘要立即一致，不依赖 G6 remount/key。
- G6 建议路由：`/classes/[id]?scope=semester:<id>|all_history|custom&from&to&domain&age_band&goal_id`；钻取 `/children/<child_id>?item=<item_id>&...同一区间`。
- 接口问题（提请调度协调）：`ClassEvidenceScopeIntent` 与 G3 的 `EvidenceScopeIntent` 形状相同但各自私有；班级 DTO 仍无“转入前证据”结构化摘要与逐条通知的 item 定位展示需求扩展，本轮按 notices 文案展示。

## Finish evidence（fixture 组件验收，非业务闭环）
- 方式：本地 `next dev`（127.0.0.1:3101）+ 临时未提交 `/guide-preview-class` 路由（验收后已删除）；Playwright-core 1.63.0 驱动本机 Chrome。
- 修复前（反例先行）：`...\g4-evidence-before\results.json` **84/130**，46 项失败覆盖三类反例（unavailable 普通分组、保健参考行为分布、customOpen 覆盖、无目标定位/筛选、无窄屏通知汇总、fixture 期间不自洽等）。
- 修复后：`...\g4-evidence-after\results.json` **130/130 通过**；fixture 自检 `pnpm exec tsx scripts/check-class-evidence-overview.ts` 输出 `{"passed":34,"total":34,"fixture_only":true}`。
- 实际浏览器覆盖：1440×900 / 768×1024 / 390×844 无横向溢出、核心目标 ≥44px；键盘 Enter/Tab、焦点进入名单操作、减少动态（面板动画 none、过渡 0s）、390 长文本与通知汇总、768 展开名单；筛选与期间全交互（含父级拒绝意图、custom_range→semester、all_history→semester、取消编辑、缺失/倒序日期、goal_id 清除、钻取参数携带同一期间）。
- 截图：`...\g4-evidence-after\` 下 `main-1440x900.png`、`main-768x1024.png`、`main-390x844.png`、`expanded-1440.png`、`unavailable-expanded-1440.png`、`mixed-partial-1440.png`、`health-reference-1440.png`、`empty-roster-1440.png`、`narrow-390-notices.png`、`narrow-longtext-390.png`、`tablet-expanded-768.png`。
- Impeccable detector：**0 primary anti-patterns**；27 条 advisory 全部为 `design-system-radius` / `design-system-font-size`，属于 DESIGN.md 明示“non-homepage values remain unresolved”的已知未决刻度（全局 `--radius:0.625rem` 与 G3 同款 10/12/16px 圆角、12–20px 字号），非本轮引入，保留不改。
- NOT_RUN（未执行，不得当作通过）：G5 读模型与 API 未接入；真实 StepFun/Coze 调用；实库迁移/写入；`classes/[id]/page.tsx` 正式装配与登录态全链路（G6）。fixture 与浏览器验收不是正式 API/数据库闭环。
