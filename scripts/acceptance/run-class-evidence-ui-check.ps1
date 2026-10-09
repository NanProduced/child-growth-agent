# G4 班级指南证据概览：一次性浏览器验收 runner（fixture 组件验收，不接真实 API/数据库）
#
# 安全边界：
# - 不按端口杀进程：端口被占用时直接失败，绝不关闭已有服务。
# - 只清理本轮启动且身份可核实的进程树：记录自身 PID 与被启动进程 PID + StartTime，
#   清理前核对一致才执行 taskkill /T；不依据端口占用情况推断进程所有权。
# - 预览路由存在即拒绝覆盖；只删除本轮创建的路由文件（-LiteralPath + 绝对路径）。
# - 不整目录清空 .next：启动前快照类型生成物与 next-env.d.ts，结束后只处理引用了临时预览
#   路由的生成物（本轮新建的删除，用户已有的按快照恢复），并恢复 next-env.d.ts。
#
# 用法：
#   pwsh -NoProfile -File scripts/acceptance/run-class-evidence-ui-check.ps1 `
#     -Port 3101 -OutDir <结果目录> [-PlaywrightCoreDir <含 playwright-core 的 node_modules>] [-ChromePath <chrome.exe>]

[CmdletBinding()]
param(
  [int]$Port = 3101,
  [string]$OutDir = "",
  [string]$PlaywrightCoreDir = "",
  [string]$ChromePath = "",
  [switch]$Production,
  [int]$ReadyTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$runnerPid = $PID

# ---- 路径核验：全部使用脚本位置推导的绝对路径 ----
$scriptDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\.."))
$srcAppDir = Join-Path $repoRoot "src\app"
if (-not (Test-Path -LiteralPath $srcAppDir -PathType Container)) {
  throw "未找到项目 src/app（从脚本位置推导：$srcAppDir）"
}
if (-not $OutDir) { $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) "g4-class-evidence-ui-check" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$routeDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "src\app\guide-preview-class"))
$routeFile = Join-Path $routeDir "page.tsx"
$templatePath = Join-Path $scriptDir "preview-page.template.tsx"
$checkScript = Join-Path $scriptDir "check-class-evidence-ui.cjs"
$baseUrl = "http://127.0.0.1:$Port/guide-preview-class"

foreach ($required in @($templatePath, $checkScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少验收文件：$required" }
}

$pnpm = (Get-Command pnpm -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source

# ---- 端口占用即失败（不杀进程；TcpListener 探测后立即释放，不做归属推断） ----
function Test-LoopbackPortFree([int]$probePort) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $probePort)
    $listener.Start()
    return $true
  } catch [System.Net.Sockets.SocketException] {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

if (-not (Test-LoopbackPortFree $Port)) {
  throw "端口 $Port 已被占用：runner 拒绝启动，也不会关闭任何已有服务。请使用 -Port 指定空闲端口，或先自行确认占用者身份。"
}

# ---- 已有预览路由不得覆盖 ----
if (Test-Path -LiteralPath $routeDir) {
  throw "预览路由已存在：$routeDir。拒绝覆盖，未创建或修改任何文件；请先确认来源并手动处理。"
}

$routeCreated = $false
$serverPid = $null
$serverStartedAt = $null
$checkExit = 1
$script:cleanedRoute = $false
$script:cleanedServer = $false

# ---- 类型生成物与 next-env 快照（不整目录清空 .next；结束后按文件定向恢复/删除） ----
$typeRoots = @(
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".next\types")),
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".next\dev\types"))
)
$typeSnapshot = @{}
foreach ($typeRoot in $typeRoots) {
  if (-not (Test-Path -LiteralPath $typeRoot)) { continue }
  Get-ChildItem -LiteralPath $typeRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*.ts" } |
    ForEach-Object { $typeSnapshot[$_.FullName] = [System.IO.File]::ReadAllBytes($_.FullName) }
}
$nextEnvPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "next-env.d.ts"))
$nextEnvSnapshot = if (Test-Path -LiteralPath $nextEnvPath -PathType Leaf) {
  [System.IO.File]::ReadAllBytes($nextEnvPath)
} else {
  $null
}

