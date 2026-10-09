# PLATFORM-UX-FIX1 — 首轮界面修复

2026-10-09。工作树 `D:/CodexWorktrees/family-communication/child-growth-agent`，分支 `codex/family-communication-v1`，HEAD `49f819e46bce5a98e880b7252448946c1f8cbc4c`。本次是该 HEAD 上未提交增量；此前家园沟通在制内容全部保留，不把 HEAD 当成本次完整快照 SHA。未提交、合并、push、部署或操作主工作树。

## 实施

- 同一个芽芽入口由应用壳传入 TopNav：≤1090px 在导航流内，宽屏仍在右下角但收为紧凑图标。账号可先收缩再换行；状态保留在头像、可访问名称、live status/title中，继承导航焦点轮廓。打开后隐藏，关闭/Escape返回原焦点，`/assistant`不重复显示。
- 删除家园沟通/证据页旧的局部 launcher 定位补丁。
- 班级概览原生目标级 details/summary：首个行为目标默认展开，其余按需展开；收起目标同步关闭独立详情。领域、全部参考年龄、逐字条目、保健参考入口与统计口径保留，不把跨年龄/历史记录截去。
- 复核发现的首页平板溢出，仅修管理员按钮与访客流程行换行，不改批准的配色、字体、文案或视觉方向。

Impeccable采用adapt/distill，保留既有Operate风格。无新依赖、素材、状态框架或全站token重构。AUTH、业务API、指南读模型、迁移、LLM和harness未改；schema/家园API等Git差异是开始时已有内容。

## 布局与验证

同一正式授权页面、同一DTO临时展开全部目标，再恢复默认状态，比较文档高度。这是DOM布局比较，不是幼儿能力或业务效果评价；教师与管理员测量一致：

| 视口 | 全展开 | 默认 | 减少 |
| --- | ---: | ---: | ---: |
| 1440×900 | 43,262px | 3,475px | 92.0% |
| 1024×900 | 70,235px | 3,875px | 94.5% |
| 768×1024 | 70,271px | 3,910px | 94.4% |
| 390×844 | 73,903px | 4,215px | 94.3% |

全部条目、三态人数、可靠性与比例逐项对照正式GET；折叠前后API事实一致。真实引用/下钻保留幼儿、条目与学期；五大领域、全部/三个参考年龄通过正式控件验证。管理员无教学写控件。

- 离线概览42/42、入口静态24/24；静态检查不冒充真实布局。
- 原组件浏览器125/125（原115保留，新增默认折叠/1024/原生键盘/关闭详情/跨年龄保留），属于组件fixture。这轮在最后入口/首页收尾前执行，概览本体此后未改。
- 最终`pnpm validate`、`git diff --check`通过；Next production webpack构建通过。家园纯37、AUTH36、Guide19、保存一致性24回归通过。未重跑家园生成/编辑/复制。
- Impeccable局部detect：概览与入口均`[]`，不宣称全站设计/安全通过。

真实Next生产HTTP、AUTH、一次性自有PG与Chrome证据分层保留，不能改称一次性144/144通过：

1. `output/playwright/platform-ux-fix1-25cbce35-cd0d-462c-b02c-8e88c79d51ab/`：初次3508/3538，矩阵115PASS/29FAIL，找出入口、手机导航与首页问题及装置误判。
2. `output/playwright/platform-ux-fix1-f3f0bbd9-7c48-46c3-857c-8b2d0e916719/`：产品收尾确认3783/3785，矩阵135PASS/9FAIL；8个概览案例被装置全局aria-busy等待超时阻断，另1个管理案例采样到视口底部未完整可见按钮。入口/首页/访客守门通过；原失败记录不回写。
3. `output/playwright/platform-ux-fix1-291b77b3-1663-44bc-ba77-a76028f02b1b/`：概览与管理页定点核清16/16案例、971/971，faults=[]、advisories=[]。等待仅限概览route-shell；完整可见控件才计中心命中，顶部/中部/底部均采样，裁切控件不假算成功。上述9格在这里闭合，另外7格是重复正对照。

定点轮不再截图/改设计/构建，复用未改产品的构建；拒绝src/package/lock/config修改时间晚于BUILD_ID的复用。这只是本地漂移检查，不是发布用不可变快照认证。

打开助手会按既有adapter初始化私人会话元数据，装置允许并单列该POST（确认轮104个201、定点轮24个201），不声称零数据库写入。观察、聊天消息、家园分享业务事实前后内存对照不变；其他写请求/外部请求/模型守门命中仍FAIL。凭证只经本轮文件、内存与stdin，不进入参数/日志；网络记录无Cookie、正文、查询串和异常栈。

```powershell
$env:PLAYWRIGHT_CORE_DIR = 'C:/Users/nanpr/AppData/Local/Temp/opencode/g4-pw-core/node_modules'
pnpm exec tsx scripts/acceptance/run-platform-ux-fixes.ts
# 仅产品构建输入未变时的定点核验：
pnpm exec tsx scripts/acceptance/run-platform-ux-fixes.ts --protocol-recheck
```

## 清理与边界

三轮cleanup_ok=true；容器、进程树、模型守门、对象/凭证目录按身份清理。临时fixture路由与runner lock移除，next-env等生成物恢复。证据目录保留为本地生成物，不提交。harness blob仍`6702f2ddf3b436e79f8c92ae8756c33f611a8503`；package/lock、AUTH、指南读模型与pg-client差异为空。

本轮真实模型0、拒绝模型尝试0，不消耗/重置旧账本。NOT_RUN：真实provider、Coze桶/托管库、线上部署、真机/软键盘、Safari、人工屏幕阅读器、其他业务全链路。源码仍未提交，不称Git clean；家园沟通仍需单独整合交审。

结论仅限本轮入口、目标渐进展开与相邻响应式修复。下一批为文案/长名称排版，不将原报告88/94分或“零注入风险”升级为认证结果。
