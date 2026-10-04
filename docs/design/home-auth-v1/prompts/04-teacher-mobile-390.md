# 教师 390 窄屏稿（teacher-mobile-390）

- 画幅：780×1688 竖版（按 390×844 的 2 倍输出），手机整页示意
- 单列自然流，无横向滚动，触控目标 ≥44px
- 示例数据全部为合成数据
- 输出文件建议：`outputs/04-teacher-mobile-390.png`

## Prompt

```
Design a clean, light, picture-book style mobile web homepage mockup for a Chinese kindergarten teacher's growth-observation app named 芽芽观察. Portrait canvas 780x1688 (phone 390pt at 2x), warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue secondary (#4F6079), warm hairline borders (#E9E2D3), sprout-green primary (#008344), amber pending accent (#BF6805). Flat, calm, warm-professional; clean Chinese sans; hand-brushed Chinese display font (Ma Shan Zheng feel) only for the greeting. One-handed single column, generous whitespace, no heavy shadows.

Top app bar: small sprout logo and 芽芽观察 on the left, a simple menu icon on the right.

Identity block: hand-brushed greeting 林小满，上午好; below it 小班教师 · 负责 2 个班级 · 2026 学年; small round avatar on the right.

Standalone illustration banner below the identity block: one complete flat picture-book illustration of a teacher and children reading a picture book on a warm rug, full width about 170px tall, complete figures and scene, NO text, NO UI, nobody cropped or covered.

Primary action: one full-width pill button, 56px tall, amber (#BF6805), label 去处理待确认 · 3 条; below it a quiet text link 开始记录.

Section 我的班级, grouped by stage:
- 小班（2 个班级）: two full-width plain rows 芽芽班 · 18 人 · 待确认 2 and 苗苗班 · 16 人 · 待确认 1, thin warm dividers, small arrow each.
- 中班（1 个班级）: row 星星班 · 20 人 · 待确认 0.

Section 待核对 with 2 rows: 10月3日 · 朵朵 · 待确认; 10月2日 · 阿依努尔·麦麦提 · 待补充信息 (long name may wrap, layout stays stable).

Section 最近观察 with 2 rows, status 已确认归档.

No horizontal scrolling, no tables, no charts, no other teachers' data, no admin entries. Exact Chinese strings as listed. Crisp UI mockup, flat illustration, high legibility at 390pt.
```

## 负面提示

```
dark SaaS dashboard, KPI tiles, charts, tables, horizontal scroll, floating cards over characters, text baked inside illustration, glassmorphism, 3D, watermark, phone chrome, heavy shadows, desktop two-column layout
```

## 验收清单

- [ ] 顺序：身份 → 插画横幅 → 主行动 → 我的班级 → 待核对 → 最近观察
- [ ] 插画横幅完整，人物不裁剪、不被覆盖
- [ ] 主行动为 56px 全宽胶囊；“开始记录”仅次级
- [ ] 小班组内两个班同时可见（同一教师负责两个小班）
- [ ] 长姓名换行不破坏布局；无横向滚动
- [ ] 无全园数据、无管理入口、无图表

## sidecar 记录

- 模型/工具：NOT_RUN
- 参数：—
- 生成时间：—
