# 方向 B·短句流 — 手机 390 全屏稿（direction-b-mobile）

- 画幅：780×1688（≈390×844 逻辑）；输出：`../outputs/04-direction-b-mobile.png`；sidecar：`../outputs/04-direction-b-mobile.meta.json`
- 用途：评审方向 B 的移动端（对话 + 底部核对抽屉）

## Prompt

```
Design a mobile full-screen mockup (780x1688, logical 390x844) for a Chinese kindergarten observation assistant 芽芽, warm white background (#FFFCF5), navy ink, sprout-green primary (#008344), light calm notebook style.

Top header: back chevron ‹, title 芽芽, right 历史 and ⋯.
Chat thread of short bubbles (max 2 lines each):
- assistant: 收到，这次在娃娃家看到的？
- user (pale green): 小满自己搭长桥，塌了三次换底座成功了。
- assistant: 好，整理成观察草稿吗？ with two small buttons 整理成草稿 / 只保存原文
- assistant: 整理好了：社会 · 同伴交往。 with an outline button 核对草稿
- a batch strip: 本批 2 条 · 已保存 1 · 待补充 1
- assistant receipt small line: 已保存 · 14:32
An open BOTTOM SHEET (drawer) covering the lower ~80% of the screen, rounded top corners, title 核对草稿, close ✕ at right; inside: 对象 小满 · 日期 4月2日, a gray observation quote block (two lines), editable rows 领域 社会, 子领域 同伴交往, one photo thumbnail row (three small thumbnails), a full-width green primary button 确认归档, and a quiet outline button 保存修改并重新审核.
The sheet sits above a collapsed input dock with chips 对象：小满 and a rounded field 回复… and green send button. No keyboard; sheet content scrolls internally only if needed. Flat, minimal accurate Chinese text.
```

## 负面提示

```
long paragraphs, real children faces, photo-realism, 3D, dark theme, charts, KPI, garden map, horizontal scroll, emoji status, watermark, desktop layout, keyboard covering controls
```

## 验收清单（生成后）

- [ ] 对话为短气泡；批次条与回执行可见
- [ ] 底部抽屉是核对位置，关闭明确
- [ ] 主按钮全宽；状态文字可读
- [ ] 无横向溢出；无真实面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
