---
name: 芽芽观察
description: 轻量、温和、证据导向的幼儿园教师成长观察应用
colors:
  home-map-green: "#008344"
  home-map-ink: "#15264d"
  home-map-muted: "#4f6079"
  home-map-paper: "#fffcf5"
  home-map-line: "#e9e2d3"
  home-stage-small: "#a7284e"
  home-stage-middle: "#8d560e"
  home-stage-large: "#1b5a94"
  home-confirm: "#bf6805"
  home-focus: "#006840"
  home-detail-paper: "#fffef9"
typography:
  home-heading:
    fontFamily: "var(--font-garden-display), serif"
    fontSize: "clamp(34px, 9.6vw, 48px)"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  home-action:
    fontFamily: "var(--font-garden-display), serif"
    fontSize: "clamp(24px, 2vw, 30px)"
    fontWeight: 400
    lineHeight: 1.2
  home-stage:
    fontFamily: "var(--font-garden-display), serif"
    fontSize: "31px"
    fontWeight: 400
    lineHeight: 1.3
  home-body:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    lineHeight: 1.7
  home-label:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    lineHeight: 1.7
rounded:
  home-field: "8px"
  home-control: "18px"
  home-panel: "24px"
  home-action: "999px"
spacing:
  home-list-gap: "8px"
  home-node-gap: "12px"
  home-panel-padding: "14px"
  home-page-inset: "16px"
components:
  home-button-primary:
    backgroundColor: "{colors.home-map-green}"
    textColor: "#ffffff"
    rounded: "{rounded.home-action}"
    height: "56px"
  home-button-primary-hover:
    backgroundColor: "#006c37"
  home-button-primary-desktop:
    backgroundColor: "{colors.home-map-green}"
    textColor: "#ffffff"
    rounded: "12px"
    height: "56px"
  home-workspace:
    backgroundColor: "{colors.home-map-paper}"
    textColor: "{colors.home-map-ink}"
    rounded: "18px"
    padding: "20px"
    width: "28.5%"
  home-all-school:
    backgroundColor: "{colors.home-map-paper}"
    textColor: "{colors.home-map-ink}"
    rounded: "16px"
    padding: "12px"
    width: "clamp(320px, 28%, 380px)"
  home-button-confirm:
    backgroundColor: "{colors.home-confirm}"
    textColor: "#ffffff"
    rounded: "{rounded.home-action}"
    height: "44px"
  home-button-confirm-hover:
    backgroundColor: "#a05704"
  home-heading-caption:
    textColor: "#374f6b"
  home-stage-small:
    backgroundColor: "#fff0ed"
    textColor: "{colors.home-stage-small}"
    rounded: "{rounded.home-panel}"
    padding: "12px 12px 12px 2px"
    height: "142px"
  home-stage-desktop:
    backgroundColor: "{colors.home-map-paper}"
    rounded: "18px 22px 18px 14px"
    padding: "12px 14px"
    height: "112px"
  home-stage-expanded:
    rounded: "{rounded.home-action}"
    padding: "9px 16px"
    height: "62px"
  home-class-node:
    backgroundColor: "{colors.home-map-paper}"
    textColor: "{colors.home-map-ink}"
    rounded: "{rounded.home-control}"
    padding: "10px 12px 10px 4px"
  home-class-detail:
    backgroundColor: "{colors.home-detail-paper}"
    textColor: "{colors.home-map-ink}"
    rounded: "{rounded.home-panel}"
    padding: "14px"
  home-child-picker:
    backgroundColor: "{colors.home-detail-paper}"
    textColor: "{colors.home-map-ink}"
    rounded: "{rounded.home-field}"
    padding: "8px"
    height: "44px"
---

<!-- SEED: non-homepage values remain unresolved. Homepage-only v2 tokens above were extracted from the finished map; they do not replace the global theme. -->

# Design System: 芽芽观察

## Overview

**Creative North Star: “轻量成长观察册”**

芽芽观察是一款面向幼儿园教师的轻量成长观察应用。它的视觉不应像企业 SaaS 控制台，也不应像儿童游戏，而应像一本清爽、可持续阅读的数字观察册：教师可以快速开始记录，回到最近的成长片段，查看待确认内容，并沿着时间线理解一个小朋友的变化。

卡通元素通常只承担情绪和识别作用，不承担信息结构。插图应小、简单、克制，服务于空状态、入口、头像和少量情境提示；主要信息仍由清晰的文字、时间线和证据关系表达。

首页“全园成长地图”是用户批准的局部例外：连续绘本式幼儿园成为强主场景，海军蓝毛笔字、亮叶绿主行动、绘画感人物、草地留白、独立全园工具栏与正面纸面工作区组成同一世界；园所、学段、具体班级、数量、状态和操作仍由 HTML 表达。此例外不改变其他页面的“轻量成长观察册”方向，首页构图见 `.impeccable/surfaces/src-app-page-tsx.md`。

