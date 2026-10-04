# 教师桌面稿（teacher-desktop）

- 画幅：1536×1024（3:2 横），桌面网页整页示意；内容上限宽 1200px 居中
- 示例数据全部为合成数据；身份、班级、人数、三类状态数量必须与本文自洽
- 输出：`../outputs/02-teacher-desktop.png`；sidecar：`../outputs/02-teacher-desktop.meta.json`

## 固定示例数据（必须在稿中逐字一致）

- 身份：**林小满，上午好** ／ **教师 · 负责 3 个班级 · 54 名幼儿 · 2026–2027 学年**
- 班级（小班→中班顺序）：
  - 小班（2 个班级）：**芽芽班 · 18 名幼儿 · 待确认 2 · 待补充 1 · 待整理 1**；**苗苗班 · 16 名幼儿 · 待确认 1 · 待整理 2**
  - 中班（1 个班级）：**星星班 · 20 名幼儿 · 待补充 1 · 待整理 1**
- 合计：54 名幼儿；**待确认 3 · 待补充 2 · 待整理 4**
- 主行动：**3 条待确认 · 整理好的观察，等你核对。** → 按钮 **去处理待确认**；次级已知待办：**待补充 2 · 待整理 4**
- 待办摘录 3 行：**10月3日 · 糖糖 · 芽芽班 · 待确认**；**10月2日 · 果果 · 星星班 · 待补充**；**9月30日 · 石头 · 苗苗班 · 待整理**
- 最近观察 2 行：**童童 · 已确认归档**；**阿依努尔·麦麦提 · 已确认归档**（长姓名换行示例）

## Prompt

```
Design a clean, light, picture-book style desktop web homepage mockup for a Chinese kindergarten teacher's observation app named 芽芽观察. Canvas 1536x1024, warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue (#4F6079), warm hairline borders (#E9E2D3), sprout-green primary (#008344), amber pending fill (#BF6805). Clean, warm, professional; generous whitespace; NO hand-brushed font anywhere (the brand brush headline belongs to the logged-out page only). All text in clean Chinese sans. Thin borders, no heavy shadows, no data-dashboard look.

Top bar: sprout logo and 芽芽观察 on the left; simple nav links 首页 班级 成长档案 观察记录 更多; on the right a small round avatar, the name 林小满 and a quiet 退出 link.

Identity band: 林小满，上午好 in clean Chinese sans; below it 教师 · 负责 3 个班级 · 54 名幼儿 · 2026–2027 学年; on the right side of this band, a small standalone flat illustration of a teacher and children reading a book (about 320px wide, complete figures, no text, no UI, no overlap with the action panel).

Primary action panel, exactly ONE primary button: warm paper panel with 3 条待确认 · 整理好的观察，等你核对。 and one amber filled button 去处理待确认 (#BF6805). Below the button one quiet secondary line with two text links: 待补充 2 · 待整理 4. Do not create a second primary button.

Section 我的班级, stage groups in this exact order and content:
- 小班（2 个班级）: row 1 芽芽班 · 18 名幼儿 · 待确认 2 · 待补充 1 · 待整理 1; row 2 苗苗班 · 16 名幼儿 · 待确认 1 · 待整理 2
- 中班（1 个班级）: row 星星班 · 20 名幼儿 · 待补充 1 · 待整理 1
Each row is a plain full-width list row with a thin warm divider and a small right arrow — NOT a heavy card, no charts.

Section 待办摘录 with exactly 3 rows, one per category, each showing date, child name, class and a category word chip in clean sans:
- 10月3日 · 糖糖 · 芽芽班 · 待确认
- 10月2日 · 果果 · 星星班 · 待补充
- 9月30日 · 石头 · 苗苗班 · 待整理

Section 最近观察 with 2 rows, each dated, with status word 已确认归档:
- 童童 · 已确认归档
- 阿依努尔·麦麦提 · 已确认归档  (long name wraps to a second line without breaking layout)

No percentages, no radar, no rankings, no other teachers' data, no admin metrics, no guide-association counts. Exact Chinese strings as listed. Aspect 3:2, crisp UI mockup.
```

## 负面提示

```
hand-brushed greeting, brush font outside the brand headline, dark SaaS dashboard, KPI tiles, charts, percentages, rankings, medals, other teachers' lists, full-school tables, second primary button, floating cards over characters, text baked inside illustration, glassmorphism, 3D, watermark, browser chrome, heavy shadows, numbers that contradict the listed counts
```

## 验收清单（生成后）

- [ ] 身份“负责 3 个班级 · 54 名幼儿”；班级列表恰为芽芽班、苗苗班、星星班
- [ ] 班内数字：18+16+20＝54；三类合计 3/2/4，与主行动“3 条待确认”一致
- [ ] 三类待办词分开出现，无“待核对”合并数量，无指南关联数字
- [ ] 唯一主按钮“去处理待确认”（琥珀）；“待补充 2 · 待整理 4”是可点文字链
- [ ] 待办摘录三类各 1 行；最近观察 2 行
- [ ] 长姓名换行不破布局；插画独立完整、不遮挡主行动
- [ ] 全页无毛笔字；无百分比/排名/驾驶舱

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
