---
version: 5
slug: "src-components-guide-class-evidence-overview-tsx"
primary_target: "src/components/guide/class-evidence-overview.tsx"
related_targets: ["src/components/guide/class-evidence-overview.module.css","src/components/guide/__fixtures__/class-evidence-overview-fixture.ts","scripts/check-class-evidence-overview.ts","scripts/acceptance/run-class-evidence-ui-check.ps1","scripts/acceptance/check-class-evidence-ui.cjs","scripts/acceptance/preview-page.template.tsx"]
---

# 班级指南证据概览 ClassEvidenceOverview — 证据下钻工作台（CLASS-EVIDENCE-UI2）
Mode: Operate. Scope: 桌面“证据下钻工作台”（双栏布局：左侧指南条目分布 + 0-20 人数标尺，右侧选中条目原文、关键条件、三态名单与真实观察证据片段）。保留全部期间受控、草稿、领域/年龄段/目标筛选，统计说明收敛为模态对话框，清除页面 AI Slop 与重复警告段落。

## Direction contract（UI-V2 选型三：证据下钻工作台）
THESIS: 工作台一体化体验——“总览比较 → 具体条目 → 幼儿名单 → 真实证据”层级连贯。左侧提供各表现条目 0-20 人数坐标下的水平堆叠分布；右侧常驻选中条目详情（原文、成人帮助/独立要求、三态名单与引用证据卡片）。
OWN-WORLD: 遵循芽芽既有视觉世界（暖白底、深墨色文字、芽绿强调色、晨光蓝线索、观察琥珀提示、柔和珊瑚受限警示；无卡片堆叠、无雷达、无打分、无排行榜）。
SIGNATURE:
- reliable：0-20 水平堆叠条（绿色已确认/蓝色线索/灰色暂无）+ 占比文本；
- partial：显示“至少 X 人 · 已确认观察到”、“至少 Y 人 · 已有相关线索”与“数据待核验”，不画完整伪 100% 分布；
- unavailable：提示记录无法读取，保留 20 人在班分母与个人证据入口；
- 保健参考：单独查阅，不参与行为统计，不做正常/异常评价；
- 统计说明：顶部提供轻量对话框集中承载，不每行重复警告。

## 变更与消除 AI Slop 清单
1. 消除 4230 字密集冗余引导：将方法说明、三态定义、可靠性界限集中于“统计说明”模态对话框；
2. 消除 34 处重复警告卡片：partial 条目仅通过紧凑标签展示可确认下限与“数据待核验”；
3. 真实证据片段接入：右侧详情面板通过 `GET /api/children/[id]/evidence-book` 异步读取真实核验片段（带引用来源与时间），绝不捏造示例正文；无依据时优雅降级为真实元数据，入口直通个人证据册；
4. 触控目标与无障碍：所有 interactive 控件确保 `min-height: >= 44px`；`@media (prefers-reduced-motion: reduce)` 面板与动画即时响应；
5. 响应式布局：桌面（>=1024px）双栏工作台布局；移动端（<1024px）自适应单列内嵌折叠，零横向溢出。

## 验收与回归
- 离线 fixture 自检：`pnpm exec tsx scripts/check-class-evidence-overview.ts`：**42/42 通过**；
- 浏览器全景验收装置：`scripts/acceptance/run-class-evidence-ui-check.ps1` 在端口 3123 启动真实 Chromium：
  - 覆盖 1440×900, 768×1024, 390×844 视口；
  - 覆盖 reliable, partial, unavailable, health-reference, empty-roster 各场景；
  - 覆盖键盘 Tab/Enter 导航、无障碍焦点落点、筛选受控与钻取回调；
  - **115/115 全量通过**（exit code 0）；
- 代码质量与类型：`pnpm ts-check`（0 errors）、`pnpm lint:build`（0 errors）、`pnpm lint:style`（0 errors）；
- Impeccable 检测器：`impeccable detect --json`：**0 primary violations**。

## NOT_RUN
非 Windows/非 PowerShell 环境；真实 StepFun/Coze LLM 调用（本轮模型预算为 0）；生产数据库写入。
