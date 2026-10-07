# 管理员桌面稿（admin-desktop）

- 画幅：1536×1024（3:2 横），桌面网页整页示意；内容上限宽 1200px 居中
- 示例数据全部为合成数据
- 输出：`../outputs/03-admin-desktop.png`；sidecar：`../outputs/03-admin-desktop.meta.json`

## 固定示例数据（必须在稿中逐字一致）

- 身份：**王园长，上午好** ／ **管理员**
- 范围：**示范幼儿园 · 3 个学段 · 6 个班级 · 94 名幼儿**
- 全园概览：**小班 2 个班级 · 34 名幼儿**；**中班 2 个班级 · 32 名幼儿**；**大班 2 个班级 · 28 名幼儿**
- 管理入口：**管理班级**（辅助语：进入班级列表与班级证据聚合）；**管理教师**（辅助语：教师账号与任教分配）

## Prompt

```
Design a clean, light, picture-book style desktop web homepage mockup for the school-management view of a Chinese kindergarten observation app named 芽芽观察. Canvas 1536x1024, warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue (#4F6079), warm hairline borders (#E9E2D3), sprout-green primary (#008344). Stage identification colors only as thin tags: small-class coral #A7284E, middle-class gold #8D560E, large-class blue #1B5A94. Calm, warm, restrained operations; all text in clean Chinese sans (NO hand-brushed font anywhere); NO charts, NO KPI tiles, NO heavy shadows, NO dark SaaS look.

Top bar: sprout logo and 芽芽观察 on the left; simple nav links 首页 班级 成长档案 观察记录 更多; on the right a small round avatar, the name 王园长 with a small tag 管理员 and a quiet 退出 link.

Header: 王园长，上午好 in clean Chinese sans; below it the muted scope line 示范幼儿园 · 3 个学段 · 6 个班级 · 94 名幼儿; a tiny decorative sprout mark.

Section 全园概览: three quiet rows or blocks side by side, each with a thin colored stage tag and NO pending counts, NO percentages, NO charts:
- 小班: 2 个班级 · 34 名幼儿
- 中班: 2 个班级 · 32 名幼儿
- 大班: 2 个班级 · 28 名幼儿

Section 管理入口: two clear full-width entries with helper text and a right arrow:
- primary green entry 管理班级, helper 进入班级列表与班级证据聚合
- secondary quiet entry 管理教师, helper 教师账号与任教分配

Absolutely no observation text, no teacher name lists, no teacher-confirmation actions (no 去处理待确认 anywhere), no reports, no charts on the page. The two management entries are the only actions. Exact Chinese strings as listed. Aspect 3:2, crisp UI mockup, generous whitespace.
```

## 负面提示

```
去处理待确认, teacher confirmation buttons, pending observation counts, observation excerpts, teacher name lists, reports, charts, radar, percentages, KPI tiles, progress rings, dark SaaS dashboard, sidebar, 3D, glassmorphism, watermark, browser chrome, heavy shadows, words like 后续 or 待开发 or 占位 in the UI
```

## 验收清单（生成后）

- [ ] 管理身份与范围一句话：示范幼儿园 · 3 个学段 · 6 个班级 · 94 名幼儿
- [ ] 三个学段块只含“班级数 · 幼儿数”，2+2+2＝6、34+32+28＝94 自洽
- [ ] 管理班级、管理教师两个入口，无“后续/待开发/占位”字样
- [ ] **无“去处理待确认”**、无全园待确认计数、无教师名与观察原文
- [ ] 无图表/占比/排名
- [ ] 全页无毛笔字；学段色只作识别

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
