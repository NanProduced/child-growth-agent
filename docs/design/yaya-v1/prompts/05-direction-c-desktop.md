# 方向 C·核查台 — 桌面独立工作区稿（direction-c-desktop）R1

- 画幅：1536×1024（3:2）；输出：`../outputs/05-direction-c-desktop.png`；sidecar：`../outputs/05-direction-c-desktop.meta.json`
- 用途：评审方向 C（仅宽工作区分栏：左对话 + 右核查队列；窄侧栏不分栏）
- 统一案例：小满/阿依 · 中班·向日葵班 · 10月8日 · 积木区 · 2 张照片

## Prompt

```
Design a desktop workspace mockup (1536x1024) for a Chinese kindergarten observation assistant 芽芽, calm warm-white notebook style (#FFFCF5), navy ink (#15264D), sprout-green primary (#008344), hairline warm borders, quiet and light, no dark dashboard.

Single full workspace layout (wide enough for two readable columns) with two columns inside a 1356px content area:
LEFT COLUMN (about 38%): header 芽芽 with small flat green sprout mascot, tabs 会话 and 历史, a [待核对 1] small amber chip. A short chat thread of 3 short messages (max 2 lines), e.g. assistant 整理好了，请在右侧核对。; user 把阿依也加上。; assistant 已生成阿依卡。 Each message can have a tiny link 在核查区打开. Bottom input bar with chips 对象：小满, 来源：观察草稿, rounded field 回复…, paperclip, green send button.

RIGHT COLUMN (about 62%): a 核查区 panel titled 核查区 with subtitle 当前：小满 · 观察草稿; inside a white card: metadata row 小满 · 10月8日 · 积木区, a gray quote block with this exact text: 小满自己搭长桥，中间塌了三次，他换了更宽的底座，第四次搭稳了。, an AI section with violet badge AI 生成, rows 科学 · 数学认知 and 发展表现说明（可展开）; a row of TWO small photo thumbnails (one labeled 共同, one labeled 长桥特写); a 核对 fact list (对象 小满（中班·向日葵班） / 日期 10月8日 / 事实依据 与原文逐字对照 / 附件 积木区全景（与阿依共用）+ 长桥特写), card footer with outline 稍后处理 and green primary 确认归档.
Below the card: a QUEUE strip titled 队列 with TWO checkbox rows: ☑ 小满 (amber text 待确认), ☐ 阿依 (rose text 待补充：提醒方式未知) with a small 补一句 link; below: green primary button 确认已选 1 条 and a small line 待确认 1 条 · 1 条待补充. This is BEFORE archive approval. Completed items in a later screen are read-only, unchecked and excluded from submission.
Top-right of the workspace: a small flat sprout entry button 芽芽. Everything flat and precise, minimal accurate Chinese text, no real children faces.
```

## 负面提示

```
three columns, narrow squeezed columns, dark theme, KPI tiles, charts, garden map, real children faces, photo-realism, 3D, glassmorphism, heavy shadows, emoji status, watermark, browser chrome, crowded paragraphs, other children names (糖糖/小雨/小北), other dates (4月2日), other scenes (娃娃家)
```

## 验收清单（生成后）

- [ ] 左右列均有可读宽度；右侧一次显示一个当前项 + 队列
- [ ] 队列两条：小满（待确认）、阿依（待补充）；主按钮 确认已选 1 条，不重复提交已完成项
- [ ] 聊天里无最终批准按钮（批准在核查区）；批准内容含原文/事实/附件
- [ ] 状态文字齐全；人物仅小满/阿依，日期 10月8日，场景积木区；无评分/地图
- [ ] 中文可读，无真实面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
