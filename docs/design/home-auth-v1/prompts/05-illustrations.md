# 插画素材 prompt（illustrations）

用于生成/替换首页独立插画。**画内一律无文字、无按钮、无数据、无 UI**；人物完整，不被任何界面元素覆盖。生成结果若用于正式页面，需保留来源与 prompt sidecar。

## A. 主插画：教师与幼儿阅读角（hero-teacher-children）

- 用途：未登录态主插画；教师态小插画（等比缩小）
- 画幅：1536×768（2:1 横），暖白底 `#FFFCF5`（如需透明底可改用透明输出）
- 输出文件建议：`outputs/hero-teacher-children.png`

```
Light picture-book style standalone illustration for a Chinese kindergarten teacher app. A young Chinese female teacher sitting on a warm rug with three small children around one big open picture book, a potted sprout and a few soft plants nearby, calm kindergarten reading corner. Warm white background (#FFFCF5). Flat shapes, soft pencil-like outlines, gentle limited palette echoing this brand: warm white, soft leaf greens (#008344 family), warm woods, muted coral and gold accents, navy only as a whisper on clothing details. Complete figures fully visible, friendly and professional, no exaggeration, no photorealism, no 3D, no gradients, no glow. Absolutely no text, no letters, no numbers, no UI elements, no frames, no watermark.
```

## B. 小插画：观察册与芽苗（notebook-sprout，可选）

- 用途：主行动面板/空态装饰；仓库已有 `observation-notebook.png`（1240×1269，白底）可复用
- 画幅：1024×1024
- 输出文件建议：`outputs/notebook-sprout.png`

```
Light picture-book style standalone illustration: an open warm-paper observation notebook with a small green sprout growing from its center, one tiny sticky note with a heart scribble, white background. Flat shapes, soft outlines, warm white paper, leaf greens, small coral accent. Centered composition, generous padding, no text, no letters, no numbers, no UI, no watermark.
```

## 验收清单

- [ ] 无任何文字/字母/数字/UI/水印
- [ ] 人物完整：头、手、身体不被裁切或叠盖
- [ ] 底色与暖白 `#FFFCF5` 和谐；缩小到 320px 宽仍清晰
- [ ] 画风与现有 `observation-notebook.png`、页面平面语言一致（不为追求细致而 3D 化）
- [ ] 输出含透明通道时，浅底与深底上边缘都干净

## sidecar 记录

- 模型/工具：NOT_RUN
- 参数：—
- 生成时间：—
