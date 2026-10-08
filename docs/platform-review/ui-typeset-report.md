# PLATFORM-UI-TYPESET1 本地候选交付

状态：**IMPLEMENTED_REVIEW_REQUIRED / NOT_READY_FOR_MERGE**。已实施排版和必要易用性修正；两轮预算内发现的残余问题明确交审，不能称“全站无覆盖”或 WCAG AA / 生产安全通过。

## 身份与改动

- 初始基线 `f371ba3b2a39af6aaa660566ed5435bd316c05a7`，首轮证据与术语/设计漂移保留原历史。
- 非交集 checkpoint `6b3bbc03b477d7c185d1d95740dbb6e75d8f2eac`；正常 --no-ff 合入 d1b441 后为 `3f054af541da007aa67f69eb0f7e5431624debb3`，无冲突。
- 排版 checkpoint `30005ed5df08770986d1ffa06e26cf57c1cb7232`；正常 --no-ff 合入正式共同基线 `ccf5998c20a4e8de6671f3938ec86a14f3ed545e` 后为 `76abf88a15da7e21c81a3119537ccb345b7fd832`，无冲突。已读 base-delivery 与最新 owner。
- 产品改动36个文件：11个业务页面/客户端 + globals；教师管理、活动支持、班级弹窗、草稿/成长小结/读取失败呈现；11个共享shadcn组件；3份局部CSS；聊天markdown/message/panel/workspace的排版或语义。`ui-typeset-files.json` 分列149个候选路径及126个本地证据路径；第二轮125张截图与详细结果留本地，不增加入库。首轮105张已在先前获准checkpoint中，保留历史。
- 输入与正文16px；页面标题24px、区块18px、元数据14px；长文70ch，数字等宽；共享按钮/输入/选项/关闭动作44px，长选项换行。Review补h1与只读返回入口，建档radio关联label扩大命中区，步骤色与错误文本更可读，普通卡片保留边界并去掉重复阴影。
- 个人V4与班级工作台结构不改，聊天沿新v2，不重复实现。局部数据属性控制排版范围；homepage只修管理员手机行动换行。未换字体/资产，未加依赖/第二状态库，未写DESIGN/sidecar/config。
- 相对ccf599，`src/lib`、`src/app/api`、`src/storage`、`src/components/yaya/client/**`、package/lock、harness diff为空；harness blob仍 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。页面中的查询、状态计算、handler、教师批准/执行语义未修改。main及来源树未写，未reset/cherry-pick/push/deploy。

## 验收矩阵

| 页面/状态 | 证据与覆盖 | 限制 |
| --- | --- | --- |
| 教师：首页、班级列表/详情/概览、成长档案列表/建档/详情/证据册、观察列表/录入/Review、活动、回顾、assistant/侧栏 | 正式Next HTTP + AUTH + 隔离PG合成种子；1440×900、1024×900、768×1024、390×844；前后同视口 | 新旧聊天代码身份不同，不以f371旧图证明本轮独自完成v2 |
| 管理员：首页、班级、档案、证据册、Review、教师管理 | 1440/390；真实登录；添加教师/重置密码/新班级弹窗追加390 | 弹窗只查看，没有提交管理业务 |
| 未分配/未登录 | 1440/390；真实账号/未登录；真实API403/401 | 拒绝不当空数据 |
| partial/unreadable/empty证据册 | 隔离种子正式HTTP/DB夹具 | 是明确故障/空样本，不是真实园所异常 |
| 建档三步 | 正式页面填写合成排版输入、查看可选补充与确认 | 不提交建档，不新增幼儿 |
| loading/empty/401/403/503目录 | 明确标注的浏览器响应fixture；loading为受控延迟 | 首次加载态场景装置退出1，错误文本未完整持久化；77张保留，资源清理通过；只补剩余场景，无重复截图/产品再改 |
| 503身份服务 | 真实登录后，在核验归属的自有隔离库暂改身份表名，真实服务返回503；1440/390 | 受控隔离DB故障，非托管库/真实基础设施故障；整个资源随后精准teardown |
| 聊天长答/提案/未知回执 | 明确标注响应fixture；1440/390；6项render检查 | 没有真实模型或业务POST。提案fixture显示“内容格式无法核对”，只证明拒绝/待核对呈现，不冒充合法可执行提案或批准链路 |
| 长CJK/罕见字/少量数字、200%字号 | 四个页面DOM排版替身；字号放大；班级原横滚已关闭 | 不持久化，非真实记录；成长档案“查看班级”目标宽28px仍开放 |
| 200%CSS zoom | 1440/390；真实Chrome的CSS布局替身 | 1440样本有横滚。CSS zoom不等价浏览器工具栏缩放，不能推导原生200%通过/失败 |
| 字体fallback、键盘/reduced-motion | 390回退测试；CDP实测Microsoft YaHei；长标题35 glyph，回退首页标题16 glyph；Tab可见焦点，四视口Escape恢复入口焦点 | Windows/Chrome；不是跨系统字体、全键盘旅程或真机软键盘认证 |