try {
  New-Item -ItemType Directory -Path $routeDir | Out-Null
  Copy-Item -LiteralPath $templatePath -Destination $routeFile
  $routeCreated = $true

  if ($Production) {
    & $pnpm exec next build --webpack
    if ($LASTEXITCODE -ne 0) { throw "fixture production build failed" }
  }

  $serverOut = Join-Path $OutDir "dev-out.log"
  $serverErr = Join-Path $OutDir "dev-err.log"
  $nextArgs = if ($Production) { @("exec", "next", "start", "--hostname", "127.0.0.1", "--port", "$Port") } else { @("exec", "next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "$Port") }
  $server = Start-Process -FilePath $pnpm `
    -ArgumentList $nextArgs `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -PassThru -WindowStyle Hidden
  $serverPid = $server.Id
  $serverStartedAt = $server.StartTime

  $ready = $false
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { break } # 启动失败路径
    try {
      $response = Invoke-WebRequest -Uri $baseUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      # 尚未就绪，继续轮询
    }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) {
    $tail = ""
    if (Test-Path -LiteralPath $serverOut) {
      $tail = (Get-Content -LiteralPath $serverOut -Tail 20 -ErrorAction SilentlyContinue | Out-String)
    }
    throw "dev server 未在 $ReadyTimeoutSeconds 秒内就绪（$baseUrl）。日志尾部：`n$tail"
  }

  if ($PlaywrightCoreDir) { $env:PLAYWRIGHT_CORE_DIR = [System.IO.Path]::GetFullPath($PlaywrightCoreDir) }
  if ($ChromePath) { $env:CHROME_PATH = [System.IO.Path]::GetFullPath($ChromePath) }

  Start-Sleep -Seconds 3
  Write-Output "runner_pid=$runnerPid server_pid=$serverPid base_url=$baseUrl out=$OutDir"
  & $node $checkScript --base-url $baseUrl --out $OutDir
  $checkExit = $LASTEXITCODE
  Write-Output "check exit code: $checkExit"
} finally {
  # 只清理本轮启动且身份可核实的进程树（PID + StartTime 双重核对；不按端口推断）
  if ($serverPid) {
    $serverProcess = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if ($serverProcess -and $serverStartedAt -and $serverProcess.StartTime -eq $serverStartedAt) {
      $taskkill = Get-Command taskkill -ErrorAction SilentlyContinue
      if ($taskkill) {
        & taskkill /PID $serverPid /T /F *> $null
      } else {
        Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
      }
    }
    $script:cleanedServer = -not [bool](Get-Process -Id $serverPid -ErrorAction SilentlyContinue)
  }

  # 只删除本轮创建的路由文件与目录
  if ($routeCreated) {
    if (Test-Path -LiteralPath $routeFile) { Remove-Item -LiteralPath $routeFile -Force }
    if (Test-Path -LiteralPath $routeDir) { Remove-Item -LiteralPath $routeDir -Force }
  }
  $script:cleanedRoute = -not (Test-Path -LiteralPath $routeDir)

  # 不整目录清空 .next：只处理引用了临时预览路由的类型生成物
  # （启动前已存在的文件按快照写回；本轮新建的文件删除），并恢复 next-env.d.ts
  if ($routeCreated) {
    foreach ($typeRoot in $typeRoots) {
      if (-not (Test-Path -LiteralPath $typeRoot)) { continue }
      Get-ChildItem -LiteralPath $typeRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*.ts" } |
        ForEach-Object {
          $content = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
          if ($content -match "guide-preview-class") {
            if ($typeSnapshot.ContainsKey($_.FullName)) {
              [System.IO.File]::WriteAllBytes($_.FullName, $typeSnapshot[$_.FullName])
            } else {
              Remove-Item -LiteralPath $_.FullName -Force
            }
          }
        }
    }
    # Build may remove a previously existing file completely; restore those too.
    foreach ($entry in $typeSnapshot.GetEnumerator()) {
      $parent = Split-Path -Parent $entry.Key
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      [System.IO.File]::WriteAllBytes($entry.Key, $entry.Value)
    }
    if ($null -ne $nextEnvSnapshot -and (Test-Path -LiteralPath $nextEnvPath -PathType Leaf)) {
      [System.IO.File]::WriteAllBytes($nextEnvPath, $nextEnvSnapshot)
    }
  }

  $audit = [ordered]@{
    runner_pid        = $runnerPid
    server_pid        = $serverPid
    server_started_at = if ($serverStartedAt) { $serverStartedAt.ToString("o") } else { $null }
    port              = $Port
    base_url          = $baseUrl
    route_dir         = $routeDir
    route_created     = $routeCreated
    route_cleaned     = $script:cleanedRoute
    server_cleaned    = $script:cleanedServer
    out_dir           = $OutDir
    check_exit        = $checkExit
  }
  $audit | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir "acceptance-run.json") -Encoding utf8
  Write-Output "audit: $(Join-Path $OutDir 'acceptance-run.json')"
}

exit $checkExit
