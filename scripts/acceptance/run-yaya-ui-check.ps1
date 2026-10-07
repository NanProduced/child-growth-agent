# YAYA-UI1 fixture 浏览器验收 runner（组件/交互层，不接真实 API/数据库/模型）
#
# 安全边界（与 G4 runner 同口径）：
# - 不按端口杀进程：端口被占用即失败退出，绝不关闭已有服务。
# - 只清理本轮启动且身份可核实的进程树（PID + StartTime）。
# - 预览路由 src/app/yaya-preview 已存在即拒绝覆盖；只删除本轮创建的文件。
# - 不整目录清空 .next：启动前快照类型生成物与 next-env.d.ts，结束后按文件定向恢复。
#
# 用法：
#   pwsh -NoProfile -File scripts/acceptance/run-yaya-ui-check.ps1 `
#     -Port 3213 -OutDir "$env:TEMP\yaya-ui1-browser"

[CmdletBinding()]
param(
  [int]$Port = 3213,
  [string]$OutDir = "",
  [string]$PlaywrightCoreDir = "",
  [string]$ChromePath = "",
  [int]$ReadyTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$runnerPid = $PID

$scriptDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\.."))
$srcAppDir = Join-Path $repoRoot "src\app"
if (-not (Test-Path -LiteralPath $srcAppDir -PathType Container)) {
  throw "未找到项目 src/app（从脚本位置推导：$srcAppDir）"
}
if (-not $OutDir) { $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) "yaya-ui1-browser" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$routeDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "src\app\yaya-preview"))
$routeFile = Join-Path $routeDir "page.tsx"
$templatePath = Join-Path $scriptDir "yaya-preview-page.template.tsx"
$checkScript = Join-Path $scriptDir "check-yaya-ui.cjs"
$baseUrl = "http://127.0.0.1:$Port/yaya-preview"

foreach ($required in @($templatePath, $checkScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少验收文件：$required" }
}

$pnpm = (Get-Command pnpm -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source

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
  throw "端口 $Port 已被占用：runner 拒绝启动，也不会关闭任何已有服务。请使用 -Port 指定空闲端口。"
}
if (Test-Path -LiteralPath $routeDir) {
  throw "预览路由已存在：$routeDir。拒绝覆盖，未创建或修改任何文件。"
}

$routeCreated = $false
$serverPid = $null
$serverStartedAt = $null
$checkExit = 1
$script:cleanedRoute = $false
$script:cleanedServer = $false

$typeRoots = @(
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".next\types")),
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".next\dev\types"))
)
$typeSnapshot = @{}
foreach ($typeRoot in $typeRoots) {
  if (-not (Test-Path -LiteralPath $typeRoot)) { continue }
  Get-ChildItem -LiteralPath $typeRoot -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*.ts" } |
    ForEach-Object { $typeSnapshot[$_.FullName] = Get-Content -LiteralPath $_.FullName -Raw }
}
$nextEnvPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "next-env.d.ts"))
$nextEnvSnapshot = if (Test-Path -LiteralPath $nextEnvPath -PathType Leaf) {
  Get-Content -LiteralPath $nextEnvPath -Raw
} else {
  $null
}

try {
  New-Item -ItemType Directory -Path $routeDir | Out-Null
  Copy-Item -LiteralPath $templatePath -Destination $routeFile
  $routeCreated = $true

  $serverOut = Join-Path $OutDir "dev-out.log"
  $serverErr = Join-Path $OutDir "dev-err.log"
  $server = Start-Process -FilePath $pnpm `
    -ArgumentList @("exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "$Port") `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -PassThru -WindowStyle Hidden
  $serverPid = $server.Id
  $serverStartedAt = $server.StartTime

  $ready = $false
  $lastError = ""
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri "${baseUrl}?view=panel" -UseBasicParsing -TimeoutSec 10
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) {
    $tail = ""
    if (Test-Path -LiteralPath $serverOut) {
      $tail = (Get-Content -LiteralPath $serverOut -Tail 30 -ErrorAction SilentlyContinue | Out-String)
    }
    throw "dev server 未在 $ReadyTimeoutSeconds 秒内就绪（$baseUrl）。最后错误：$lastError`n日志尾部：`n$tail"
  }

  if ($PlaywrightCoreDir) { $env:YAYA_PW_CORE = [System.IO.Path]::GetFullPath($PlaywrightCoreDir) }
  if ($ChromePath) { $env:CHROME_PATH = [System.IO.Path]::GetFullPath($ChromePath) }

  Write-Output "runner_pid=$runnerPid server_pid=$serverPid base_url=$baseUrl out=$OutDir"
  & $node $checkScript --base-url $baseUrl --out $OutDir
  $checkExit = $LASTEXITCODE
  Write-Output "check exit code: $checkExit"
} finally {
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

  if ($routeCreated) {
    if (Test-Path -LiteralPath $routeFile) { Remove-Item -LiteralPath $routeFile -Force }
    if (Test-Path -LiteralPath $routeDir) { Remove-Item -LiteralPath $routeDir -Force }
  }
  $script:cleanedRoute = -not (Test-Path -LiteralPath $routeDir)

  if ($routeCreated) {
    foreach ($typeRoot in $typeRoots) {
      if (-not (Test-Path -LiteralPath $typeRoot)) { continue }
      Get-ChildItem -LiteralPath $typeRoot -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*.ts" } |
        ForEach-Object {
          $content = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
          if ($content -match "yaya-preview") {
            $snapshot = if ($typeSnapshot.ContainsKey($_.FullName)) { $typeSnapshot[$_.FullName] } else { $null }
            if ($null -ne $snapshot -and $snapshot -notmatch "yaya-preview") {
              Set-Content -LiteralPath $_.FullName -Value $snapshot -Encoding utf8 -NoNewline
            } else {
              # 快照可能已被上一次预览运行污染；这类生成物可重新生成，直接删除。
              Remove-Item -LiteralPath $_.FullName -Force
            }
          }
        }
    }
    if ($null -ne $nextEnvSnapshot -and (Test-Path -LiteralPath $nextEnvPath -PathType Leaf)) {
      $currentNextEnv = Get-Content -LiteralPath $nextEnvPath -Raw
      if ($currentNextEnv -ne $nextEnvSnapshot) {
        Set-Content -LiteralPath $nextEnvPath -Value $nextEnvSnapshot -Encoding utf8 -NoNewline
      }
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