首轮：105张、13项检查全通过、pageerror 0、cleanup issues 0。第二轮：125张、21项检查全通过、pageerror 0、cleanup issues 0；**21项是脚本的明确功能检查，不意味着全部几何/对比指标通过**。第二轮核心业务控件小目标已清零；旧77张的1×1 INPUT为`yaya-attachment.tsx:48`的sr-only文件输入，真实选择图片动作44px。文内“可靠来源”链接为inline例外，不按独立按钮解释。模态弹窗盖住背景操作是预期焦点保护，不算助手遮挡。

## 修复前后与保留项

| 问题 | 结果/证据 |
| --- | --- |
| 档案筛选38px、输入/按钮36px、建档radio小目标 | 已修；before/after的children、child-new、Review同视口图及computed metrics；radio按关联label命中区核对 |
| 班级列表200%字号横滚 | 已修；`before/stress-classes-200percent.png` → `after/stress-classes-200percent.png`，overflow true → false |
| 管理员390横滚 | 已修；`before/admin-home-390.png` → `after/admin-home-390.png`，两行动纵向，overflow true → false |
| 跨页20/24/30标题、14正文、12元数据、厚重卡片阴影 | 本轮统一普通页面角色并保留局部获批构图；正文16/行距28、元数据14；无新字体 |
| E1 / P1：访客学段节点小字对比 | **开放**；`homepage.module.css:557`，`guest-home-390.png` 的小/中/大班采样3.76:1，16px/650应≥4.5。不能因detector primary0判为通过 |
| E2 / P2：闭合助手入口盖住次要链接 | **开放**；`yaya-entry.tsx:34` fixed；class1024“查看全部7条”、home768“全部观察”中心命中受入口阻挡；Review390亦局部相交。展开后的v2并排行为成立，不掩盖闭合入口问题 |
| E3 / P1：200%字号窄触控目标 | **开放**；`children/[id]/page.tsx:285`，`stress-child-200percent.png`，“查看班级”28×160px；普通宽度已达到44px，不扩写成所有字号通过 |
| E4 / P2：CSS zoom实验横滚 | **待原生缩放核对**；`classes-css-zoom200-1440.png` overflow=true；不可把字号测试通过扩成原生200%缩放通过 |
| B1 / 潜在P1：读取失败仍显示0/无记录 | **交业务owner，未修改**；`classes/[id]/page.tsx:123` catch设dbError，`:205/210/215/220`仍使用初始空值。仅源码路径证据，未注入此特定分支；业务线4be03129的组合效果留主代理核对，不能列作本轮确定运行失败 |

遵循用户“一批修正＋最多一次同视口复核”的上限，这些最终发现不再开启第三轮产品微调或循环重建；交主评审限定处理范围。未将必要事实、未知、授权/批准解释删掉来改善指标。

