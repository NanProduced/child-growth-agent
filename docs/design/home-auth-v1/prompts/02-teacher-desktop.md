# 教师桌面稿（teacher-desktop）

- 画幅：1536×1024（3:2 横），桌面网页整页示意
- 内容上限宽 1200px 居中
- 示例数据全部为合成数据，不含真实儿童资料
- 输出文件建议：`outputs/02-teacher-desktop.png`

## Prompt

```
Design a clean, light, picture-book style desktop web homepage mockup for a Chinese kindergarten teacher's growth-observation app named 芽芽观察. Canvas 1536x1024, warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue secondary (#4F6079), warm hairline borders (#E9E2D3), sprout-green primary (#008344), soft amber pending accent (#BF6805). Flat, calm, warm-professional; clean Chinese sans for body; hand-brushed Chinese display font (Ma Shan Zheng feel) only for the greeting. Thin borders, no heavy shadows, no data-dashboard look.

Top bar: sprout logo and 芽芽观察 on the left; simple nav links 首页 班级 成长档案 观察记录 更多; on the right a small round avatar, the name 林小满 and a quiet 退出 link.

Identity band: hand-brushed greeting 林小满，上午好; below it a muted line 小班教师 · 负责 2 个班级 · 2026 学年; on the right side of this band, a small standalone flat illustration of a teacher and children reading a book (about 320px wide, complete figures, no text, no UI, no overlap).

Primary action panel, one clear action: a warm paper panel with the line 3 条待核对 · 整理好的观察，等你核对。 and one amber filled button 去处理待确认 (#BF6805) plus a quiet text link 开始记录. Only ONE primary button.

Section 我的班级:
- Stage group 小班（2 个班级） with two plain list rows: 芽芽班 · 18 人 · 待确认 2 and 苗苗班 · 16 人 · 待确认 1, each row full-width, thin warm divider, small arrow on the right; NOT heavy cards.
- Stage group 中班（1 个班级） with one row: 星星班 · 20 人 · 待确认 0.
Stage names may use the brush display font; counts and statuses use clean sans.

Section 待核对 with 2 rows, each: date, child name, one-line excerpt, workflow status chip:
- 10月3日 · 朵朵 · 在积木区把长积木横着架成小桥，说这是给娃娃过河的桥。 · 待确认
- 10月2日 · 阿依努尔·麦麦提 · 在娃娃家邀请同伴一起给娃娃做饭。 · 待补充信息 (this long name wraps to a second line without breaking layout)

Section 最近观察 with 2 rows, status 已确认归档.

No class percentages, no radar, no rankings, no other teachers' data, no admin metrics. Exact Chinese strings as listed. Aspect 3:2, crisp UI mockup.
```

## 负面提示

```
dark SaaS dashboard, KPI tiles, radar chart, percentage circles, rankings, medals, other teachers' lists, full-school management tables, floating cards over characters, text baked inside illustration, glassmorphism, 3D, watermark, browser chrome, heavy shadows
```

## 验收清单

- [ ] 身份带：真实姓名 + 身份 + 负责范围；插画独立完整、无遮挡
- [ ] 唯一主行动为琥珀色“去处理待确认”；“开始记录”只作次级
- [ ] “我的班级”按学段分组，**小班组内有两个班**（芽芽班、苗苗班）
- [ ] 班名/人数/待确认数样式克制，不用数据驾驶舱语言
- [ ] 待核对与最近观察各 2–3 行，状态词为既有流程词
- [ ] 长姓名“阿依努尔·麦麦提”换行不破坏布局
- [ ] 无全园数据、无其他教师、无百分比/排名

## sidecar 记录

- 模型/工具：NOT_RUN
- 参数：—
- 生成时间：—
