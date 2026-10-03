---
version: 3
slug: "src-components-guide-class-evidence-overview-tsx"
primary_target: "src/components/guide/class-evidence-overview.tsx"
related_targets: ["src/components/guide/class-evidence-overview.module.css","src/components/guide/__fixtures__/class-evidence-overview-fixture.ts","scripts/check-class-evidence-overview.ts"]
---

# 班级指南证据概览 ClassEvidenceOverview — 指南证据链 G4-R2（fixture 组件验收）
Mode: Operate. Scope: 只读组件（受控期间 + 草稿、领域/参考年龄/目标筛选、可靠性优先的名单下钻与回调意图）。正式路由、API 接入与页面装配由 G6 处理；本轮未改 G0 冻结类型、API、queries、正式班级页与全局样式。

## Direction contract（R2 修）
THESIS: 保守展示——只有完全可靠的统计才画“完整三类分布”；含未知时只给可核验依据摘要与核验限制；保健参考先讲可靠性，再讲参考说明。
OWN-WORLD: 沿用“轻量成长观察册”（暖白/深墨/芽绿/晨光蓝/观察琥珀/柔和珊瑚、10–16px 圆角、1px 暖灰线、无卡片嵌套）；不引入健康测评、雷达、饼图、排名或班级 AI 方案。
SIGNATURE: reliable → 分布条+三类图例+占比（X/N 人+期间）；partial → 名单分母 + 已确认表现/线索下限 + “其余暂无法确认”，不画完整三类分布；unavailable → 只保留核验提示、名单与个人证据入口。

## R2 修正清单（对应反例）

| # | 反例（修复前） | R2 规则 |
|---|---|---|
| 1 | partial 图例 3/2/15，展开普通名单 3/2/14，另有 1 人不可读取，完整分布暗示全体已分类 | partial 不再渲染三类分布条/图例：改为“可核验依据摘要”（在班名单分母 + 服务端已确认表现/线索人数，标“可确认下限” + “其余是否暂无相关记录暂无法确认”）；展开普通无记录组标注“（已读取范围）”，不可读取/partial+no_records 幼儿进入“核验受限，未计入普通名单”；服务端 counts 原样不改、不从名单重算、不新增状态 |
| 2 | 保健参考分支早于可靠性处理，unavailable 显示成普通参考空态 | 参考条目可靠性优先：unavailable 收起态显示珊瑚核验警告，展开为“相关资料暂不可读取”名单+个人证据入口，绝不断言“没有可供查阅”；partial 只描述已核验资料范围并保留受限名单；待核对建议单列“AI 关联待核对（不计入已核验资料）”，工作流标签而非状态徽章，也不被确定性空态掩盖；仍不恢复行为分布/占比/状态徽章 |
| 3 | 验收不可一键复现 | 提供工作树外一次性装置 `g4-browser\run-acceptance.ps1`（从模板建立临时预览路由 → 启动 dev:3101 → 跑 115 项浏览器检查 → 清理路由与 `.next`），不覆盖已有文件、仓库不保留 mock 路由；展开态截图在收起前拍摄 |

## 验收与可复现
- 一次性装置（工作树外，不提交）：`C:\Users\nanpr\AppData\Local\Temp\opencode\g4-browser\run-acceptance.ps1`
  1. `pwsh -NoProfile -File ...\g4-browser\run-acceptance.ps1 -Worktree ...\child-growth-g4 -Port 3101 -OutDir ...\g4-evidence-r2-final`
  2. 脚本自动：确认无既有预览路由 → 复制 `preview-page.template.tsx` → `next dev` → `check.cjs` → 关闭进程 → 删除临时路由与 `.next`。
- fixture/类型/风格：`pnpm ts-check`、`pnpm lint:build`、`pnpm lint:style`、`pnpm exec tsx scripts/check-class-evidence-overview.ts`（`{"passed":42,"total":42,"fixture_only":true}`）。
- 浏览器：修复前 `...\g4-evidence-r2-before\results.json` **95/115**（20 项失败覆盖 partial 完整分布、参考可靠性、待核对可见性）；修复后 `...\g4-evidence-r2-after\results.json` 与最终 `...\g4-evidence-r2-final\results.json` **115/115**。
- 截图（展开态、与报告状态一致）：`health-reference-expanded-1440.png`、`health-reference-unavailable-expanded-1440.png`、`health-reference-partial-expanded-1440.png`、`health-reference-pending-expanded-1440.png`、`mixed-partial-expanded-1440.png`、`unavailable-expanded-1440.png`、`expanded-1440.png`、`main-1440x900/768x1024/390x844.png`、`empty-roster-1440.png`、`narrow-390-notices.png`、`narrow-longtext-390.png`、`tablet-expanded-768.png`。

## Impeccable
- detector：**0 primary**；28 条 advisory 全为 `design-system-radius` / `design-system-font-size`——DESIGN.md 明示 non-homepage 刻度未决（全局 `--radius:0.625rem` 与既有 10/12/16px、12–20px 字号），继承自 G3/G4 既有世界，不为消除 advisory 改画风。
- harden/adapt 后一次 polish：新增状态（partial 摘要、参考三态、受限名单）已按展开态截图核对，无需返工。

## NOT_RUN（不得当作通过）
G5 读模型与 API 未接入；真实 StepFun/Coze 调用；实库迁移/写入；`classes/[id]/page.tsx` 正式装配与登录态全链路（G6）。fixture 浏览器验收不是正式 API/数据库闭环。