## 静态、扫描、视觉的区别

- TypeScript、lint:build、lint:style、git diff --check通过。首次样式lint重复选择器已合并，最终通过，不掩盖失败历史。
- Next生产Webpack构建通过；UI源码在正式tip合并前后相同，tip仅交接文档与专属旧装置兼容改动。自定义server/tsup由父代理共同基线已验证，本轮未单独重跑。
- 页引用纯检查42/42、消息组件静态render15/15通过；不算浏览器/真实模型证据。新增source check核本轮范围与冻结边界。
- Impeccable context仅1次，target src/app。扫描首次工具回传截断JSON；样式修正后完整保存，共2次执行，无循环。最终**0 primary /149 advisory**：颜色44、字号65、圆角40，均在四份CSS中。全量JSON见`ui-typeset-detector.json`。home-only DESIGN/sidecar对普通界面的已知未登记项与本轮局部角色映射解释了这些advisory；未force-ignore、未反向改DESIGN。
- 技术审计：A11y2、性能3、Responsive3、Theming3、Integrity3，总**14/20**；实现身份与既有视觉世界一致，但E1/E3等未关闭，整体不能SHIP。性能评分只基于无新增库/资源、静态结构与本地渲染，不是生产性能测试。
- 视觉评估独立查看了首轮/终轮的档案、Review、建档、班级、证据册、管理员/访客手机、特殊卡片、长CJK图。没有可调用隔离子代理工具，按技能许可在本会话完成分开的评估，没有冒充fresh独立reviewer。

## 资源与NOT_RUN

`before/results.json`及`after/results.json`登记seed_id、完整container_id、PID+创建身份与清理结果；后者保留中断那次77张的资源身份。三个自有资源run均cleanup verified；PG/对象/临时自生账号目录由既有seed.teardown精准移除，Next树由冻结harness核PID+时间结束，guard关闭。保留node_modules/.next缓存供复查；未删除main、源树、生产资料、他方进程/容器。未读.env或既有凭证；程序仅使用隔离seed本轮生成的临时合成登录资料，不输出密码/连接串。

| 自有run | 容器ID / 标签seed_id | Next PID / UTC创建身份 | 结果 |
| --- | --- | --- | --- |
| before | `9adcda0b2a0c01813465e506ae41650976f7bce4cfa6002852927f94aa499a2b` / `qaseed1-muzk1w3y-39845aed` | 108780 / `2026-10-08T13:11:22.6248220Z` | 精确清理通过 |
| after前77张 | `e3e00c37dae9c82f1efbfe1f4feeb289bc0e46f71c33355a4d332be2679b251d` / `qaseed1-muzljix3-8d961a39` | 23908 / `2026-10-08T13:53:04.8681920Z` | 中断后精确清理通过 |
| after补未完成场景 | `b2a93f12242492a62502053b83eb8da3f570ae7f91e0e035200df5ae8725d744` / `qaseed1-muzlsqc3-095ee364` | 8280 / `2026-10-08T14:00:14.4373790Z` | 精确清理通过 |

第二轮本地证据绝对目录：`D:/CodexWorktrees/platform-ui-typeset/child-growth-agent/docs/platform-review/ui-typeset/after/`。275个总交付路径中仅149个属于候选提交，126个第二轮生成物留本地。原先resume报告数组共享造成prior captures写成125的记录错误已按已保存的77张中断记录纠正，仅修装置/元数据，没有再开浏览器或改产品。

真实provider/搜索/真实对象桶/托管DB/生产迁移/部署请求0；模型事件仅响应fixture，不是真实Agent质量。NOT_RUN：原生浏览器工具栏200%缩放、Safari/iOS/真机与软键盘、人工屏幕阅读器、完整键盘旅程、真实多模态/长答质量、合法可执行提案的本分支真实批准写入、B1特定故障分支、生产性能/安全/并发。父代理共同基线70/70与113/113保留为共同基线证据，不改称本轮独立验收。
