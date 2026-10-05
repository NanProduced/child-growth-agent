# 小芽六姿态状态板（yaya-states）

- 画幅：1536×1024（3:2）；输出：`../outputs/07-yaya-states.png`；sidecar：`../outputs/07-yaya-states.meta.json`
- 用途：评审小芽角色姿态与文字配合（安静/响应中/待确认/保存中/成功/异常）；不含界面布局

## Prompt

```
Design a clean character state sheet (1536x1024) on a warm white background (#FFFCF5) for 芽芽, a tiny flat green sprout mascot of a Chinese kindergarten observation assistant. Simple flat vector shapes, one small sprout with two leaves, a round seed body, two dot eyes, thin stem; consistent design across all six states, small and restrained (each about 120px), thin warm hairline separators, navy ink labels.

Six labeled cells in a 3x2 grid, each with the mascot, a small static status badge, and the exact Chinese label beneath:
1. 安静 — sprout upright, eyes closed, no badge, text 安静
2. 响应中 — sprout leaning forward attentively, a small sky-blue dot badge, text 响应中 · 正在想…
3. 待确认 — sprout holding a tiny amber flag, amber dot badge, text 待确认 · 请你核对
4. 保存中 — sprout leaves wrapped around itself, amber ring badge, text 保存中 · 正在保存…
5. 成功 — sprout open and relaxed, small green check badge, text 已保存
6. 待核对/异常 — sprout with leaves curled back, amber warning badge, text 保存结果待核对

No animation, no motion lines, no 3D, no gradients, no glow, no emoji smileys, no text other than the specified labels, no UI screens, no children. Flat, friendly, professional, high legibility.
```

## 负面提示

```
3D, gradient, glow, animation frame, motion lines, emoji, stickers, oversized mascot, children, UI mockup, watermark, extra text, dark background
```

## 验收清单（生成后）

- [ ] 六姿态差异清晰且同一角色一致性
- [ ] 每格有准确中文标签与文字徽章
- [ ] 无动画感、无 3D、无 emoji
- [ ] 缩到 32px 仍可辨姿态；颜色不是唯一线索

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
