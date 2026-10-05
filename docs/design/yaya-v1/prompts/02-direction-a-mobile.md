# 方向 A·册页卡 — 手机 390 全屏稿（direction-a-mobile）R1

- 画幅：780×1688（≈390×844 逻辑，2x）；输出：`../outputs/02-direction-a-mobile.png`；sidecar：`../outputs/02-direction-a-mobile.meta.json`
- 用途：评审方向 A 的移动端（单列卡流 + 卡内操作 + 软键盘）
- 统一案例：小满/阿依 · 中班·向日葵班 · 10月8日 · 积木区 · 2 张照片

## Prompt

```
Design a mobile full-screen app mockup (780x1688, logical 390x844) for a Chinese kindergarten observation assistant named 芽芽, warm white background (#FFFCF5), navy ink (#15264D), sprout-green primary (#008344), hairline warm borders, light notebook style.

Top header: back chevron ‹, title 芽芽, right small 历史 and ⋯ icons.
Message area, single column of full-width notebook cards:
- Card 1: title 观察草稿卡, amber text badge 待核对, metadata 小满 · 10月8日 · 积木区; gray quote block with this exact text: 小满自己搭长桥，中间塌了三次，他换了更宽的底座，第四次搭稳了。; a horizontal row of TWO photo thumbnails (one labeled 共同, one labeled 长桥特写); AI section with violet badge AI 生成 and rows 科学 · 数学认知, 发展亮点 2 条 [展开全文]; an expanded 核对区 fact list: 对象 小满（中班·向日葵班）, 日期 10月8日, 事实依据 原文对照, 附件 积木区全景（与阿依共用）+ 长桥特写; card buttons stacked full-width INSIDE the card: outline 修改草稿 above green primary 确认归档.
- Card 2 (partially visible below): a batch summary strip 本批 2 条 · 已保存 1 · 待补充 1, with one compact child card showing a checkbox, name 阿依 and a rose text badge 待补充：提醒方式未知.
Bottom input dock above the safe area: small chips 对象：小满 and 来源：观察草稿, a rounded text field with placeholder 写下补充…, paperclip icon, green circular send button. The soft keyboard is OPEN, taking the lower ~40% of the screen; the input dock sits directly above the keyboard and is fully visible; content above is scrolled, not compressed.

Everything flat, calm, high legibility, minimal Chinese text, accurate characters. No real children faces; thumbnails are abstract block-area photos without faces.
```

## 负面提示

```
real children faces, photo-realism, 3D, dark theme, chart, KPI, ranking, garden map, horizontal scrolling, content hidden behind keyboard, emoji status, watermark, tablet layout, desktop layout, long text paragraphs, other children names (糖糖/小雨/小北), other dates (4月2日), other scenes (娃娃家)
```

## 验收清单（生成后）

- [ ] 单列卡流；卡片操作为卡内全宽按钮（无吸底操作条）
- [ ] 输入区在软键盘之上且完整可见
- [ ] 状态徽章与批次条有文字；人物仅小满/阿依，日期 10月8日，场景积木区
- [ ] 2 张缩略图（1 张共同）；无横向溢出迹象；触控目标够大
- [ ] 无真实面孔；中文可读

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
