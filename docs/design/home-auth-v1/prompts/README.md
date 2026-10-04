# ImageGen 出稿 prompt 包（home-auth-v1）

**状态：NOT_RUN。** 本轮环境没有可用的内置 ImageGen 工具；按任务约定未使用 API 密钥或 CLI 替代，未用 CSS/emoji 冒充插画。以下 prompt 在具备 ImageGen 的环境可直接出稿。

## 出稿顺序与文件

| # | 文件 | 产出 | 画幅 |
|---|---|---|---|
| 01 | `01-unlogged-desktop.md` | 未登录桌面稿 | 1536×1024（3:2 横） |
| 02 | `02-teacher-desktop.md` | 教师桌面稿 | 1536×1024（3:2 横） |
| 03 | `03-admin-desktop.md` | 管理员桌面稿 | 1536×1024（3:2 横） |
| 04 | `04-teacher-mobile-390.md` | 教师 390 窄屏稿 | 780×1688（9:19.5 竖） |
| 05 | `05-illustrations.md` | 主插画素材（可复用素材的替代/统一画风） | 1536×768 等 |

## 运行方式

1. 使用内置 ImageGen 工具；每次只出一张稿，保持同一风格块（见下）。
2. 可选参考输入：`codex-clipboard-42357a39-db68-473f-b747-bb9735d78974.png`。**仅作品牌色与“要避免的问题”的上下文**，prompt 中已明确禁止复制其构图（全屏地图、盖住人物的纸牌）。
3. 出稿后逐张检查对应文件末尾的“验收清单”。
4. 文字说明：图像模型渲染中文可能缺字或错字。稿中文字只用于设计沟通；**实现一律 HTML**，图内文字不得当作产品文案。若中文明显损坏，减少图内文字重出，或后期叠加文字层。
5. 生成完成后把实际 prompt、模型与参数写入对应文件末尾的“sidecar 记录”。

## 共享风格块（每张稿都适用）

- 画布：暖白 `#FFFCF5`；详情纸面 `#FFFEF9`；分隔线 `#E9E2D3`。
- 文字：深墨海军蓝 `#15264D`；辅助灰蓝 `#4F6079`。
- 主行动：芽叶绿 `#008344`（悬停 `#006C37`）；焦点深绿 `#006840`。
- 确认/待核对：琥珀 `#BF6805`。
- 学段识别：小班珊瑚 `#A7284E`、中班金赭 `#8D560E`、大班蓝 `#1B5A94`（只作识别，不表示程度）。
- 形状：8/12/18/24px 圆角，1px 暖色薄边，轻环境阴影；移动端主按钮为 56px 胶囊。
- 字体：主标题用毛笔感中文展示字（Ma Shan Zheng 气质），正文/标签/按钮用干净的中文无衬线（思源黑体/PingFang 气质）。
- 插画：轻绘本平面风、少量卡通、柔和轮廓、暖白底；人物完整、不被任何卡片覆盖。
- 动效不体现在静帧稿中。

## 全局负面提示（追加到每张稿）

```
dark SaaS dashboard, sidebar, KPI tiles, radar chart, percentage circles, rankings, medals, gamification badges, 3D render, photorealism, glassmorphism, neon, heavy drop shadows, full-screen busy garden map, floating paper cards overlapping characters, UI elements baked into illustration, watermark, browser chrome, real logos, photographic children, visual clutter, text other than the specified Chinese strings
```

## Sidecar 台账（出稿后填写）

| 文件 | 模型/工具 | 参数 | 生成时间 | 备注 |
|---|---|---|---|---|
| 01 | — | — | — | NOT_RUN |
| 02 | — | — | — | NOT_RUN |
| 03 | — | — | — | NOT_RUN |
| 04 | — | — | — | NOT_RUN |
| 05 | — | — | — | NOT_RUN |