**Key Characteristics:**

- 轻量应用，不做后台控制台
- 温暖但不幼稚，专业但不冷漠
- 常规页面使用少量平面卡通插图；首页采用一幅强主场景，避免装饰泛滥
- 以观察证据和成长故事为核心
- 低信息噪声、低认知负担、单一明确主行动

## Colors

使用暖白作为主画布，以深墨色保证阅读，以芽绿色表达成长和安全，以柔和蓝色、珊瑚色和琥珀色表达不同观察情境或状态。颜色是辅助理解的线索，不是评分等级。

### Primary

- **芽叶绿**（to be resolved during implementation）：用于主要行动、成长提示、确认完成和品牌识别。

### Secondary

- **晨光蓝**（to be resolved during implementation）：用于观察记录、信息提示和冷静的辅助状态。
- **柔和珊瑚**（to be resolved during implementation）：用于需要教师关注的温和提醒，不表达负面评价。

### Tertiary

- **观察琥珀**（to be resolved during implementation）：用于重要但不紧张的待确认状态。

### Neutral

- **暖白画布**（to be resolved during implementation）：全局页面背景，保持轻盈和纸张般的温度，但不使用明显纸纹。
- **深墨文字**（to be resolved during implementation）：标题和正文主要文字。
- **柔灰边界**（to be resolved during implementation）：轻量分隔、输入边界和时间线辅助线。

### Named Rules

**The Small Illustration Rule.** 常规页面的卡通插图只占据局部空间；首页批准的花园主场景可以占据首屏，但事实和控件必须保留为 HTML。

**The No-Score Color Rule.** 颜色不得表示幼儿发展高低、等级、排名或领域完成度。

### Homepage-only palette

前置元数据中所有 `home-*` 项只适用于首页 v2，来源为 `src/components/homepage-map.module.css`。海军蓝承担主要文字，灰蓝用于辅助信息，暖纸承托连续场景与阅读；亮叶绿用于主行动，深绿用于清晰焦点，确认操作使用琥珀色。珊瑚、金赭和蓝只帮助识别小班、中班、大班。它们不替换 `globals.css` 的全局 OKLCH 主题，也不表示幼儿发展程度。

## Typography

**Display Font:** 亲和、清晰的中文无衬线字体（to be resolved during implementation）

**Body Font:** 与标题同一字体家族或协调的中文无衬线字体（to be resolved during implementation）

**Character:** 常规页面的字体应像一位清晰、温和、可靠的教师：有亲和力，但不使用过度圆润、玩具化或手写化的字体。首页批准的绘本毛笔展示字是局部例外；正文仍优先保证中文长文本阅读和窄屏可读性。

### Hierarchy

- **Display:** 只用于首页问候和极少量核心入口，避免大标题占满首屏。
- **Headline:** 用于页面标题和成长故事标题，保持清晰而有温度。
- **Title:** 用于观察证据、待确认、成长档案等主要区块。
- **Body:** 用于观察事实、教师说明和支持建议，保持舒适行宽。
- **Label:** 用于状态、日期、领域和辅助信息，短而明确，不使用全大写或装饰性字距。

### Homepage-only hierarchy

首页展示字采用自托管 MaShanZheng（Ma Shan Zheng），由 `next/font/local` 暴露 `--font-garden-display`，仅用于首页大标题、宽屏行动标题、全园摘要、学段名与最近观察区标题。子集文件 `public/assets/fonts/yaya-display-subset.ttf` 为（20,204 bytes），许可随 `OFL-MaShanZheng.txt` 保留；采用 swap 和预加载，覆盖范围之外回落到 serif，不将该子集推广为全站正文。

首页大标题窄屏值见前置元数据，宽屏为（clamp(48px, 4.1vw, 78px) / 1.2 / 400），第二行缩至（0.87em）；行动标题只在宽屏显示，学段名宽屏为（clamp(25px, 2.2vw, 37px)）。正文、数量、状态和控件继承 `globals.css` 的中文无衬线／系统后备栈；观察摘要窄屏为（13px / 1.7），宽屏为（12px），最多两行。班级名为（16px / 700），宽屏按（clamp(13px, 1.05vw, 18px)）适配。

**The Homepage Heading Safe-Ground Rule.** 标题整体由暖纸 radial 渐隐承托，副标题自身不再套矩形底；中央辅助语按组宽居中并平衡换行，“最近观察”标签保持 4em 单行。

## Layout

页面采用轻量叙事布局，而非复杂管理后台：

