---
name: "芽芽观察"
description: "轻量、温和、证据导向的幼儿园教师成长观察应用"
colors:
  home-green: "#008344"
  home-green-hover: "#006c37"
  home-ink: "#0a1d54"
  home-row-ink: "#15264d"
  home-muted: "#617291"
  home-nav-muted: "#4f6079"
  home-ground: "#fefdf9"
  home-surface: "#ffffff"
  home-action-cream: "#fffbf0"
  home-line: "#e5e3da"
  home-field-line: "#d7dbe4"
  home-focus: "#006840"
  home-confirm: "#b23912"
  home-supplement: "#0065bc"
  home-pending-muted: "#526480"
  home-nav-active: "#e5f8ee"
  home-status-ground: "#e1f9eb"
  home-status-ink: "#006d42"
typography:
  home-heading:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "clamp(32px, 3.15vw, 48px)"
    fontWeight: 750
    lineHeight: 1.28
    letterSpacing: "-0.025em"
  home-heading-mobile:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "26px"
    fontWeight: 750
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  home-guest-heading:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "clamp(42px, 4.7vw, 72px)"
    fontWeight: 750
    lineHeight: 1.26
    letterSpacing: "-0.035em"
  home-section:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "29px"
    fontWeight: 720
    lineHeight: 1.4
  home-body:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "16px"
    lineHeight: 1.7
  home-pending:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "16px"
  home-pending-mobile:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
  home-navigation:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "17px"
  home-navigation-mobile:
    fontFamily: "'Home Noto Sans SC', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
rounded:
  home-control: "12px"
  home-panel: "16px"
  home-action-mobile: "14px"
  home-chip: "999px"
spacing:
  home-gap: "18px"
  home-mobile-inset: "16px"
  home-panel-inset: "32px"
  home-section-gap: "34px"
components:
  home-button-primary:
    backgroundColor: "{colors.home-green}"
    textColor: "{colors.home-surface}"
    rounded: "{rounded.home-control}"
    padding: "14px 26px"
  home-button-primary-hover:
    backgroundColor: "{colors.home-green-hover}"
  home-button-secondary:
    backgroundColor: "{colors.home-surface}"
    textColor: "#00753d"
    rounded: "{rounded.home-control}"
    padding: "14px 26px"
  home-login-field:
    backgroundColor: "{colors.home-surface}"
    rounded: "{rounded.home-control}"
    padding: "12px 18px"
    height: "58px"
  home-login-panel:
    backgroundColor: "{colors.home-surface}"
    rounded: "{rounded.home-panel}"
    padding: "40px 44px 44px"
  home-action-strip:
    backgroundColor: "{colors.home-action-cream}"
    textColor: "{colors.home-ink}"
    rounded: "{rounded.home-panel}"
    padding: "19px 32px"
  home-navigation-active:
    backgroundColor: "{colors.home-nav-active}"
    textColor: "#006b49"
    rounded: "{rounded.home-control}"
    padding: "10px 14px"
  home-observation-status:
    backgroundColor: "{colors.home-status-ground}"
    textColor: "{colors.home-status-ink}"
    rounded: "{rounded.home-chip}"
    padding: "5px 11px"
  home-class-row:
    backgroundColor: "{colors.home-surface}"
    textColor: "{colors.home-row-ink}"
    padding: "10px 18px 10px 44px"
---

<!-- Non-homepage guidance is preserved, including its unresolved tokens. The home-* frontmatter records only the approved home-v2 workbench candidate; it does not replace globals.css or certify post-fix browser acceptance. -->

# Design System: 芽芽观察

## Overview

**Creative North Star: “轻量成长观察册”**

芽芽观察是一款面向幼儿园教师的轻量成长观察应用。它的视觉不应像企业 SaaS 控制台，也不应像儿童游戏，而应像一本清爽、可持续阅读的数字观察册：教师可以快速开始记录，回到最近的成长片段，查看待确认内容，并沿着时间线理解一个小朋友的变化。

