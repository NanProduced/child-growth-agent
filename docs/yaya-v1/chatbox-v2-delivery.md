# 芽芽 Chatbox v2 本地实现交付

> 追加消息UI精简与assistant-ui复用轮：见 `chatbox-v2-components.md`。下文原轮数字/失败记录保留为历史，不把新轮结果覆盖到旧轮；最新真实本地联测为final-wire-e70389ed（70/70，Chrome24组，真实模型0）。仍未提交/合并/发布。

## 身份与范围

- 分支 `codex/yaya-chatbox-v2`；工作树 `C:\Users\nanpr\AppData\Local\Temp\yui-v2`。
- 起点 `41d4a3f20889edac83cfe1697dd5125261b62f22`，本轮修改留在独立工作树，未合并 main、未 push、未部署。
- 主仓库仍为 `b39df279672d566994810e8419cb210a4d26ffb1`，既有未跟踪文件未动。已发布版本与本轮候选不是同一身份。
- 不改 package/lock、AUTH/G0 冻结类型、Yaya types/API0/schema/迁移。harness blob保持 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。

## 改动

1. 应用壳预留桌面助手列；手机全屏；入口不遮输入，主页面可交互。React Activity保留同账号草稿，实时TeacherProvider状态重建换账号/失效投影。
2. 聊天头、完整长答、mint用户气泡、原文/日期/对象/后果核对卡、历史核对可见反馈、统一多行输入与44px核心动作。宽工作区保留批量台；没有伪造“修改内容”按钮。
3. 去掉对象/来源选框。可选页引用走 `GET /api/yaya/page-reference`，由真实scoped读取提供有限摘要；不用DOM抓取全页，不抓远程URL、不读取输入表单/凭证。共享schema核路径、来源、quote身份及长度。
4. 引用与教师输入分开存成同一消息的片段；raw输入和run user_text不被引用前缀改写。模型收到去owner/UI字段的不可信关注线索，实际资源依赖纳入APP已有授权/投影重核，不是新的批准框架。
5. 引用待取回时Enter与表单提交同样禁发，但允许继续输入。列表页只引用入口/筛选，不将未绑定权限的选中文本标为公共可读；具体资源页支持选中片段。一般自然语言查询无引用前置。
6. 侧栏使首页变窄后的重排用命名container query，仅作用于打开助手时的主页列，不替换全站视觉。

## 本轮实测

| 检查 | 结果/证据层 |
| --- | --- |
| ts-check / lint:build / lint:style | 全部exit0，串行执行；未使用新依赖 |
| `check-ui1-client` | 原56/56保留 |
| `check-chatbox-v2` | 42/42纯函数+真实browser bundle，无网络/DB |
| `next build --webpack` +现有tsup参数 | Next编译/路由与server bundle通过，生成next-env已恢复 |
| `check-final-wiring` | 70/70，最新 `final-wire-943a41eb`；真实本地Next生产HTTP、AUTH/CSRF/PG/toolkit/消息落账，模型为本轮回环替身16次，真实模型0次 |
| 正式Chrome联合UI | 1440×900 /1024×900 /390×844；18组记录含3组几何：无横向溢出、composer可见、主页可导航、入口隐藏、可选引用查看/移除/内层Escape、关闭草稿保留、延迟引用Enter不发、实际批准→精确raw落库、刷新原操作GET核验无重发 |
| `check-agent-app1` | 182/182，无失败；真实Next dev/AUTH/隔离PG/受控锁交错、真实sharp/本地对象根；仅模型为协议替身。run `agent-app1-muyu63sj-eebb6b84` |
| Impeccable detect | 定向`src/components/yaya`，0 primary /5 advisory；10px附件次要标签与15px聊天阅读尺寸，不改全站type ramp或压低正文 |

早期新增引用纯检查35项，最终42项保留并增加来源/路径/列表文本/筛选反例；客户端原56条未删。先前bootstrap/static、API0 57、chat-bind22、Yaya68、AUTH36、Agent29/prompt11的实测分层记录不冒充真实provider。

## 独立审查与修复

只读审查指出3项：列表选中文字丢权限来源、Enter绕过引用等待、实际class/status筛选不可引用。已在共享quote schema、输入Root capture及路径白名单关闭；纯42条和实际延迟请求Enter反例证明。设计方向落地不等同逐像素复制。

## 失败与环境边界

- 初始嵌套长路径/junction导致Turbopack依赖解析失败，其后进程内存不足。工作树完整迁到短路径并使用锁定依赖离线安装；未新增/升级版本。next.config只使用动态root，不写本机绝对路径。
- 开发Webpack模式刷新助手曾出现 `Invalid or unexpected token`、初始化未开始。未归因，不声称已关闭；正式Webpack生产构建两轮可刷新并按原身份核验，浏览器errors为空。开发服务异常继续单列，不据此宣布任何线上环境通过。
- 早期选择器命中隐藏Activity重复文本，已改可见卡片；不用force click、不删业务落库断言。历史结果原先折叠在审计details，本轮直接呈现状态，UUID保留在详情。

## 证据、清理与NOT_RUN

- 本地截图/脱敏network/`browser-results.json`：`output/playwright/final-wiring/`（gitignored）；合成server日志 `logs/final-wire-*`（gitignored）。原生批准稿及实际prompt有文件hash台账，不把截图当模型质量证据。
- 全部已完成测试自有容器/Next进程树精确清理、生成物恢复。中途OOM的自有容器按ID+标签回收；后来以精确seed标记确认的两个目录也已删除（不可恢复、均为合成测试数据）。另一个seed的目录仅观察，未触碰。无本轮预览服务保留。
- 本轮真实provider/搜索/真实S3/托管数据库/迁移/部署请求0，新增20次模型额度未消费；未读`.env`。
- 真机软键盘、Safari/iOS、人工屏幕阅读器、真实长答质量与多模态、扣子部署后的代理/并发：NOT_RUN。下一步先评审本地实际截图，再经明确上线授权发布此候选并重跑平台验收。
