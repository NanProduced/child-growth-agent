# ImageGen 出稿 prompt 包（home-auth-v1 · R1）

**状态：NOT_RUN。** 本环境没有可用的内置 ImageGen 工具；按任务约定未使用 API 密钥或 CLI 替代，未用 CSS/emoji 冒充插画。以下 prompt 已对齐 AUTH0-R2 契约（`cfa7b0343fc942ef80dc908ddfb47a96cb5a44dd`）与 HOME0-R1 修正项，在具备 ImageGen 的环境可直接出稿。

## 出稿清单

| # | 文件 | 产出 | 画幅 | 输出文件（本工作树） |
|---|---|---|---|---|
| 01 | `01-unlogged-desktop.md` | 未登录桌面稿 | 1536×1024（3:2 横） | `outputs/01-unlogged-desktop.png` |
| 02 | `02-teacher-desktop.md` | 教师桌面稿 | 1536×1024（3:2 横） | `outputs/02-teacher-desktop.png` |
| 03 | `03-admin-desktop.md` | 管理员桌面稿 | 1536×1024（3:2 横） | `outputs/03-admin-desktop.png` |
| 04 | `04-teacher-mobile-390.md` | 教师 390×844 窄屏稿 | 780×1688（2x 竖） | `outputs/04-teacher-mobile-390.png` |
| 05 | `05-illustrations.md` | 独立无文字主插画素材 | 1536×768（2:1 横） | `outputs/hero-teacher-children.png` |

四张稿同一视觉系统、逐张分别生成；插画素材单独生成。

## 运行方式

1. 使用内置 ImageGen 工具，每次一张；每张稿重复共享风格块。
2. 可选参考输入：`codex-clipboard-42357a39-db68-473f-b747-bb9735d78974.png`，**仅作“要避免的问题”上下文**；禁止复制其构图（全屏地图、盖住人物的纸牌）。
3. 出稿后逐张执行文件末尾“验收清单”，并执行 `../handoff-r1.md` 的批量检查；必要时只做一次集中修正。
4. **文字说明**：图像模型渲染中文可能缺字/错字。稿中文字只用于设计沟通；实现一律 HTML。图内文字不得当作产品文案；毛笔展示字只出现在未登录稿的固定品牌主标题。
5. 出稿后写 `outputs/<name>.meta.json`（工具、模型、实际尺寸、时间、prompt 文件；未知写 `"unknown"`/“未知”，不猜测），并回填 `outputs/README.md` 台账。不覆盖或删除原有素材。

## 共享风格块（每张稿适用）

- 画布：暖白 `#FFFCF5`；纸面 `#FFFEF9`；分隔线 `#E9E2D3`。
- 文字：深墨海军蓝 `#15264D`；辅助灰蓝 `#4F6079`。
- 主行动：芽叶绿 `#008344`（悬停 `#006C37`）；焦点深绿 `#006840`；确认/待确认琥珀 `#BF6805`。
- 学段识别：小班珊瑚 `#A7284E`、中班金赭 `#8D560E`、大班蓝 `#1B5A94`（只作识别）。
- 形状：8/12/18/24px 圆角，1px 暖色薄边，轻环境阴影；移动端主按钮 56px 胶囊。
- 字体：**仅固定品牌主标题**“以三年为序，看见幼儿持续生长”用毛笔感中文展示字（Ma Shan Zheng 气质）；其余全部中文无衬线（思源黑体/PingFang 气质）。
- 插画：轻绘本平面风、少量卡通、暖白底；人物完整无遮挡、不裁切；画内无文字/按钮/数据/UI。
- 动效不体现在静帧稿中。

## 全局负面提示（追加到每张稿）

```
dark SaaS dashboard, sidebar, KPI tiles, charts, radar, percentage circles, rankings, medals, gamification badges, 3D render, photorealism, glassmorphism, neon, heavy drop shadows, full-screen busy garden map, floating cards overlapping characters, UI elements baked into illustration, watermark, browser chrome, real logos, photographic children, role selector, admin/teacher switch, registration form, visual clutter, text other than the specified Chinese strings
```

## 台账与 NOT_RUN

图片链接与 sidecar 台账见 `../outputs/README.md`（本轮全部 NOT_RUN）。修正前后对照与 HOME1 交接见 `../handoff-r1.md`。