卡通元素通常只承担情绪和识别作用，不承担信息结构。插图应小、简单、克制，服务于空状态、入口、头像和少量情境提示；主要信息仍由清晰的文字、时间线和证据关系表达。

首页已按 2026-10-04 用户批准的四张角色／设备原图改为安静的专业工作台：暖白底、海军蓝中文无衬线、叶绿行动、细分隔线与独立的小幅绘本插画。教师围绕确认与任教班级工作，访客登录，管理员管理全园；文字、数量、状态与操作保持 HTML。此首页方向替换旧花园地图，不改变其他页面的“轻量成长观察册”方向；构图与证据状态见 `.impeccable/surfaces/src-components-home-v2-homepage-tsx.md`。

**Key Characteristics:**

- 轻量应用，不做后台控制台
- 温暖但不幼稚，专业但不冷漠
- 常规页面使用少量平面卡通插图；首页使用独立小幅绘本插画，避免装饰泛滥
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

**The Small Illustration Rule.** 常规页面的卡通插图只占据局部空间；首页插画保持完整、独立并为操作留出净空，事实和控件必须保留为 HTML。

**The No-Score Color Rule.** 颜色不得表示幼儿发展高低、等级、排名或领域完成度。

### Homepage-only palette

前置元数据的 `home-*` 只适用于 `home-v2` 工作台，取自 `src/components/home-v2/homepage.module.css` 与 `home-fonts.css`。叶绿用于纯色主行动，海军蓝用于标题与主体；源码还保留独立的行／导航墨色与辅助灰蓝。暖白为首页底，白色为班级行与登录面板，奶油色为行动条，暖灰为细分隔。待确认红褐、待补充蓝、待整理灰蓝均是工作流提示，不表示儿童能力。管理员的珊瑚／金赭／蓝学段标签仅识别小／中／大班。

**The Homepage Ground Scope Rule.** 首页暖白仅由 `body:has([data-home-state])` 施加；其他路由继续使用 `bg-background` 与全局 OKLCH 主题。共用 TopNav 当前引用首页样式，是已存在的实现关联，不授权把首页色板推广到其他内容页。


## Typography

**Display Font:** 亲和、清晰的中文无衬线字体（to be resolved during implementation）

**Body Font:** 与标题同一字体家族或协调的中文无衬线字体（to be resolved during implementation）

**Character:** 常规页面的字体应像一位清晰、温和、可靠的教师：有亲和力，但不使用过度圆润、玩具化或手写化的字体。首页同样使用清晰的中文无衬线；正文仍优先保证中文长文本阅读和窄屏可读性。

### Hierarchy

- **Display:** 只用于首页问候和极少量核心入口，避免大标题占满首屏。
- **Headline:** 用于页面标题和成长故事标题，保持清晰而有温度。
- **Title:** 用于观察证据、待确认、成长档案等主要区块。
- **Body:** 用于观察事实、教师说明和支持建议，保持舒适行宽。
- **Label:** 用于状态、日期、领域和辅助信息，短而明确，不使用全大写或装饰性字距。

### Homepage-only hierarchy

首页与共用 TopNav 当前使用自托管可变 Noto Sans SC（CSS 名称 `Home Noto Sans SC`，字重 100–900，`font-display: swap`）；实际栈见前置元数据。主问候为 `home-heading`，手机为 `home-heading-mobile`；访客主标题为 `home-guest-heading`，手机按（clamp(33px, 8.5vw, 42px) / 1.3）重排。行动标题桌面为（25px / 700 / 1.3），待确认数字为（38px）；38px 是数字强调，不能写成通用主标题。区块标题桌面为 `home-section`，手机为（23px / 1.4）；班级名为（21px / 700），手机（17px）。

待办列桌面为 `home-pending`，手机为 `home-pending-mobile`；导航桌面为 `home-navigation`（1390px 以下为 16px），手机为 `home-navigation-mobile`。这些 14px 手机规则指待办状态与导航，不把源码中现有的 12px 归档徽章／角色徽章推广成关键状态的设计标准。

