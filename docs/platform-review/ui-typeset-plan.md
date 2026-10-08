# PLATFORM-UI-TYPESET1：盘点、证据与修正范围

初始基线：`f371ba3b2a39af6aaa660566ed5435bd316c05a7`；独立树 `D:/CodexWorktrees/platform-ui-typeset/child-growth-agent`，分支 `codex/platform-ui-typeset`。HEAD/分支吻合，初始 tracked/untracked 均干净。RTK.md 不存在，仅记录。依赖由本树 `pnpm install --offline --frozen-lockfile --ignore-scripts` 安装，无新依赖、跨盘 junction 或锁升级。

完整读取本树 AGENTS / PRODUCT / DESIGN、Impeccable SKILL 与 audit/typeset/polish/craft-floor。context 本会话仅一次，target `src/app`。DESIGN/sidecar 漂移及 buildPath 缺失仅记录，未修复。用户已指定既有视觉世界，不重新品牌设计。无可调用隔离子代理能力，采用本会话先独立视觉排版评估、后机械扫描的替代；未将扫描分数作为视觉结论。

2026-10-08 父代理通知：聊天 v2 来源树存在未提交工作，f371 不包含；用户已选择先固化整合，再同步两线。期间不写 yaya、globals、layout、home CSS；本轮不复制或操作来源树。只读了来源树 `docs/yaya-v1/chatbox-v2-delivery.md` 与 `docs/design/yaya-chatbox-v2/README.md / approval.json`。获批 A 默认聊天、C 宽屏批量方向仍成立，旧聊天截图不能成为 v2 验收。正常 merge 仅待父代理提供新版 SHA 后按明确授权执行，保留当前呈现改动。

## 首轮实际截图

`ui-typeset/before/results.json`：105 captures；13 检查全部通过；pageerror 0；自有资源清理问题 0；guard attempts 0，真实模型/搜索/桶/生产请求 0。正式 Next webpack 生产 HTTP + AUTH + 隔离 PostgreSQL + Chrome；数据来自已有 seed 模块，明确合成；没有真实幼儿数据。模型相关整理稿是 seed 的标注 fixture，无模型质量证明。

| 范围 | 已执行 | 边界 |
| --- | --- | --- |
| 教师：首页、班级列表/详情/概览、成长档案列表/建档/详情/证据册、观察列表/录入/Review、活动/回顾、assistant/侧栏 | 1440/1024/768/390 截图 | 聊天属于 f371 旧实现 |
| 管理员：首页、班级、成长档案、证据册、Review、assistant、教师管理 | 1440/390 截图 | 教学写权限未新增 |
| 未分配教师：首页/班级/成长档案/assistant | 1440/390，真实登录、API 403 | 403 不当空数据 |
| 未登录：首页/登录/成长档案/assistant | 1440/390，API 401 | 无私有投影 |
| partial/unreadable/empty | 真实隔离库故障夹具证据册 | 不是真实园所损坏记录 |
| 200%字号、长 CJK/罕见字/少量数字 | 768 视口四页 DOM 排版替身 | 明确不持久化、不改业务事实；字号放大不是浏览器工具栏缩放 |
| 字体 fallback、键盘/reduced-motion | 390 截图与焦点检查 | 仅 Windows/Chrome，非跨平台字体认证 |
| loading/503/unknown/特殊卡片、表单其他步骤/弹窗 | 后轮有限补充 | 不追加第三轮截图 |

## 编辑前角色映射（候选，不杜撰全站批准）

| 角色 | 呈现 | 用途与现有来源 |
| --- | --- | --- |
| 页面标题 | 1.5rem / 600–700 / 1.4 | 24px 来自现有成长档案/证据册；建档20px和班级30px统一 |
| 区块标题 | 1.125rem / 600 / 1.5 | 18px 来自两类证据册；不改变首页 display |
| 正文/原文/教师说明 | 1rem / 400 / 1.75，长文70ch上限 | 16px 来自证据册原文；14px长文升级 |
| 标签/元数据/状态 | .875rem / 400–600 / 1.5 | 14px保留角色差异；关键说明不降12px |
| 数字 | tabular-nums，大小跟随角色 | 数字对齐，UNKNOWN不转0 |
| 字体 | 业务页现有系统中文无衬线；首页与证据页保留现有字体栈 | 不新增家族/字体请求，不扩展home子集为全站字体 |

业务排版使用页面明确标记的 `data-platform-surface` 范围；首页、证据册自有 CSS、聊天方向不自动套同一布局。保留原文、确认边界、错误/未知/授权解释。角色映射交主评审，不写入全局 DESIGN/sidecar 为获批标准。

## 有证据的问题矩阵

| 编号/级别 | 位置与证据 | 影响 | 修正归属 |
| --- | --- | --- | --- |
| U1 / P1 | before：children 5个、child-new 8个、observation-new 3个、Review 7个小目标；input/button为36px，筛选38px | 指尖命中困难，字体放大后控件受限 | 本轮共享shadcn呈现层，44px；radio用整段关联label命中区 |
| U2 / P1 | `stress-classes-200percent.png`，document overflow=true；classes桌面统计shrink-0且无中间重排 | 放大字体时横滚 | 班级行统计换行，1024以上才展示完整侧列 |
| U3 / P1 | `admin-home-390.png` overflow=true | 管理员手机首页横滚 | 等新基线，限home局部修正 |
| U4 / P2 | computed style：建档标题20、成长档案24、班级30；多数正文14/元数据12 | 跨页阅读层级不稳，长文费眼 | typeset角色及阅读行距 |
| U5 / P1 | 建档步骤白字/amber500、未来步骤slate400；正文末尾slate400 | 小字对比不足 | 已知局部文字颜色，后轮实测比值 |
| U6 / P2 | Review主标题为div，管理员只读仅数段p | 标题导航弱、回到列表不直观 | 语义h1＋只读返回入口；不改读取/写权限 |
| B1 / P1，交业务owner | `src/app/classes/[id]/page.tsx:123` catch只设dbError，`:205/210/215/220`仍呈现初始空值 | 读取失败可能被说成0或无记录 | 已向父代理报告；源码推断，尚未注入复现，本轮不改逻辑 |
| D1 / P3 | context：design-sidecar-stale / config-build-path-unset | 旧sidecar不可作全站token权威 | 记录，不由审计副作用修复 |

技术审计初评：A11y 2/4（目标/对比），性能3/4（自托管字体/无新增库，未测生产性能），Responsive2/4（两例溢出），Theming3/4（既有token与局部色并存），Integrity3/4（既有产品身份成立，角色字号漂移）。总13/20，限定本轮证据。机械扫描待最终改动后一次运行，独立报告；不force-ignore advisory。

## 实施顺序与验收

audit截图/问题矩阵 → typeset共享控件与业务角色 → polish一次同视口复核。保留个人V4单列、班级第三稿工作台、首页获批插画与现有容器关系；不做PPT页面。最终仅按精确文件清单stage并本地提交，不push/deploy；当前与新基线历史均记录。NOT_RUN必须与失败/未知分开。
