# 管理员桌面稿（admin-desktop）

- 画幅：1536×1024（3:2 横），桌面网页整页示意
- 内容上限宽 1200px 居中
- 示例数据全部为合成数据
- 输出文件建议：`outputs/03-admin-desktop.png`

## Prompt

```
Design a clean, light, picture-book style desktop web homepage mockup for a Chinese kindergarten management view inside the growth-observation app 芽芽观察. Canvas 1536x1024, warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue secondary (#4F6079), warm hairline borders (#E9E2D3), sprout-green primary (#008344), stage identification colors used only as thin tags or left rules: small-class coral #A7284E, middle-class gold #8D560E, large-class blue #1B5A94. Calm, warm, operational; clean Chinese sans; hand-brushed display font (Ma Shan Zheng feel) only for the greeting. No dark SaaS look, no charts, no heavy shadows.

Top bar: sprout logo and 芽芽观察 on the left; simple nav links 首页 班级 成长档案 观察记录 更多; on the right a small round avatar, the name 王园长 with tag 管理员, and a quiet 退出 link.

Header: hand-brushed greeting 王园长，上午好; below it a muted line 示范幼儿园 · 3 个学段 · 6 个班级; a tiny decorative sprout mark.

Section 全园概览: three quiet stage rows or blocks side by side, each with a thin colored stage tag and aggregates only:
- 小班: 2 个班级 · 34 份成长档案 · 待核对 3
- 中班: 2 个班级 · 32 份成长档案 · 待核对 1
- 大班: 2 个班级 · 28 份成长档案 · 待核对 2
These are plain rows with hairline dividers, NOT KPI tiles, no percentages, no progress rings, no charts.

Section 管理入口: two clear entries:
- primary green entry 管理班级 with helper 进入班级聚合 (whole row clickable, arrow on the right)
- secondary quiet entry 管理教师 with helper 管理园所教师账号
No teacher name lists, no observation excerpts, no reports on the page.

Exact Chinese strings only as listed. Aspect 3:2, crisp UI mockup, generous whitespace.
```

## 负面提示

```
dark SaaS dashboard, sidebar, KPI tiles, charts, radar, percentages, ranking tables, teacher name lists, observation text lists, reports on homepage, floating cards, 3D, glassmorphism, watermark, browser chrome, heavy shadows, gamification
```

## 验收清单

- [ ] 管理身份与全园范围一句话清晰
- [ ] 三个学段块只含班级数/档案数/待核对数，无图表、无占比、无排名
- [ ] 管理入口为“管理班级”（主）与“管理教师”（次），均可进入后续页面
- [ ] **不出现**教师确认主按钮“去处理待确认”
- [ ] 无教师名单、无观察原文、无报表平铺
- [ ] 学段色只作识别，风格仍是轻绘本而非控制台

## sidecar 记录

- 模型/工具：NOT_RUN
- 参数：—
- 生成时间：—
