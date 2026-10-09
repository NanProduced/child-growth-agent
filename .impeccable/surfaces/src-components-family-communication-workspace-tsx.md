# 家园沟通

Mode: Operate. Target: `src/components/family-communication/workspace.tsx`. Related: `src/components/family-communication/workspace.module.css`, `src/app/family-communication/page.tsx`.

## Direction contract

THESIS: 教师对照日常观察写给家长的分享，不做测评、排行榜或完整领域填表。
OWN-WORLD: 沿用现有芽芽观察导航和中文字体，白色事实列表、轻色编辑面板、绿色主行动；不建立新的全站系统。
STORY: 显式选择可读取幼儿与具体日期（成长档案入口可带入 childId），选观察事例，生成私人草稿，编辑核对完整正文与署名后复制，自行发送。同班同名选项附出生日期。
FIRST VIEWPORT: 桌面左事实、右文字；顶部幼儿与期间。手机先保留已选数量，可展开核对事实，不用长列表压住主要任务。
FORM: 用户 2026-10-09 选择本轮第二张作为设计方向；`docs/design/family-communication-v1/approved-direction.png` 是视觉参考。保留结构，适配真实数据与纯文本微信复制，未将图稿里的示例数量固化。
SIGNATURE: 观察可回到原记录；文字核对状态与观察归档、实际发送分开；助手入口沿用证据页顶部返回栏定位，不覆盖内容或主按钮。
FINISH: 本模块局部文档与方向图来源已记录；独立终检 01a11e68 返回 SHIP，仅原四项 P2 4/4 resolved。主执行静态与回归已通过，最终 Next 生产 webpack 构建及 next-env 原 tracked 内容恢复 COMPLETE（非主评审批准）；不再做 UI hunt。普通新模块继承既有视觉世界，documenter 不生成或刷新 root DESIGN.md、design.json、PRODUCT.md、design-qa.md。

## Implemented local values

以下为 `workspace.module.css` 使用的实际值与继承的浅色 global token；仅描述本模块，不另建全站 token。暗色模式继承既有变量，本轮没有暗色浏览器验收记录。

| 用途 | 当前值与应用 |
| --- | --- |
| 页面/事实表面/文字 | `--background: oklch(0.985 0.012 88)`；`--card: oklch(1 0 0)`；`--foreground: oklch(0.145 0 0)` |
| 主行动/轻绿 | `--primary: oklch(0.52 0.14 150)`；`--accent: oklch(0.95 0.035 150)`；编辑面板为 `color-mix(in srgb, var(--accent) 40%, var(--card))` |
| 边界/提示 | `--border: oklch(0.91 0.018 88)`；注意、失败、未知用 `--muted: oklch(0.97 0.01 88)`；次要字色在 `[data-platform-surface]` 下实际继承 `oklch(0.49 0 0)` |
| 提示语义 | 成功用 `data-tone="success"`、`--accent`、Check、`role="status"`；其他提示用 `data-tone="attention"`、中性底、Info、`role="alert"`。复制未获准不显示绿色复制成功 |
| 字体/正文 | `'Home Noto Sans SC', var(--font-sans)`；观察正文 16px/1.8，编辑正文 16px/1.95，次要信息通常 14px，提示 15px，状态标签 13px |
| 标题 | h1 32px/700/1.3，低于 600px 为 26px；面板标题 20px/650/1.4，低于 600px 为 18px |
| 网格 | 页面最大 1360px；事实/编辑列 `minmax(300px, 0.88fr) minmax(0, 1.55fr)`、间隔 22px；低于 1150px 为 `minmax(260px, 0.85fr) minmax(0, 1.3fr)` |
| 表面/编辑框 | 面板边界 1px、圆角 12px；事实/编辑面板内边距 22/24px，低于 600px 均 18px；编辑框内边距 24px（手机 18px）、可垂直调整，高度下限 380px（低于 900px 为 330px，低于 600px 为 360px） |
| 窄屏/触控 | 视口或 `yaya-main` 容器低于 900px 改单列；有记录时来源默认折叠，保留已选数；交互目标至少 44px。月份用原生 `input type="month"` |
| 助手/焦点/动态 | 助手沿用顶部返回工具栏定位：top 100px/right 24px，视口不大于 1090px 为 top 152px/right 16px；焦点描边 `3px solid var(--ring)`、偏移 3px；减少动态时关闭动画与 transition |

## Copy and recovery contract