字体来源与复现依据为 `public/assets/fonts/home-v2/source.json`：Google Fonts v41、OFL 1.1，许可文件 `OFL-NotoSansSC.txt`；`noto-sans-sc-ui.woff2` 实测（107,664 bytes、414 glyphs），SHA256 为 `6ded052d2ac148fd8405f4625054cc523cd158c62a74e8b7b008ff8bc75c9646`。覆盖上限是这批固定 UI 与批准示例字形，不包含完整 CJK 或任意业务姓名；稀有字依赖后备字体，跨系统的实际回退与换行尚未验证。生成命令为 `pnpm exec node scripts/fetch-home-font.mjs`，从四个 UI 源文件与固定示例集合收集字形，生成阶段请求公开字体服务，运行时不请求第三方字体。改静态文案后须重新生成并更新 source.json 的字形数、字节数和哈希；脚本不自动维护该元数据，也没有实现文件大小硬上限。本次不执行生成。

**The Homepage Readable Type Rule.** 使用清晰的中文无衬线层级；手机待办与导航保留 14px，不以压缩关键文字换取首屏容量。字体子集缺少的业务字符必须回退，不把示例字形集合当成真实名册。


## Layout

页面采用轻量叙事布局，而非复杂管理后台：

- 顶部使用简洁导航，不使用固定的企业级侧边栏。
- 首页围绕一个依当前记录状态决定的主行动，辅以“待确认观察”和“最近观察”；有待确认时优先确认，记录入口仍可到达。
- 观察记录以时间线和轻量行项目展示，避免每条记录都被包裹成厚重卡片。
- 成长档案以单个小朋友为中心，先展示最近变化和观察证据，再提供领域透镜。
- review 页面桌面端可使用原文与 AI 草稿并列；窄屏端按“原文 → 草稿 → 确认”顺序单列展开。
- 页面保留充足留白，但不制造大面积无意义空白；每个区块都应服务于记录、确认或回顾。
- 窄屏优先单列重排，不依赖横向滚动承载核心信息。

**The Homepage Confirmation-First Rule.** 教师主行动按服务端当前可操作范围依次选择待确认、待补充、待整理，再判断建立成长档案或开始记录；优先项未知时提供重新读取，未分配班级时联系管理员。管理员使用管理班级／管理教师，不显示教学确认行动。

**The Homepage Workbench Row Rule.** 学段分组承载真实的多个班级，班级行与最近观察使用可扫读的列和细分隔线；桌面待确认／待补充／待整理应保持各自位置，不能让缺项造成类别串列。稳定列是批准的可读性要求；最新本地浏览器证据与 reviewer verdict 1 已将前五项视觉修复（包含列／分隔线问题）判为 RESOLVED，此结论不等于自动 gate 通过或全部业务认证。

首页内容与导航容器最大（1356px），复用根布局最大（1536px）的外层留白。桌面教师欢迎区为文字与插画两列，随后是单行动条、学段班级行和最多两条最近观察；管理员欢迎区右侧为两个管理入口，后接全园班级。访客桌面采用（minmax(0, 1.3fr) / minmax(360px, 0.95fr)）两列、（78px）间距：品牌和完整插画／独立账号登录，后接五步机制。具体角色构图只适用于该首页，见 surface brief。

源码在（1390px）以下收紧间距，在（1090px）以下导航换到第二行并让行动条换行，在（767px）以下切换手机自然流：问候与范围 → 行动条 → 小／中／大班分组 → 最近观察。手机隐藏教师大插画和学年，不隐藏五个有权限的导航入口；访客手机把登录置于插画之前。核心触控目标至少（44px），手机行动条主按钮至少（44px）、导航至少（56px）；桌面主按钮至少（62px）。最新（390×844）本地 DOM 记录显示第三条任教班级行底部为（804.5px < 844px），无横向溢出，核心目标达到至少（43.9px）的测量容差；该视口要求已获本地视觉复核，不代表整个 responsive phase 已关闭。

