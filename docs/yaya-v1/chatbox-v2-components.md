# 芽芽消息 UI：assistant-ui 复用与精简（2026-10-08）

本轮沿 `codex/yaya-chatbox-v2` 自有未提交工作树继续，基线仍为 `41d4a3f20889edac83cfe1697dd5125261b62f22`。保留上一轮并排/手机全屏、自然语言输入和授权页引用。不增加依赖、不升级 SDK、不 push/部署。

## 组件盘点与实际复用

`@assistant-ui/react` 实装0.15.23，官方区分未带样式的 primitives 与需单独安装的 styled elements；本轮按实装导出及源码验证，不盲用最新版示例或整套CLI覆盖。见[官方原语说明](https://www.assistant-ui.com/docs/primitives)。

| 平台 UI | assistant-ui 已有能力 | 本轮处理 |
| --- | --- | --- |
| 输入、发送、停止 | Composer.Root/Input/Send/Cancel | 保留原生行为与服务端取消接线 |
| 输入里的页面引用 | Composer.Quote/QuoteText/QuoteDismiss | 改用原生呈现/清除，应用只保留来源核验与异步请求清理 |
| 历史消息里的引用 | Message.Quote | 改用原生quote slot，继续解析冻结来源快照、核owner与当前投影 |
| 复制/反馈区 | ActionBar.Root/Copy | 用原生动作栏与复制反馈；不添加不可用反馈/重新生成按钮 |
| 用户/助手/复制状态 | AuiIf | 替换旧 Message.If；不新建状态系统 |
| 回到最新回答 | Thread.ScrollToBottom + ViewportFooter | 新增原生滚动入口和高度测量，不自己维护scroll状态 |
| 附件 | Attachment.Root/unstable_Thumb/Name/Remove | 复用原语；本版Thumb只是容器/后缀fallback，真实图仍来自本地File或授权内容接口，共用已有ObjectURL hook |
| 消息流/历史列表 | Thread/Message/ThreadList primitives | 继续复用原有运行时/键盘/列表能力，不复制另一套Provider |
| 工具查询状态 | Message.Parts的data slot | 保留真实事件，13种只读工具以中文短行展示，不造原生tool-call协议 |
| 批准、分项回执、历史原操作核验 | 通用ToolFallback/工具UI不是平台可信批准框架 | 保留自定义data卡与服务端计划/批准/回执核验，只简化呈现 |

明确未强换：原生 AddAttachment 没有当前的8张限额提示，整套替换会丢掉已验收的选图快速失败；保留小型picker，上传/移除继续用原生adapter和原语。MarkdownText需要额外包，当前已安装包不含它；安全Markdown保持完整长答、链接/HTML守门。ChainOfThought不能伪装为这里并不存在的模型思维链。

## 自定义消息精简

- 查询：`已查询 · 幼儿名册`，失败明确为`查询未完成`，不把英文工具代码作为主正文。技术名称仍保留在data属性。
- 来源：一行`参考来源 · N项`，展开可核对类别、正文标签与原始来源ID。无来源不造占位。
- 提案：完整对象/日期/原文/后果仍展开；移除重复资源徽章和正常态重复说明。只有待补/历史只读/受限才强调警示。
- 操作：一个主提交按钮，拒绝/撤销未执行批准收进44px菜单。成功回执齐全后不再显示“确认0条”等空动作；当前计划之外的回执不计为当前已保存。核对台按proposal_id键控局部状态。
- 宽屏：提案只在核对台显示时，对话流给清楚的指向提示，不留下空头像。
- 附件：ready但待发送不再显示上传中；失败的重试/移除按钮不重叠。附件区包裹/限高滚动，不把手机输入顶出视口。
- 未知/失败/历史核验的服务端守门原样保留；完整业务内容不藏到审计详情。

## 联测发现的真实语义差异

原界面的“取消提案”实际调用 `cancelPendingApproval`，只撤销未消费批准，不关闭提案。本轮**不改DATA/DDL**，改为“撤销未执行批准”；客户端严格解析既有 `cancelled_approval_id`（nullable）。null明确提示没有待撤销批准，非null才提示已撤销批准；绝不称“提案已取消”，已提交业务不回滚。

第一轮附件重试观测用错字段`client_upload_id`，已改实际multipart的`client_batch_id`，无删除原身份断言。初次取消用例期待提案关闭，实读repository证明假设错误；修正真实反馈语义并保留落库不变断言，不伪造cancelled状态。

## 本轮检查与证据分层

- 静态/组件：ts-check、lint:build/style通过；原client56/56、页引用42/42；新增`check-message-ui.tsx`15/15（实际组件静态render，非浏览器）。
- 构建：Next16.1.1 Webpack编译与路由通过；tsup已通过。next-env生产导入已还原，不作为源码变更。
- 联合真实本地：`final-wire-e70389ed`70/70；真实Next production HTTP、AUTH/CSRF/隔离PG/toolkit/权威消息；本轮模型协议替身18次，真实provider0。
- Chrome24组记录（含3几何组），1440×900/1024×900/390×844，errors0。原覆盖保留；新增中文查询/来源展开/原生复制、二级操作键盘、成功后无空按钮、下一提案与真实撤销反馈、真实上传重试同身份及ready显示、完整长答与原生滚动。
- 上传第一次503是响应替身，重试走真实本地上传/元数据/本地对象存储；模型是替身，不是MM质量验收。
- Impeccable：一次定向detect，0 primary/5字体advisory；页面中主要消息读16/15px，其他legacy附件的10px与全站home-only type ramp差异如实保留，不改全站DESIGN。

实际截图/脱敏网络/几何：`output/playwright/final-wiring/`（本地、gitignored）。主要图：`proposal-pending-1440.png`、`chat-proposal-saved-1440.png`、`long-answer-mobile.png`、`attachment-retry-mobile.png`。已检视同一轮桌面/手机图；视觉简化完成后停止，不因细小审美差异继续改造。

本轮自有测试进程/容器/目录清理verified；不读.env，不触碰他方资源。harness blob保持6702f2ddf3b436e79f8c92ae8756c33f611a8503，package/lock与核心契约未变。

NOT_RUN：真实provider/Coze桶/托管DB/生产部署、Safari/真机软键盘/人工屏幕阅读器、多模态质量。撤销非null批准的完整浏览器分支本轮未构造；已验证无可撤销批准不伪造“已取消”。上一轮开发Webpack刷新异常未归因，本轮按正式本地构建复核，不据此宣布线上通过。
