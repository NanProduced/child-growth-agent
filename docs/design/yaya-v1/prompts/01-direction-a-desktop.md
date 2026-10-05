# 方向 A·册页卡 — 桌面侧栏稿（direction-a-desktop）R1

- 画幅：1536×1024（3:2），桌面网页；内容上限宽 1200px 居中
- 输出：`../outputs/01-direction-a-desktop.png`；sidecar：`../outputs/01-direction-a-desktop.meta.json`
- 用途：评审方向 A（低密度、卡内核对、长答可展开）
- 统一案例（全部 prompts 共用，详见 `../synthetic-example.md`）：小满/阿依 · 中班·向日葵班 · 10月8日 · 积木区 · 2 张照片

## Prompt

```
Design a desktop web app mockup (1536x1024) for a Chinese kindergarten teacher observation product named 芽芽观察. Calm, light "growth observation notebook" style: warm white background (#FFFCF5), navy ink (#15264D), muted gray-blue secondary text, sprout-green primary buttons (#008344), warm hairline borders (#E9E2D3), generous whitespace, thin borders, no heavy shadows, no dark SaaS look.

BACKGROUND PAGE (kept quiet, slightly dimmed behind the open panel): a simple class observation page for a teacher: top nav with product name 芽芽观察 and four quiet text links 首页 班级 成长档案 观察记录; page title 观察记录; a light list of two observation rows, each with a date, a green badge 已确认归档 and a short line of Chinese text. No charts, no KPIs, no garden map, no illustration scene.

RIGHT SIDE PANEL (about 420px wide, slides over the page, rounded 16px, 1px warm border, quiet shadow):
- header: a tiny flat green sprout mascot 24px, title 芽芽, right side small text buttons 历史 and ✕.
- message area with ONE large notebook-style card titled 观察草稿卡, with a small amber badge 待核对 and metadata 小满 · 10月8日 · 积木区.
- inside the card: a light gray quote block with this exact observation text: 小满自己搭长桥，中间塌了三次，他换了更宽的底座，第四次搭稳了。 ; a row of TWO small photo thumbnails (one wide block-area photo labeled 共同, one close-up labeled 长桥特写); an AI section with a small violet badge AI 生成 and rows 科学 · 数学认知, 发展表现说明 / 发展亮点 / 支持建议 with a small text link 展开全文.
- an expanded 核对区 sub-block with a simple two-column fact list: 对象 小满（中班·向日葵班）, 日期 10月8日, 事实依据 与原文逐字对照, 附件 积木区全景（与阿依共用）+ 长桥特写; a small action 查看对照.
- card footer: an outline button 修改草稿 and a green primary button 确认归档.
- below the card, one short assistant line in plain text (no bubble): 归档后记录会进入成长档案.
- input area at the bottom: two small chips 对象：小满 and 来源：观察草稿, a text placeholder 写下补充或新问题…, a paperclip icon and a circular green send button.
- bottom-right of the page, a small floating green sprout entry button labeled 芽芽.

Style: clean flat illustration only for the tiny mascot and thumbnails; everything else crisp UI. Chinese text must be accurate and legible, minimal amount. Aspect 3:2.
```

## 负面提示

```
real children faces, photo-realism, 3D, garden map, homepage hero, KPI tiles, charts, percentages, ranking, role selector, dark dashboard, glassmorphism, heavy shadows, watermark, browser chrome, extra unread badges, emoji as status, other children names (糖糖/小雨/小北), other dates (4月2日), other scenes (娃娃家)
```

## 验收清单（生成后）

- [ ] 面板宽度约 1/4 屏，覆盖页面不推挤；页面保持安静
- [ ] 卡片含：状态徽章、对象/日期、原文逐字、AI 标记、核对区、动作
- [ ] 照片为 2 张缩略图（1 张标注共同）；人物仅小满/阿依，日期 10月8日，场景积木区
- [ ] 状态有文字（待核对/AI 生成），不只靠颜色；长文有“展开全文”
- [ ] 无评分、排名、KPI、首页地图；无真实儿童面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
