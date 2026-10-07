# 教师 390 窄屏稿（teacher-mobile-390）

- 画幅：780×1688（按 390×844 的 2 倍输出），手机整页示意；单列、无横向滚动、触控目标 ≥44px
- 示例数据全部为合成数据；与教师桌面稿同一套数字
- 输出：`../outputs/04-teacher-mobile-390.png`；sidecar：`../outputs/04-teacher-mobile-390.meta.json`

## 固定示例数据（必须在稿中逐字一致）

- 身份：**林小满，上午好** ／ **教师 · 负责 3 个班级 · 54 名幼儿 · 2026–2027 学年**
- 主行动：**去处理待确认 · 3**（56px 全宽琥珀胶囊）；次级文字链 **待补充 2 · 待整理 4**
- 班级：小班（2 个班级）→ **芽芽班 · 18 名幼儿 · 待确认 2**、**苗苗班 · 16 名幼儿 · 待确认 1**；中班（1 个班级）→ **星星班 · 20 名幼儿 · 待整理 1**
- 待办摘录 2 行：**糖糖 · 芽芽班 · 待确认**；**果果 · 星星班 · 待补充**
- 最近观察 2 行：**童童 · 已确认归档**；**阿依努尔·麦麦提 · 已确认归档**（长姓名换行示例）

## Prompt

```
Design a clean, light, picture-book style mobile web homepage mockup for a Chinese kindergarten teacher's observation app named 芽芽观察. Portrait canvas 780x1688 (phone 390pt at 2x), warm white background (#FFFCF5). Navy ink (#15264D), muted gray-blue (#4F6079), warm hairline borders (#E9E2D3), sprout-green primary (#008344), amber pending fill (#BF6805). Single column, generous whitespace, all text in clean Chinese sans (NO hand-brushed font on this page), no heavy shadows, no desktop two-column layout.

Order, top to bottom:
1) Top app bar: small sprout logo and 芽芽观察 on the left, a simple menu icon on the right.
2) Identity block: 林小满，上午好; below it 教师 · 负责 3 个班级 · 54 名幼儿 · 2026–2027 学年; small round avatar on the right.
3) Primary action FIRST, before any illustration: one full-width pill button, 56px tall, amber (#BF6805), label 去处理待确认 · 3; directly below it a quiet line with two text links 待补充 2 · 待整理 4. No second primary button.
4) Standalone illustration banner: one complete flat picture-book illustration of a teacher and children reading a picture book on a warm rug, full width about 160px tall, complete figures and scene, NO text, NO UI, nobody cropped or covered.
5) Section 我的班级, grouped by stage:
- 小班（2 个班级）: rows 芽芽班 · 18 名幼儿 · 待确认 2 and 苗苗班 · 16 名幼儿 · 待确认 1, thin warm dividers, small arrow each.
- 中班（1 个班级）: row 星星班 · 20 名幼儿 · 待整理 1.
6) Section 待办摘录 with 2 rows: 糖糖 · 芽芽班 · 待确认 and 果果 · 星星班 · 待补充.
7) Section 最近观察 with 2 rows, status 已确认归档: 童童; 阿依努尔·麦麦提 (long name wraps without breaking layout).

No horizontal scrolling, no tables, no charts, no admin entries, no percentages or rankings. Exact Chinese strings as listed. Crisp UI mockup, flat illustration, high legibility at 390pt.
```

## 负面提示

```
hand-brushed font, desktop two-column layout, illustration above the primary action, dark SaaS dashboard, charts, tables, horizontal scroll, floating cards over characters, text baked inside illustration, second primary button, glassmorphism, 3D, watermark, phone chrome, heavy shadows
```

## 验收清单（生成后）

- [ ] 主行动在插画之前，全宽 56px；“待补充 2 · 待整理 4”为次级文字链
- [ ] 插画横幅完整，人物不裁切、不被覆盖，画内无文字/UI
- [ ] 小班组内两个班同屏可见；星星班在中班组
- [ ] 数字与教师桌面稿一致（3 个班级、54 名幼儿、3/2/4）
- [ ] 长姓名“阿依努尔·麦麦提”换行不破布局；无横向滚动
- [ ] 全页无毛笔字；无管理入口

## sidecar 记录

- 工具/模型：NOT_RUN（未知，不猜测）
- 尺寸：—
- 生成时间：—