- 模型正文与建议署名 `<教师显示名> · <班级名>` 一起存入 `body`，整个 textarea 都可编辑；复制只取核对保存已确认的完整 textarea 正文，不在复制时另拼署名。署名不是单独隐藏的输出片段。
- 剪贴板拒绝时，保存/核对结果与复制失败分别说明，并聚焦、选中全文供手动复制。Windows 复制对照仅归一化 CRLF/LF，不裁剪文字来掩盖差异。
- 生成有登记时起算的 5 分钟 DB 截止；拿到 draft 行锁后再独立查询 DB clock，派发与生成结果保存共用截止守门。旧 pending 超时只读投影为 failed，不写回状态、不重派模型，迟到结果也不能保存。
- 请求结果未知仅 GET 核验原请求，保留已有文字；失败、未知、可信空和来源 stale 分开。已核对不代表已发送。
- Release gate：生成 POST 当前同步等待；平台代理最长等待/TTFB 与真实 provider 负载尚未联测。若实测达到平台 90s 闲断边界，需另行优化为注册后返回 202 或流协议；现有原 ID 只读恢复可处理响应丢失，不代表生产延迟风险已关闭。

## Scope and verification

- 正式认证、事务、范围过滤、模型出口与独立私人草稿存储，不保留产品 mock 路由。
- 暂不做照片、PDF、公开链接、家长账号和自动发送，也不将此模块伪装成已注册的芽芽写工具。
- 使用现有字体与 shadcn/Lucide；普通中文正文16px、次要信息通常14px（提示/状态标签见上表），触控至少44px，手机单列、来源默认收起，减少动态关闭动画。
- 最新主执行线程实测：纯检查 37/37、隔离 DB 54/54、真正 Next production HTTP + 隔离 PG + Chrome 37/37。本轮只读核对浏览器 `results.json`：`passed=37`、`errors=[]`、`provider=protocol_double`、`real_model_requests=0`；未复跑纯/DB/浏览器。
- 主执行线程最终旧回归：source-save 24/24、原角色 21/21、auth-client 33/33、auth 契约 36/36、guide 19/19、core 68/68、business 113/113 均通过，business cleanup verified。最终 `eslint . --quiet`、`tsc`、全范围 stylelint 均 exit 0；documenter 按主执行交接记录，未独立复跑。
- 最终页面 JSX 已移出读取 try/catch，交接确认布局/功能未变。按主执行最终交接，Next 生产 webpack build 已通过，`next-env.d.ts` 已按原 tracked 内容恢复；该构建与恢复项为 COMPLETE（非主评审批准）。
- 主执行保留检查 COMPLETE：`git diff --check` 通过；package/lock、AUTH 核心、冻结 types/API/harness 及 next-env 的 diff=0；helper 仍为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`；`cga.family.check` 容器标签扫描无残留。documenter 仅记录交接，未执行 Git 检查或容器扫描；主线程最终交付不提交、不部署。
- 截图 `output/playwright/family-communication/`；同状态对照 `comparison-desktop.png` 与 `comparison-editor.png`。完整视口1440×1024/1024×900/768×1024/390×844，无横溢。
- 图稿原生1487×1058按近等比归一化为1440×1024；实页完整截图1440×1133，比较只用顶部1440×1024。同状态为3/5已选、未核对的分享草稿。
- 早期开发模式 webpack layout eval 出错记录保留；production 浏览器成功不等于 DEV 已修。登录 POST 降级与就绪前禁用是有限保护，不改变 AUTH 规则。
- 首轮浮动遮挡与手机长列表已改为顶部入口与折叠来源。独立终检 01a11e68：SHIP，仅确认完整复制署名、面板色偏、成功/失败提示混色、展开 ARIA 原四项 P2 4/4 resolved；两个展开按钮都有 `aria-expanded` 和指向 `communication-source-list` 的 `aria-controls`。该裁定不认证整站、生产或真实 provider，也不构成用户主评审部署授权。
- DB 54/54 已覆盖截止超时、late 模型结果拒绝、过期 pending 只读恢复；证据是 SQL fixture 与真实生成函数的 model-await 等待时序反例，provider 仍为替身，真实 kill 进程验收 NOT_RUN。生产代理等待/TTFB/真实 provider 负载联测仍未运行。
- `cleanup.json` 为 `cleanup_ok=true`、`issues=[]`。真实 provider、生产迁移/部署、真机/Safari/屏幕阅读器 NOT_RUN；本轮 documenter 未启动服务、调模型、提交或部署，资料指纹与原始观察未写回。
- 主执行交接称 root `design-qa.md` 已追加严格的新模块段、旧历史保留；documenter 未读取或修改该文件，不将其追加记录解释为整站验收。用户主评审/部署授权尚未取得。
