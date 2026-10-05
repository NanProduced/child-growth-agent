# 方向 C·核查台 — 桌面工作区稿（direction-c-desktop）

- 画幅：1536×1024（3:2）；输出：`../outputs/05-direction-c-desktop.png`；sidecar：`../outputs/05-direction-c-desktop.meta.json`
- 用途：评审方向 C（分栏：左对话 + 右核查队列）

## Prompt

```
Design a desktop workspace mockup (1536x1024) for a Chinese kindergarten observation assistant 芽芽, calm warm-white notebook style (#FFFCF5), navy ink (#15264D), sprout-green primary (#008344), hairline warm borders, quiet and light, no dark dashboard.

Single full workspace layout with two columns inside a 1356px content area:
LEFT COLUMN (about 38%): header 芽芽 with small flat green sprout mascot, tabs 会话 and 历史, a [待核对 2] small amber chip. A short chat thread of 3 short messages (max 2 lines), e.g. assistant 整理好了，请在右侧核对。; user 把阿依也加上。; assistant 已生成阿依卡。 Each message can have a tiny link 在核查区打开. Bottom input bar with chips 对象：小满, 来源：观察草稿, rounded field 回复…, paperclip, green send button.

RIGHT COLUMN (about 62%): a 核查区 panel titled 核查区 with subtitle 当前：小满 · 观察草稿; inside a white card: metadata row 小满 · 4月2日 · 娃娃家, a gray quote block (two lines of observation text), an AI section with violet badge AI 生成, rows 社会 · 同伴交往 and 发展亮点 2 条, a row of three small photo thumbnails, a 核对 fact list (对象 小满（芽芽班） / 日期 4月2日 / 事实依据 与原文逐字对照 / 图片 3 张 · 仅作素材), card footer with outline 稍后处理 and green primary 确认归档.
Below the card: a QUEUE strip titled 队列 with three checkbox rows: ☑ 小满 (green text 已核对), ☑ 阿依 (green text 已核对), ☐ 小北 (amber text 待补充：成人帮助方式) with a small 补一句 link; below: green primary button 保存已选 2 条 and a small line 已保存 1 条 · 1 条待核对.
Top-right of the workspace: a small flat sprout entry button 芽芽. Everything flat and precise, minimal accurate Chinese text, no real children faces.
```

## 负面提示

```
three columns, dark theme, KPI tiles, charts, garden map, real children faces, photo-realism, 3D, glassmorphism, heavy shadows, emoji status, watermark, browser chrome, crowded paragraphs
```

## 验收清单（生成后）

- [ ] 左对话短、右核查完整；一次只显示一个当前项
- [ ] 队列有勾选与逐项状态；主按钮 保存已选
- [ ] 聊天里无最终批准按钮（批准在核查区）
- [ ] 状态文字齐全；无评分/地图
- [ ] 中文可读，无真实面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
