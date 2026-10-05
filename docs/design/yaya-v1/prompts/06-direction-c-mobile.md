# 方向 C·核查台 — 手机 390 双标签稿（direction-c-mobile）

- 画幅：780×1688（≈390×844 逻辑）；输出：`../outputs/06-direction-c-mobile.png`；sidecar：`../outputs/06-direction-c-mobile.meta.json`
- 用途：评审方向 C 的移动端（对话／核对 双标签）

## Prompt

```
Design a mobile full-screen mockup (780x1688, logical 390x844) for a Chinese kindergarten observation assistant 芽芽, warm white (#FFFCF5), navy ink, sprout-green primary (#008344), light calm notebook style.

Top header: back chevron ‹, title 芽芽, and two segmented tabs: 对话 (inactive, outline) and 核对 (active, green, with a small amber badge 2).
Active tab content = 核对 list, single column:
- a white card titled 小满 · 观察草稿 with metadata 4月2日 · 娃娃家; a gray quote block with two lines of Chinese observation text; an AI section with violet badge AI 生成 and rows 社会 · 同伴交往, 发展亮点 2 条; a horizontal row of three small photo thumbnails; a 核对 fact list: 对象 小满（芽芽班）, 日期 4月2日, 事实依据 原文对照, 图片 3 张 · 仅作素材.
- a full-width green primary button 确认归档 and a small quiet outline button 稍后处理.
- below: a QUEUE block titled 队列 with three checkbox rows: ☑ 小满 已核对, ☑ 阿依 已核对, ☐ 小北 待补充：成人帮助方式; then a full-width green button 保存已选 2 条 and a small line 已保存 1 条 · 1 条待核对.
No input dock on this tab. Everything flat and minimal, accurate legible Chinese text, no real children faces.
```

## 负面提示

```
long paragraphs, real children faces, photo-realism, 3D, dark theme, charts, KPI, garden map, horizontal scroll, emoji status, watermark, desktop layout, two columns
```

## 验收清单（生成后）

- [ ] 双标签清晰，核对标签带待核对角标（不是首页待办合并数）
- [ ] 核对页单列、主按钮全宽
- [ ] 队列勾选与状态文字完整
- [ ] 无横向溢出；无真实面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