- 顶部使用简洁导航，不使用固定的企业级侧边栏。
- 首页围绕一个依当前记录状态决定的主行动，辅以“待确认观察”和“最近观察”；有待确认时优先确认，记录入口仍可到达。
- 观察记录以时间线和轻量行项目展示，避免每条记录都被包裹成厚重卡片。
- 成长档案以单个小朋友为中心，先展示最近变化和观察证据，再提供领域透镜。
- review 页面桌面端可使用原文与 AI 草稿并列；窄屏端按“原文 → 草稿 → 确认”顺序单列展开。
- 页面保留充足留白，但不制造大面积无意义空白；每个区块都应服务于记录、确认或回顾。
- 窄屏优先单列重排，不依赖横向滚动承载核心信息。

**The Homepage Confirmation-First Rule.** 选中班级有待确认观察时，主行动直接进入该条 review；否则按全园待确认、待补充、建立首个班级、建立首份档案、开始记录的顺序选择一个主行动。

**The Homepage In-Scene Rule.** 从全园到真实班级的探索留在同一绘本地图中；中央主行动始终可达，学段不是具体班级，节点不能由固定样例代替。

首页从（1024px）采用铺满导航下方的横向场景，内部画布最大（1920px），高度为（min(50vw, 960px)）。学段原位展开为真实多班级节点，节点列表两列排布，选择后由紧凑详情接替列表；列表面板按可用空间限制高度：小班为（calc(0.62 × 场景高度 − 100px)），右侧中／大班为（calc(0.45 × 场景高度 − 90px)），选中详情为（0.44 × 场景高度）；超出在局部纵向滚动，右侧牌面随当前选择精简重排以免互相覆盖。详情与列表回退在地图内完成，不将它们放回地图下方的大面板。宽于（1920px）使用独立（8:3）的广幅场景素材。

窄于（1024px）使用独立竖幅插画，主场景高度为（clamp(440px, 125vw, 620px)），随后沿自然流显示主行动、全园摘要、纵向学段折叠项及班级内容、待确认、最近观察；（390px）不需要横向地图交互。中间宽度（640–1023px）仅将班级节点与观察列表转为两列。既有顶部导航在（1024px）以下重排为两行，保留文字与图标；核心触控目标至少（44px）。

## Elevation & Depth

默认使用平面和色调层级表达空间关系。边界优先使用暖灰线、浅色表面和间距；阴影只用于弹出层、抽屉和需要被暂时聚焦的主要操作，不使用厚重 SaaS 阴影。

首页绘本景深由连续场景、透明人物与草地留白承担；宽屏学段纸牌采用（1px）薄边与（3px）底边，不加阴影，班级节点仍保留既有轻环境阴影。窄屏主行动保持既有轻微触感与暖纸 dock；宽屏使用独立正面纸面工作区的环境阴影，内部主按钮没有边框或阴影。窄屏详情保留环境阴影，宽屏详情去除阴影，避免局部面板压过场景。具体阴影值记录在 `.impeccable/design.json`，只适用于首页，不增加全局卡片阴影。

### Named Rules

**The Quiet Surface Rule.** 大多数页面表面保持安静，只有当前主行动、待确认事项和正在查看的证据获得明显强调。

## Shapes

采用柔和、自然但克制的形状语言：中等圆角、轻边界、少量圆形头像和简单植物/放大镜/对话气泡图标。避免所有元素都变成胶囊，也避免卡片嵌套卡片。

常规页面的卡通插图使用简洁的平面形状、有限色彩和清晰轮廓；首页花园采用用户批准的绘画感场景。不使用真实幼儿照片作为演示素材，不使用复杂 3D 吉祥物或大量贴纸。

首页主行动窄屏使用胶囊、宽屏采用（12px）圆角矩形；宽屏展开学段仍使用胶囊；静止学段、人物节点与紧凑详情采用柔和、不完全对称的纸面形状，基础圆角见 `home-*` 元数据。地图连续铺展，不套入带圆角的 hero 卡片；这些形状只属于首页，不把其他页面都改成胶囊。

## Components

### Homepage garden map