桌面教师插画容器与图片高度均为（190px），图片使用 `object-fit: contain`，宽（370px）；欢迎区最小高度（176px），容器上移（40px），未受内容增高时几何净空约（26px）。批准净空至少（24px，目标 24–32px）；最新 DOM 实测图片到行动条净空为（25.999px），完整人物／手／观察册已在新教师截图中复核。该测量只证明当前本地状态，任意长姓名、稀有字与更多设备组合不在这次结论中。不得用负间距或裁图掩盖遮挡。


## Elevation & Depth

默认使用平面和色调层级表达空间关系。边界优先使用暖灰线、浅色表面和间距；阴影只用于弹出层、抽屉和需要被暂时聚焦的主要操作，不使用厚重 SaaS 阴影。

首页工作台以暖白、白色行、奶油行动条和细线分层；主按钮、次按钮和登录输入均明确无阴影。登录面板与行动条使用薄边，插画自身保留绘画细节，不再承接旧地图纸牌、浮层或硬投影。sidecar 只记录当前无阴影与控件状态过渡，不延续旧花园动画。

### Named Rules

**The Quiet Surface Rule.** 大多数页面表面保持安静，只有当前主行动、待确认事项和正在查看的证据获得明显强调。

## Shapes

采用柔和、自然但克制的形状语言：中等圆角、轻边界、少量圆形头像和简单植物/放大镜/对话气泡图标。避免所有元素都变成胶囊，也避免卡片嵌套卡片。

常规页面的卡通插图使用简洁的平面形状、有限色彩和清晰轮廓；首页采用用户批准的小幅独立绘本插画。不使用真实幼儿照片作为演示素材，不使用复杂 3D 吉祥物或大量贴纸。

首页按钮与输入采用 `home-control`，登录面板与桌面行动条采用 `home-panel`；手机行动条采用 `home-action-mobile`，班级行仅手机有控制级圆角。胶囊只用于身份、学段和归档状态，访客三年路径使用圆形节点；这些形状只属于首页，不把其他页面改成同一组件外观。

## Components

### Homepage workbench（批准风格，候选实现）

