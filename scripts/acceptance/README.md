# 班级指南证据概览：浏览器验收装置（G4 fixture 验收）

只读组件验收：用自建 DTO fixture 驱动临时预览路由，在真实 Chrome 中检查交互、可访问性、
响应式与口径断言。**不接真实 API/数据库，不调用模型**；验收结果不等于正式业务闭环。

## 前置条件

| 需要 | 说明 |
|---|---|
| Windows PowerShell 7+ (`pwsh`) | runner 使用 PID 树清理与 `-LiteralPath` 文件操作；非 Windows 未验证（NOT_RUN） |
| Node + pnpm | 项目唯一包管理器；不新增项目依赖 |
| Chrome | 默认查找常见安装路径，可用 `-ChromePath` 或 `CHROME_PATH` 指定 |
| playwright-core | **不加入项目依赖**，由验收环境临时提供（见下） |

`playwright-core` 临时安装（scratch 目录，不提交）：

```powershell
$scratch = Join-Path $env:TEMP "g4-pw-core"
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
Set-Content -LiteralPath (Join-Path $scratch "package.json") -Value '{"name":"g4-pw-core","private":true,"version":"0.0.0"}' -Encoding utf8
pnpm --dir $scratch add playwright-core@1.63.0
```

## 运行

```powershell
pwsh -NoProfile -File scripts/acceptance/run-class-evidence-ui-check.ps1 `
  -Port 3101 `
  -OutDir "$env:TEMP\g4-class-evidence-ui-check" `
  -PlaywrightCoreDir "$env:TEMP\g4-pw-core\node_modules"
```

- `-Port`：真实端口，同时用于启动 dev 与浏览器检查的 `--base-url`（不存在固定端口）。
- `-OutDir`：结果目录（截图、`results.json`、`dev-*.log`、`acceptance-run.json`）。
- `-PlaywrightCoreDir`：含 `playwright-core` 的 `node_modules`；也可用环境变量 `PLAYWRIGHT_CORE_DIR`。

## 安全边界（runner 行为）

1. **不按端口杀进程**：启动前用 loopback `TcpListener` 探测端口，被占用即失败退出，
   绝不关闭已有服务；不依据端口推断进程所有权。
2. **只清理本轮启动的进程**：记录 runner 自身 PID 与 dev server PID + StartTime；
   清理前核对一致才 `taskkill /PID <pid> /T /F`（或 `Stop-Process` 兜底）。
3. **路由不覆盖**：`src/app/guide-preview-class` 已存在即拒绝运行；只创建/删除本轮创建的路由文件，
   全部使用经核验的绝对路径与 `-LiteralPath`。
4. **不整目录清空 `.next`**：启动前快照 `.next/**/types` 下的类型生成物与 `next-env.d.ts`；
   结束后只处理引用了 `guide-preview-class` 的生成物（本轮新建的删除、已有文件按快照恢复），
   并恢复 `next-env.d.ts`，`pnpm ts-check` 保持通过。
5. 仓库内不保留任何生产可访问的 mock 路由；`acceptance-run.json` 记录本次 PID/端口/清理结果。

## 验收范围

- 三断点（1440×900 / 768×1024 / 390×844）：无横向溢出、核心目标 ≥44px。
- 交互：期间受控与草稿、领域/参考年龄/目标筛选、三类名单与受限名单下钻、键盘与焦点、减少动态。
- 口径：reliable 完整三类分布与占比；partial 可核验依据摘要（不画完整分布）；unavailable 不冒充
  暂无；保健参考可靠性优先；待核对不计入。
- 截图在展开动画结束后拍摄（等待面板 `opacity → 1` 或动画关闭）。

## NOT_RUN

- 非 Windows / 非 PowerShell 环境。
- G5 读模型与 API 真实链路、真实 StepFun/Coze 调用、实库迁移与写入、正式班级页装配（G6）。
