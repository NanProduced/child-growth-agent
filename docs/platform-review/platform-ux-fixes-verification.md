# PLATFORM-UX-FIX1 联合浏览器装置

装置交付时状态：**READY_TO_RUN / 浏览器与容器 NOT_RUN**。主 agent 后续已执行两轮视觉复核与一次不出图的定点功能核验，实际结果与原始失败历史见 `docs/platform-review/platform-ux-fix1-delivery.md`，不能当成单次全矩阵 PASS。本装置不实现产品 UI、不提交、不部署、不访问线上环境，保护共享树现有家园沟通与其他改动。

## 运行

由主 agent 在所有源码编辑、其他构建/预览停止并确认本树可独占编译后执行：

```powershell
Set-Location 'D:/CodexWorktrees/family-communication/child-growth-agent'
$env:PLAYWRIGHT_CORE_DIR = 'C:/Users/nanpr/AppData/Local/Temp/opencode/g4-pw-core/node_modules'
pnpm exec tsx scripts/acceptance/run-platform-ux-fixes.ts
```

不安装依赖。runner 默认执行真实 `next build --webpack`、`next start`，只使用已安装的 Next、Chromium/Chrome 与 Playwright Core。自身只调用 Node/现有依赖，包管理仍通过 pnpm。

`check-platform-ux-fixes.cjs` 只接受 runner 的 stdin 数据；不要另传外部站点、数据库或生产凭证。账号口令仅由本轮 QA seed 凭证文件读入内存，再经 stdin 送入子进程，不出现在命令参数或输出中。

## 验收内容

- 教师、管理员、guest × 1440/1024/768/390：12 个正式页面（首页、班级/详情/证据、成长档案/详情/证据、观察记录、活动支持、成长回顾、家园入口、教师管理）。guest 私域与教师管理越权必须显示真实登录/无权限状态，不用空数据冒充。
- 单一芽芽入口：≤1090px 位于共享 header 正常流；宽屏保留 fixed 入口。正常鼠标打开/关闭、Escape 返回原入口焦点、非模态侧栏不挡主页面点击、未登录只能出现登录 gate。
- 无横向溢出；入口、目标 summary 与可见核心控制件测量 44px（`checkVisibility` 排除 collapsed 祖先内节点）；旧普通 inline 文字链接尺寸不足仅单列 advisory，不冒称 FIX1 新 P1。页面顶部/中部/底部用 `elementFromPoint` 核对视口内控件中心命中自身，记录实际测得数与滚动位置。没有控件的采样标为 `no_controls_in_viewport`，不当命中 PASS；每页至少有一个真实中心样本。≤1090px 要求入口与 main 控件零矩形重叠；宽屏浮动矩形交叠只记录，不等同点击受阻，中心命中仍为硬闸门。
- 原生目标级 `details[data-goal-id]` 与 `summary[data-testid=goal-disclosure]`：首个行为目标默认展开，其余收起；深层目标可用 Enter 展开/收起。保健参考保持独立折叠，不出现行为人数分布或比例。
- 同一实际页面临时打开全部目标，比较文档默认高度与全部目标高度：默认减少至少 60%。记录实际数值，随后恢复原 open 状态。这是 **DOM 布局比较**，不是数据库变更或业务效果验证。
- 正式 AUTH + 隔离库 GET 对照全部条目、三态人数、可靠性与比例；名单真实下钻到个人证据册，引用来自当前授权 GET，幼儿/条目/学期保持一致。五大领域及三个参考年龄/全部均通过现有控件选择，分母与期间不变，条目内容按正式筛选 DTO 核对。
- QA seed 的同名幼儿按真实合成班级区分，下拉内容对照当前正式 `GET /api/children` scoped 目录，不强求老师看到范围外幼儿（当前 seed 的 teacher_a 确实负责 A/B/fault）。长合成账号检验布局。不手写幼儿事实，不改变种子/旧检查，不伪称真人资料。
- 不生成家园分享，不发送芽芽消息，不批准/执行业务写入，不重复家园生成/编辑/复制链路。浏览器只允许本轮登录和打开助手时由既有 adapter 自动发起的私人会话元数据初始化 POST；初始化单独记录，观察、消息、家园分享事实必须不变。其他写请求及外部 origin 均拒绝，任何被拒尝试都判 FAIL。

## 安全、输出与清理

复用 `createAcceptanceSeed()` 与冻结 `harness-safety.ts`：容器/数据库/目录由既有生命周期登记与核验。仅向本轮隔离库追加现有家园迁移以支持只读入口。服务使用环境白名单，数据库、AUTH 与媒体根显式指定为本轮身份；StepFun/Yaya 文本和图片出口均指定本地拒绝守门，移除继承的 provider/数据库/Node preload 凭证。runner 不读取或改写 `.env`；Next 标准环境加载中的同名值也不会覆盖已明确提供的隔离配置。

守门拒绝数非 0 即 FAIL（不是成功的零模型验证）。观察、聊天消息与家园表事实在运行前后完整内存比较；私人会话初始化属于实际 UI 生命周期元数据写入，不称零数据库写入。只记录 HTTP 方法/路径/状态，不记录查询参数、Cookie、口令、连接串、请求/响应正文或异常栈；截图仅为合成页面，不采集填写凭证的登录表单。

输出：`output/playwright/platform-ux-fix1-<uuid>/results.json`、`network.json`、视口截图、`cleanup.json`。结果含每页 PASS/FAIL、实际测量、NOT_RUN 与精确自有资源 ID/目录/PID 创建身份，便于清理失败时人工核验，不输出凭证内容。

退出/超时/正常完成均尝试清理本轮子进程树、DB client、QA seed、模型守门并恢复 `next-env.d.ts`/`tsconfig.json`/Next 类型生成物；任一步失败/不可核验为非零退出。收到 SIGINT/SIGTERM 进入同一清理路径；seed 准备必须先完成返回或自身失败清理，不能提前抛弃其资源。系统强杀主进程/断电仍不能保证 finally 执行，不标为已清理。

独占 lock 只允许本轮 owner 删除；发现别人的 lock/占用端口直接失败，不接管、不按端口/名称前缀杀进程。不要与其他 Next 构建并行：快照恢复只保护既有获批生成物范围，不是整个 `.next` 构建目录的可恢复备份。没有临时产品路由与 route 文件写入/删除。

完整模式预先登记144格为NOT_RUN，实际完成后才填PASS/FAIL；定点模式只登记概览/管理页的16格，不冒充全矩阵。正确登录守门、教师管理403与正常授权页面分别登记。构建/登录/前序失败不把未执行格当PASS。

主执行补记：`--protocol-recheck`只重核概览/管理页，复用产品输入未晚于BUILD_ID的既有构建，不再出图或设计微调；该漂移检查不是发布认证。实际结果16/16案例、971/971，模型0，清理通过；两轮视觉原始失败记录保留。见交付说明的分层证据。

已做 CJS `node --check`、TS ES-module 内存转译后的 `node --input-type=module --check` 与 `pnpm exec tsc --noEmit --incremental false`（均 exit 0，不执行 runner/服务）。实际 browser/Next/隔离 DB、守门和清理结果由主 agent 统一运行产出。首次用 CommonJS 检查 ES-module `import.meta` 的诊断已改正，不作为产品错误。真实模型、线上库、Coze 桶、真机键盘、屏幕阅读器人工走查以及家园分享链路均 NOT_RUN。
