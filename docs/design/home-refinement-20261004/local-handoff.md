# 首页本地候选交接

范围：按已批准的四态设计图实现首页；未登录、教师、管理员与教师移动端均使用真实角色/授权链路。
分支 `codex/home-v2-craft`，工作树 `D:/CodexWorktrees/guide-local-preview/child-growth-agent`。
当前HEAD `e877f3b` 是 AUTH1 基座本地合并；本轮后续实现尚未提交，未 push、未部署。main 仍为 `b39df27`。

## 实际 review

- 地址：http://127.0.0.1:5020/
- 临时账号：工作树 `logs/home-review/local-credentials.json`；不提交、不在聊天或日志中打印密码。
- `teacher` 为林小满（3 班／54 名幼儿）；`admin` 为王园长（6 班／94 名幼儿）；`unassigned` 用于未分配班级状态。
- 这些是本次拥有的一次性隔离 PostgreSQL 测试记录，不是托管库，不是模型真实生成质量证据。
- 预览保留运行；监督脚本启动后4小时自动按身份和标签清理资源与临时凭证。
  关闭后可在本工作树执行 `pnpm exec tsx scripts/start-home-review.ts` 重新建立隔离预览，账号密码／随机 ID 会更新。
  要主动结束，仅使用 `pnpm exec tsx scripts/stop-home-review.ts`，不按端口杀其他服务。

## 验收分层

- 最新代码 `pnpm validate`、`pnpm build` 通过；生成的 `next-env.d.ts` import 已恢复。
- Home 数据纯检查40/40；客户端模拟33/33；教师管理模拟28/28；认证契约36/36。
- 真 Next HTTP20/20，包括10个并发管理员页面渲染；隔离 PG 已核对 idle-in-transaction0。
- 权限／迟到写入隔离 PG107/107；G5 runtime140/140、R1纯检查91/91、路由语义26/26（授权替身）；页面语义11/11（授权替身）。
- AI 基础回归30/9/13/19/13/24通过；不是新增真实模型评测。
- 实际浏览器验证：真实登录／退出、未分配班级、待确认入口到列表／Review、管理员到教师名单及取消停用、键盘焦点。
  修复后1536、1440、768、390均无横向溢出，核心目标>=44px（测量43.9px容差）；减少动态为none/0s并恢复。
  新字体已加载、暖白像素正确、插画与行动区净空约26px；手机三班最后行804.5px<844px。
- 独立 reviewer 对原七项修复均判resolved，disposition **ship** 仅限这七项；没有扩大成全应用或生产安全认证。
- 人工比较 `design-qa.md` 为passed；自动 HERO gate仍FAIL85.16%，未force，comp-led自动pipeline未完成。
  逐项误判／真实适配裁定见 `gate-adjudication.md`，不使用整页分数冒充PASS。

## 图像与证据

四张批准原稿在本目录；两个透明原生 ImageGen素材在 `public/assets/illustrations/home-v2-{guest,teacher}.png`，含完整prompt/origin。
新截图在 `.impeccable/review/verdict-{guest,teacher,admin,mobile,1440,768}.png`，比较和区域裁剪在 `diff/verdict-*`。
设计规范与sidecar已同步，仅替换首页世界，指南三状态／✓口径未变。

## NOT_RUN

真实 StepFun/Coze 调用与质量、LLM Judge、托管库迁移／写入、反向代理配置、多实例限流、公开发布／部署未执行。
AI 预算保持原边界，没有重置或增加请求；真实生成入口在此预览受守门保护。
稀有动态姓名的字体回退／跨系统排版未穷举。本轮也未做生产级安全认证或全量业务写操作验收。