- **Authority / status:** 四张原生 ImageGen 图于 2026-10-04 获用户批准，分别为 `docs/design/home-refinement-20261004/01-guest-desktop.png`、`02-teacher-desktop.png`、`03-admin-desktop.png`、`04-teacher-mobile.png`；它们是同一方案的角色／设备状态。前三张（1536×1024），手机（853×1844）对应逻辑目标（390×844）。批准图是风格依据，图内数据是合成设计示例，不能作为浏览器或真实名册证据。精确 native source、提示词与哈希见相邻 `*.meta.json` 和 `PROMPTS.md`；本次实测四张哈希均与各自 meta 一致。
- **Implementation truth:** 当前分支 `codex/home-v2-craft` 的本地预览已在用户请求的原始七项修复范围完成。初始 finish review 为 FIX，verdict 1 解决前五项视觉问题；**reviewer verdict 2 已确认第 6 项证据／持久化关联和第 7 项文档同步 RESOLVED，合计 7／7 RESOLVED，disposition = SHIP，严格限定 ORIGINAL SEVEN FIXES ONLY**。无新增用户决策或视觉修复批次要求。验证记录通过 `.impeccable/build/state.json.currentEvidence` 的新截图／report 关联、`docs/design/home-refinement-20261004/gate-adjudication.md` 的差异裁定，以及 `design-qa.md` 的最新 final result: passed（手动比较／已检查范围）闭合；最新 verdict 2 以用户交接与 design-qa 为准，范围外 buildstate／adjudication 中保留的 verdict 1 状态文字属于历史口径，本次不改写它们。**AUTOMATED HERO GATE = FAIL（85.16%，ok:false，未 force）；hero 仍 open，sections／motion／responsive／review 仍 pending，finish 为空；自动 comp-led pipeline 未完成。此 scoped SHIP 不等于全应用、认证／安全、生产或自动流水线认证；本地交付不含 push／deploy。**
- **Ground truth:** 真实账号／会话与服务端授权 SQL 决定角色和范围，无角色切换器。主任务的自有隔离本地合成名册读证据为管理员 6 班／94 名幼儿，教师仅任教 3 班／54 名幼儿；不是托管库或真实园所证明，也不是显示常量。访客与身份不可用不返回私有首页资料；未读取的数量保持 null／未知，不能写成 0；教师无任教班级时联系管理员。 最新主任务本地验证记录为 HTTP 20/20（含 10 个并行实际管理员页面渲染）、DirectAuth 107 与 pure 33＋40＋28 等检查，PG idle transaction 为 0；自有预览重启与清理已核验。本次只核对并同步这些已有本地结果，不重跑测试，不将它们当作部署认证。
- **Artwork / provenance:** `public/assets/illustrations/home-v2-guest.png`（1774×887）和 `home-v2-teacher.png`（1635×962）为独立透明原生 PNG，分别派生自批准访客／教师桌面图。两张 PNG 均实测带有 `tEXt` 键 `impeccable:prompt`；相邻 `.png.json` 记录工具 `image_gen.imagegen`、确切参考路径、`guest-asset-prompt.txt`／`teacher-asset-prompt.txt`、透明背景与仅插画用途；模型标识未知，不能补造。HTML 不烘焙到插图中，不把批准图里被行动条截断的人物当成可继承的裁切规则。
- **Controls:** 复用 shadcn/ui Button、Input、DropdownMenu 与 Lucide 图标。访客账号／密码字段有明文标签、自动填充、显示密码与提交中状态；密码不归一化，无公开注册。教师行动条按当前可操作待办选择一个主按钮，待补充／待整理与记录入口分开；班级整行为链接，最近观察进入个人证据册。管理员首页只有管理班级、管理教师与班级证据入口，没有教学待办或确认按钮。
- **Current local evidence:** `.impeccable/review/verdict-guest.png`、`verdict-teacher.png`、`verdict-admin.png`、`verdict-mobile.png` 与 `verdict-mobile-full.png` 为新修复后证据；四组比较在 `.impeccable/review/diff/verdict-{guest,teacher,admin,mobile}/`，各含 report／side-by-side，教师含 19 对区域。已记录 DOM：`Home Noto Sans SC` 加载完成，首页底为 `rgb(254,253,249)`、插画净空 25.999px、手机第三行底部 804.5px、无溢出、核心目标 >=43.9px。旧 final/current 截图继续是历史修复前证据；本次文档读取新截图与 adjudication，不另开浏览器验收。
- **Browser recovery:** 先前复验阻断已解除；根因是新教师管理页嵌套 scoped query 在预取／并发时耗尽应用连接池。既有管理员 guard 下改为单 client 读取，未弱化认证或范围保护；最新源保留 `withBusinessRead(..., "teacher.manage", { kind: "school" }, ...)`。修复与预览重启由主任务完成，不属于本次文档写入。
- **Gate difference / authority:** 四张批准原图仍是视觉权威；实际角色／范围数据、班级排序、DTO 无头像时使用 UserRound，以及为净空缩小独立插画，属于已允许的实际适配，不降级原图权威。详见 `docs/design/home-refinement-20261004/gate-adjudication.md`：slogan 的 CJK 区域 detail 0%／structure 87% 不能推导文字缺失，新图与 AX 文本证实存在；完整 teacher-art 满足约 26px 净空，但原始 drift 保留；record-link 可见、可读且通向真实记录页，原始约 61% drift 保留。独立视觉复核与 DOM 证据分别支持这三项裁定，不把数值差异改写成 gate PASS。
- **Status / evidence:** 首页待确认、待补充、待整理与已确认归档属于观察工作流；指南正式状态仍只有“暂无相关记录、已有相关线索、已确认观察到”。✓ 只表示教师确认的观察证据，不表示测评通过、掌握或达标；“AI 关联待核对”仍不是第四种状态。原始观察 `raw_text` 不改写，AI 仅为草稿，正式记录和证据保持教师确认边界。
- **Focus / motion:** 首页与 TopNav 的 `:focus-visible` 使用 `home-focus`（3px、偏移 4px）；核心操作至少（44px）。主按钮只过渡背景和文字颜色（150ms ease-out），减少动态偏好关闭首页及导航的动画／过渡／平滑滚动；不继承旧花园场景入场、浮动节点或悬停抬升。
- **Not canonized:** 既有非首页文档仍含未解析的色彩／字体与旧“尚未实现”时间口径，但源码已有全局 OKLCH／系统中文栈；按本次范围保留原文并记录漂移，不补造全站 token。首页 12px 手机归档／角色徽章不推广为关键状态的通用标准；原始七项全部 RESOLVED 的 scoped SHIP 不升级为全应用、认证／安全或生产结论。证据关联与文档同步已获 verdict 2 确认，无原始七项待复核；raw HERO FAIL 与未完成阶段保留。除三个授权文档外不修改源码、API、资源、配置、buildstate、design-qa 或其他契约。

