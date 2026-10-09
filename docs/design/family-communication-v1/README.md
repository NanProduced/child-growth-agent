# 家园沟通：批准方向 2

用户于 2026-10-09 选择本轮显示的第二张图，并授权功能与页面开发。

- 原生 ImageGen 来源：`exec-f7b431c5-67fc-475c-b6db-cfa6503cfde3.png`。
- 归档：`approved-direction.png`；SHA256 `ED39124465EB322CA59DC09DEDF72824B9A0172C0C673FDF8A71280E960DA388`。
- 图片是设计示例，不是功能、真实模型或生产验收证据；其选中 3 条与顶栏 5 条的计数不一致不进入实现。
- 继承现有导航、字型、绿主行动；左侧事实列表，右侧父母可读文字；手机自然单列。
- 有意适配：使用纯文本编辑代替格式工具栏，直接服务微信复制；标题和计数都来自真实选择。模型正文与建议署名一起持久化为完整可编辑文字，复制只取核对保存后的完整 textarea 正文；不在复制时追加隐藏署名。
- 首版不做照片、公开链接、家长账号、自动发送、PDF 或图片导出。
- 私人草稿独立存储；已核对不等于已发送；生成绝不覆盖观察或成长小结。
- 生成和复制前重核教师/会话/当前幼儿归属/所选已确认观察。原请求未知仅 GET 核验，不自动重发。除成长档案带入 childId 的入口外，须显式选幼儿；同班同名显示出生日期。

## Direction contract

THESIS：教师对照具体观察编辑给家长的分享，不创建测评仪表盘。

OWN-WORLD：沿用芽芽观察的中文无衬线、白色与浅色表面、绿主按钮、轻边界；不改全站视觉规范。

STORY：选幼儿和日期，选关键事例，生成可编辑草稿，核对后复制，自行发送。

FIRST VIEWPORT：顶部范围控件，桌面左事实、右文字；当前列比为 0.88fr/1.55fr（受最小列宽约束），主行动位于编辑区右下。窄屏单列、来源默认折叠并保留已选数，助手位于顶部返回工具栏。

FORM：用户明确选择本轮第二张“事例核对页”，用户指定方向优先，不另运行抽签。

FINISH：这是既有世界中的普通新模块，documenter 收尾仅更新模块 brief、本 README 与交付文档。局部策略与实际 values 已记录；独立终检 01a11e68 返回 SHIP，仅原四项 P2 4/4 resolved，主执行静态与回归均通过。最终 Next 生产 webpack 构建及 next-env 恢复 COMPLETE（非主评审批准），不再做 UI hunt。documenter 不刷新 root DESIGN.md、design.json、PRODUCT.md 或 design-qa.md，历史设计漂移不扩大授权。

## 当前实现与方向图的对照

实际局部 values 记录在 [模块 surface brief](../../../.impeccable/surfaces/src-components-family-communication-workspace-tsx.md)，以 `workspace.module.css` 和继承的 global token 为依据；不把方向图的示例文案、数字或工具栏当成功能规范。

- 白色事实面板与完整 textarea；浅绿编辑面板使用 `color-mix(in srgb, var(--accent) 40%, var(--card))`。保留既有 `--primary`、`--accent`、`--card` 等变量与中文字体，不引入模块专属全站配色。
- 成功提示为绿色 `--accent`；失败、未知及剪贴板拒绝用中性 `--muted`，配合不同图标、文字与 status/alert 语义。剪贴板失败时选中完整编辑文字供手动复制，已核对不代表已发送。
- 普通正文 16px、次要信息通常 14px；44px 交互目标、键盘焦点、减少动态、窄屏折叠来源和顶部助手已有浏览器实测。两个展开按钮具有 `aria-expanded`/`aria-controls`；屏幕阅读器实测仍为 NOT_RUN。

方向图原生 1487×1058，近等比归一化为 1440×1024；实页完整桌面截图为 1440×1133，同状态对比只取顶部 1440×1024（3/5 已选、草稿未核对）。已有对照：`output/playwright/family-communication/comparison-desktop.png`、`comparison-editor.png`。修后页面证据包括 `draft-desktop-1440.png`、`clipboard-denied.png`、`workspace-390.png`、`mobile-facts-expanded.png`；截图目录为本地忽略产物，不作为生产验收。

## 收尾状态与证据边界

- 最新主执行线程记录：纯检查 37/37、DB 54/54、真正 Next production + Chrome 37/37。documenter 本轮只读核对浏览器 `results.json` 为 `passed=37`、`errors=[]`、`provider=protocol_double`、`real_model_requests=0`，清理 `cleanup.json` 为 `cleanup_ok=true`、`issues=[]`；未复跑测试。
- 主执行线程最终交接：source-save 24/24、原角色 21/21、auth-client 33/33、auth 契约 36/36、guide 19/19、core 68/68、business 113/113 全部通过，business cleanup verified；最终 `eslint . --quiet`、`tsc` 与全范围 stylelint 均 exit 0。最终页面 JSX 已移出读取 try/catch，布局/功能未变；documenter 未独立复跑。
- 独立终检 01a11e68：**SHIP**，范围仅原四项 P2（完整复制署名、面板色偏、成功/失败提示混色、展开 ARIA），**4/4 resolved**。不再做 UI hunt；此裁定不认证整站、生产或真实 provider，也不等于用户主评审部署授权。
- DB 54/54 已覆盖 5 分钟截止超时、锁后 DB clock、late 模型结果拒绝和过期 pending 只读 failed 恢复。验收为 SQL fixture 与真实生成函数的 model-await 等待时序反例（provider 替身），不宣称真实 kill 进程验收。
- DEV webpack layout eval 异常保留；production 浏览器成功不等于 DEV 修复。登录 POST 降级/就绪前禁用未改 AUTH 规则。资料指纹与原始观察未写回。
- 主执行最终构建/恢复与保留检查：**COMPLETE（非主评审批准）**。Next 生产 webpack build 已通过；`next-env.d.ts` 已按原 tracked 内容恢复；`git diff --check` 通过；package/lock、AUTH 核心、冻结 types/API/harness 及 next-env 的 diff=0；helper 仍为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`；`cga.family.check` 容器标签扫描无残留。documenter 仅记录主执行交接，未独立执行这些检查。
- 真实 provider、真实 kill 进程、生产迁移/部署仍 NOT_RUN；用户主评审/部署授权尚未取得。主线程最终交付不提交、不部署；见 [交付记录](../../family-communication-v1-delivery.md)。
- 按主执行交接，root `design-qa.md` 已追加严格新模块段，旧历史保留；documenter 未读取或改动该文件，该记录不扩展本模块终检范围。

## Release gate：同步生成等待

生成 POST 当前同步等待模型结果。平台代理最长等待/TTFB 与真实 provider 负载尚未联测；如果实际请求达到平台 90s 闲断边界，需要另行优化为注册后返回 202 或流协议，此处只记录待办，当前未实现。原 ID 的只读恢复可处理响应丢失，不等于同步请求的生产延迟风险已关闭。联测结果与发布裁定仍由 main 补齐，不将 Chrome 协议替身验收当作该 gate 已通过。
