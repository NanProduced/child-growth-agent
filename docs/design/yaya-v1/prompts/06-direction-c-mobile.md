# 方向 C·核查台 — 手机 390 双标签稿（direction-c-mobile）R1

- 画幅：780×1688（≈390×844 逻辑）；输出：`../outputs/06-direction-c-mobile.png`；sidecar：`../outputs/06-direction-c-mobile.meta.json`
- 用途：评审方向 C 的移动端（对话／核对 双标签，核对表单亦处理软键盘）
- 统一案例：小满/阿依 · 中班·向日葵班 · 10月8日 · 积木区 · 2 张照片

## Prompt

```
Design a mobile full-screen mockup (780x1688, logical 390x844) for a Chinese kindergarten observation assistant 芽芽, warm white (#FFFCF5), navy ink, sprout-green primary (#008344), light calm notebook style.

Top header: back chevron ‹, title 芽芽, and two segmented tabs: 对话 (inactive, outline) and 核对 (active, green, with a small amber badge 1).
Active tab content = 核对 list, single column:
- a white card titled 小满 · 观察草稿 with metadata 10月8日 · 积木区; a gray quote block with this exact text: 小满自己搭长桥，中间塌了三次，他换了更宽的底座，第四次搭稳了。; an AI section with violet badge AI 生成 and rows 科学 · 数学认知, 发展表现说明（可展开）; a horizontal row of TWO small photo thumbnails (one labeled 共同, one labeled 长桥特写); a 核对 fact list: 对象 小满（中班·向日葵班）, 日期 10月8日, 事实依据 原文对照, 附件 积木区全景（与阿依共用）+ 长桥特写.
- a full-width green primary button 确认归档 and a small quiet outline button 稍后处理.
- below: a QUEUE block titled 队列 with TWO checkbox rows: ☑ 小满 已保存, ☐ 阿依 待补充：提醒的说法; then a full-width green button 保存已选 1 条 and a small line 已保存 1 条 · 1 条待补充.
No input dock on this tab. The 核对 tab uses native dynamic viewport height and safe-area insets so its buttons stay visible with the soft keyboard. Everything flat and minimal, accurate legible Chinese text, no real children faces.
```

## 负面提示

```
long paragraphs, real children faces, photo-realism, 3D, dark theme, charts, KPI, garden map, horizontal scroll, emoji status, watermark, desktop layout, two columns, other children names (糖糖/小雨/小北), other dates (4月2日), other scenes (娃娃家)
```

## 验收清单（生成后）

- [ ] 双标签清晰，核对标签带角标（不是首页待办合并数）
- [ ] 核对页单列、主按钮全宽；含原文/事实/附件；队列两条
- [ ] 人物仅小满/阿依，日期 10月8日，场景积木区；状态文字完整
- [ ] 无横向溢出；核对按钮在软键盘下可见；无真实面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
