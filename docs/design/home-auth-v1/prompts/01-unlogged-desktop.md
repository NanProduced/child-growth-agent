# 未登录桌面稿（unlogged-desktop）

- 画幅：1536×1024（3:2 横），桌面网页整页示意
- 内容上限宽 1200px 居中，顶部为产品顶栏
- 参考输入（可选）：`codex-clipboard-42357a39-db68-473f-b747-bb9735d78974.png` —— 只用于理解品牌色，**禁止复制其构图**
- 输出文件建议：`outputs/01-unlogged-desktop.png`

## Prompt

```
Design a clean, light, picture-book style desktop web homepage mockup for a Chinese kindergarten teacher's growth-observation app named 芽芽观察. Canvas 1536x1024, warm white background (#FFFCF5). Navy ink text (#15264D), muted gray-blue secondary text (#4F6079), sprout-green primary action (#008344), warm gray hairline borders (#E9E2D3), soft amber pending accent (#BF6805) used very sparingly. Flat, calm, professional-but-warm illustration style; clean Chinese sans for body; hand-brushed Chinese display font (Ma Shan Zheng feel) for the headline. Generous whitespace, thin warm borders, no heavy shadows.

Top bar: small sprout logo and the product name 芽芽观察 on the left; on the right one outlined quiet button 教师登录. No other navigation items, no data.

Main hero, two columns inside a centered 1200px content area:
LEFT column (about 55%): a small muted eyebrow label 面向幼儿园教师的成长观察与活动支持智能体; a large hand-brushed headline in navy, two lines, reading exactly "以三年为序，" and "看见幼儿持续生长"; below it a muted helper line reading exactly "从小班到大班，连接观察证据与教育支持。"; below that a compact warm-paper login panel (rounded 18px, 1px warm border, no heavy shadow) titled 教师登录, with two labeled fields 账号 and 密码 (both empty, placeholders only, no password shown), a full-width green primary button 登录 (#008344), and a quiet helper line 账号由园所管理员分配，角色由账号决定.
RIGHT column (about 45%): one complete standalone flat picture-book illustration of a calm kindergarten corner: one young teacher and three small children sitting around a big open picture book on a warm rug, a potted sprout, soft plants, warm white background. The illustration is fully visible inside its own area; NO text, NO UI, NO cards on it; no person is covered by any panel.

Below the hero: one quiet horizontal strip of three small steps with tiny line icons: 记录原始观察 → AI 整理草稿 → 教师确认归档; muted text, no cards, no numbers, no statistics.

No children's data, no class counts, no observations, no admin entries anywhere. Exact Chinese strings only as listed above. Aspect 3:2, crisp UI mockup, flat illustration, high legibility.
```

## 负面提示

```
dark SaaS dashboard, sidebar, data tiles, children data, class counts, statistics, radar chart, percentages, floating cards over characters, text baked inside illustration, gradient mesh, glassmorphism, 3D, watermark, browser chrome, extra navigation links
```

## 验收清单

- [ ] 主文案与辅助语逐字正确，两行排布，未占满首屏
- [ ] 登录面板在定位区下方，与右侧插画无重叠
- [ ] 插画是完整独立场景，画内无文字/按钮/数据，人物无遮挡
- [ ] 页面无任何儿童数据、班级人数、观察内容、管理入口
- [ ] 主按钮为芽叶绿，暖白底、薄边框，无 SaaS 阴影
- [ ] 中文渲染可读；如错字严重按 README 说明重出

## sidecar 记录

- 模型/工具：NOT_RUN
- 参数：—
- 生成时间：—