### Guide evidence chain（已批准开发口径，尚未实现）

- **Status:** 每个具体表现条目只呈现三种正式状态：**暂无相关记录、已有相关线索、已确认观察到**；“AI 关联待核对”是工作流提示，不得画成第四种状态或计入人数。
- **Scope:** 状态只对应具体年龄表现条目，不对应整个目标或领域；不得用“目标已达成”“领域完成度”等聚合表达。
- **Sources:** 每条正式状态都必须能展开到来源：观察日期、逐字片段、发生时班级；历史班级缺失时显示“未知”，不回填当前班级。
- **Class ratio:** 班级页允许“已确认观察到占比”，但必须同时显示分母（在班名单人数）与统计期间，并注明按观察日期与在班名单统计、不宣称教学成效。
- **Adult help:** 证据涉及成人帮助时如实标注帮助方式；条目允许成人帮助时仍可呈现“已确认观察到”，仅要求独立完成的条目才降为线索。
- **Stages:** 界面上不得混用“当前班级阶段”“指南参考年龄段”“证据发生时阶段”；历史回看不因当前升班而排除，历史班级未知时显示“未知”。
- **Reliability:** 统计不可靠时显示“统计不可用/部分记录无法读取”并保留名单分母，不显示正常的 0% 或占比；技术异常不得画成第四种状态或能力等级。
- **Manual:** 手动关联与 AI 建议在展示上同等正式，来源可核对；AI 建议失败只作工作流提示，不阻塞教师补关联。
- **Empty:** 无记录是正常状态，用“暂无相关记录”如实呈现，不使用催促或负面暗示文案。

## Do's and Don'ts

### Do:

- **Do** 让每个页面有一个明确主行动。
- **Do** 把原始观察、AI 草稿和教师确认稿区分清楚。
- **Do** 用时间线、证据行和成长故事表达连续性。
- **Do** 使用少量卡通插图帮助识别入口、空状态和小朋友档案。
- **Do** 在桌面端保持可扫读，在窄屏端保持单列和清晰焦点。
- **Do** 用“成长档案”“观察证据”“下一步支持”等发展性语言。
- **Do** 仅在首页使用批准的工作台、确认优先主行动和独立完整插画，保留 HTML 数据、真实学段班级分组、键盘焦点与窄屏自然流。
- **Do** 在指南证据链中如实区分“AI 关联待核对”与三种正式状态，并让每个状态都能回到观察日期、逐字片段与发生班级。

### Don't:

- **Don't** 把页面做成企业 SaaS 控制台或数据驾驶舱。
- **Don't** 用雷达图、百分比、星级、排名或“覆盖领域 3/5”表达**幼儿个体**发展；班级层唯一例外是“已确认观察到占比”，且必须显示分母与统计期间，不表达优劣或教学成效。
- **Don't** 用大量卡通插画、彩虹色或游戏化徽章制造热闹感。
- **Don't** 用一层层卡片承载所有内容。
- **Don't** 让 AI 文案成为比教师观察事实更醒目的主角。
- **Don't** 使用“学生”作为全局对象名；按钮优先采用“建立成长档案”，正式语境保留“幼儿”。
- **Don't** 把首页局部色板、字体子集或工作台构图推广到其他页面；按用户最新要求，首页不显示“演示数据”“合成数据”“演示园所”，review 的来源与确认边界仍保留。
