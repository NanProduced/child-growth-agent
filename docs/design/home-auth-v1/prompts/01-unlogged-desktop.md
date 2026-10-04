# 未登录桌面稿（unlogged-desktop）

- 画幅：1536×1024（3:2 横），桌面网页整页示意；内容上限宽 1200px 居中
- 参考输入（可选）：`codex-clipboard-42357a39-db68-473f-b747-bb9735d78974.png`，**只作要避免的构图上下文，禁止复制**
- 输出：`../outputs/01-unlogged-desktop.png`；sidecar：`../outputs/01-unlogged-desktop.meta.json`

## Prompt

```
Design a clean, light, picture-book style desktop web homepage mockup for a Chinese kindergarten observation app named 芽芽观察. Canvas 1536x1024, warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue (#4F6079), sprout-green primary (#008344), warm hairline borders (#E9E2D3). Generous whitespace, thin warm borders, no heavy shadows, no dark SaaS look.

Top bar: small sprout logo and product name 芽芽观察 on the left; only ONE outlined button 园所账号登录 on the right. NO other navigation links, no business nav, no data.

Main hero, two columns inside a centered 1200px content area:
LEFT column (about 55%):
- small muted eyebrow label in clean Chinese sans: 面向幼儿园教师的成长观察与活动支持智能体
- the ONLY hand-brushed Chinese display text on the page, navy, two lines, reading exactly "以三年为序，" and "看见幼儿持续生长"
- a muted helper line in clean Chinese sans: 从小班到大班，连接观察证据与教育支持。
- below: a compact warm-paper embedded login panel (rounded 18px, 1px warm border, no heavy shadow), title 园所账号登录 in clean sans, two labeled empty fields 账号 and 密码 (placeholders only, no password shown), a full-width green primary button 登录 (#008344), and a quiet helper line 账号由园所管理员分配，登录后按账号角色进入相应工作台。 NO role selector, NO admin/teacher switch, NO registration link.
RIGHT column (about 45%): one complete standalone flat picture-book illustration of a calm kindergarten reading corner: a young Chinese teacher and three small children around one big open picture book on a warm rug, a potted sprout, soft plants, warm white background. Fully visible in its own area, NO text, NO UI, NO cards on it, nobody covered.

Below the hero: one quiet horizontal strip of three steps with small line icons, all text in clean Chinese sans: 记录原始观察 → AI 整理草稿 → 教师确认归档. Muted, no cards, no numbers, no statistics.

No children data, no class counts, no observations, no management entries anywhere. Aspect 3:2, crisp UI mockup, flat illustration, high legibility.
```

## 负面提示

```
business navigation links, class counts, children data, observation text, management entries, role selector, admin/teacher switch, registration, floating cards over characters, text baked inside illustration, dark SaaS dashboard, KPI tiles, glassmorphism, 3D, watermark, browser chrome, heavy shadows, extra Chinese strings beyond the specified ones
```

## 验收清单（生成后）

- [ ] 主标题逐字：“以三年为序，看见幼儿持续生长”；辅助语逐字：“从小班到大班，连接观察证据与教育支持。”
- [ ] **全页唯一毛笔字是主标题**；登录面板、按钮、标签、步骤均为无衬线
- [ ] 登录入口文案为“园所账号登录”，无角色选择器、无注册、无身份切换
- [ ] 顶栏仅品牌与登录按钮，业务导航全部隐藏
- [ ] 插画独立完整、无文字/UI/数据，人物无遮挡、不裁切
- [ ] 无儿童数据、班级人数、观察内容
- [ ] 主按钮芽叶绿；暖白底薄边框，无 SaaS 阴影
- [ ] 中文渲染可读；错字严重时按 README 规则重出

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