- **Ground truth:** 全园 → 学段 → 启用的具体班级 → 成长档案／观察证据；数量、状态、链接完全来自既有 view model。背景与人物都是装饰；文字、徽章、按钮和数据完全为 DOM。
- **Artwork:** 宽屏与广幅背景使用 `map-desktop-v3.webp`、`map-wide-v3.webp`，局部移除透视书、大芽苗和树桩，保留绘本世界并形成草地留白；手机 `map-mobile-v2.webp` 与透明学段人物保持既有实物。旧 v2 资源保留，手机全园缩略图仍使用旧桌面画面；不再渲染 `map-school-sign-v2.png`，不把 UI 放进背景木牌或透视纸页。四张参考图只提供构图，画内不烘焙文字、统计或控件。
- **Controls:** 学段为带 `aria-expanded` 和精简 `aria-label` 的原生按钮，持续显示“查看班级／收起班级”操作标签；班级节点进入紧凑详情而不是旁挂一个大面板。选择后焦点进入详情，返回列表／Escape 后回到对应学段按钮；返回全园清除选择。学段色、文本和已展开／已选中状态共同表达位置。
- **Record:** 一个幼儿时直接记录；多个幼儿时使用原生 `details/summary` 展开带标签的 `select`，未选择前记录按钮禁用。宽屏选择框在紧凑局部面板中展开，窄屏沿自然流展开；空班级引导建立成长档案。
- **Status:** 首页使用完整明文“待确认”和既有紧凑流程状态，不以一个叶片替代关键状态；不重复“AI 生成”徽章。原始观察摘要仍是观察行主体；review 继续保留 AI 来源、仅草稿、原文不可改写与追溯关系。
- **Actions:** 两个区域都是独立 DOM 表面，背景绘画只提供环境。宽屏全园工具栏位于（top 2% / right 2.5%），宽度（clamp(320px, 28%, 380px)），最小高度（76px）且随内容自然增高；明确“查看全园班级／返回全园”与全园数量。宽屏工作区位于（bottom 7%），宽度（28.5%、最大 460px），内边距（20px），高度随内容自然增长；标题行使用既有（64px）观察册装饰图、毛笔标题（clamp(24px, 2vw, 30px)）和（14px / 1.6）辅助语，主次行动在纸面内部纵向完整排列。主按钮为（56px / 20px / 12px 圆角），无边框、无阴影；手机保留原暖纸 dock、胶囊主按钮与自然流全园摘要，数量仍为完整两行。
- **Focus:** 首页链接、按钮、选择框、summary 和焦点详情使用深绿轮廓（3px、偏移 4px）；核心目标至少（44px），中央按钮窄屏与宽屏至少（56px）。
- **Motion:** 场景／行动淡入、学段错峰轻移入、节点／详情局部移入及叶片轻转都只运行一次。hover 设备上的学段抬升（3px）、主行动抬升（2px），路径只过渡颜色与透明度；选中保留静态位置和文字。减少动态偏好关闭首页动画、过渡与悬停位移，不移除布局所需定位、选中反馈与焦点。

### Guide evidence chain（已批准开发口径，尚未实现）

- **Status:** 每个具体表现条目只呈现三种正式状态：**暂无相关记录、已有相关线索、已确认观察到**；“AI 关联待核对”是工作流提示，不得画成第四种状态或计入人数。
- **Scope:** 状态只对应具体年龄表现条目，不对应整个目标或领域；不得用“目标已达成”“领域完成度”等聚合表达。
- **Sources:** 每条正式状态都必须能展开到来源：观察日期、逐字片段、发生时班级；历史班级缺失时显示“未知”，不回填当前班级。
- **Class ratio:** 班级页允许“已确认观察到占比”，但必须同时显示分母（在班名单人数）与统计期间，并注明按观察日期与在班名单统计、不宣称教学成效。
- **Adult help:** 证据涉及成人帮助时如实标注，不静默呈现为独立表现。
- **Empty:** 无记录是正常状态，用“暂无相关记录”如实呈现，不使用催促或负面暗示文案。

## Do's and Don'ts

### Do:

- **Do** 让每个页面有一个明确主行动。
- **Do** 把原始观察、AI 草稿和教师确认稿区分清楚。
- **Do** 用时间线、证据行和成长故事表达连续性。
- **Do** 使用少量卡通插图帮助识别入口、空状态和小朋友档案。
- **Do** 在桌面端保持可扫读，在窄屏端保持单列和清晰焦点。
- **Do** 用“成长档案”“观察证据”“下一步支持”等发展性语言。
- **Do** 仅在首页使用批准的花园强主场景与确认优先主行动，保留 HTML 数据、地图内班级探索、键盘焦点、纵向窄屏和静态选中反馈。
- **Do** 在指南证据链中如实区分“AI 关联待核对”与三种正式状态，并让每个状态都能回到观察日期、逐字片段与发生班级。

### Don't:

- **Don't** 把页面做成企业 SaaS 控制台或数据驾驶舱。
- **Don't** 用雷达图、百分比、星级、排名或“覆盖领域 3/5”表达**幼儿个体**发展；班级层唯一例外是“已确认观察到占比”，且必须显示分母与统计期间，不表达优劣或教学成效。
- **Don't** 用大量卡通插画、彩虹色或游戏化徽章制造热闹感。
- **Don't** 用一层层卡片承载所有内容。
- **Don't** 让 AI 文案成为比教师观察事实更醒目的主角。
- **Don't** 使用“学生”作为全局对象名；按钮优先采用“建立成长档案”，正式语境保留“幼儿”。
- **Don't** 把首页局部色板、强场景或紧凑状态规则推广到其他页面；按用户最新要求，首页不显示“演示数据”“合成数据”“演示园所”，review 的来源与确认边界仍保留。
