# 方向 B·短句流 — 桌面侧栏稿（direction-b-desktop）

- 画幅：1536×1024（3:2）；输出：`../outputs/03-direction-b-desktop.png`；sidecar：`../outputs/03-direction-b-desktop.meta.json`
- 用途：评审方向 B（高密度短消息、逐步核对、抽屉编辑）

## Prompt

```
Design a desktop web app mockup (1536x1024) for a Chinese kindergarten observation assistant 芽芽, calm warm-white notebook style (#FFFCF5), navy ink (#15264D), sprout-green primary (#008344), hairline borders, light and quiet, no dark dashboard.

BACKGROUND PAGE (softly dimmed, simple class list page with one row highlighted): top nav 芽芽观察 + quiet links 首页 班级 成长档案 观察记录; two observation rows with dates and green badges 已确认归档.

RIGHT CHAT PANEL (about 420px, over the page, rounded 16px, 1px warm border): 
- header: tiny flat green sprout mascot, title 芽芽, small 历史 and ✕.
- a conversational thread of SHORT chat messages, each max 2 lines, distinct user (pale green) and assistant (white) bubbles:
  1. assistant: 收到，这次在娃娃家看到的？
  2. user: 小满自己搭长桥，塌了三次换了底座成功了。
  3. assistant: 好，整理成观察草稿吗？ with two small inline buttons: green 整理成草稿 and outline 只保存原文.
  4. assistant: 整理好了：社会 · 同伴交往。 with one compact preview row 草稿预览 2 行… and an outline button 核对草稿.
  5. assistant receipt line in small text: 已确认归档。档案已更新。 · 14:32
- an open EDIT DRAWER anchored on the right/center over the panel, titled 核对草稿, containing: metadata row 对象 小满 · 日期 4月2日, the observation quote block, editable fields rows (领域 社会, 子领域 同伴交往, two short highlight lines), a small photo thumbnail row, and a drawer footer: outline 保存修改并重新审核 and green primary 确认归档.
- bottom input: small chips 对象：小满, 来源：观察草稿; rounded field placeholder 回复…; paperclip; circular green send button.
- small floating sprout entry button bottom-right of the page.

Flat, crisp, high legibility, minimal accurate Chinese text; no real children faces.
```

## 负面提示

```
long chat bubbles, paragraphs of text, dark theme, KPI, charts, garden map, real children faces, photo-realism, 3D, glassmorphism, heavy shadows, emoji as status, watermark, browser chrome
```

## 验收清单（生成后）

- [ ] 对话为短气泡（≤3 行），检查点各有明确按钮
- [ ] 抽屉是核对与批准的唯一位置；面板仍可见
- [ ] 回执为系统小行，含时间等事实
- [ ] 状态有文字；无 KPI/评分/地图
- [ ] 中文可读，无真实面孔

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
