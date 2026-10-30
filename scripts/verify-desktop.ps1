#requires -Version 5.1
<#
.SYNOPSIS
  墨匣 · 桌面包冒烟验证：启动 `npx electron .`，等待窗口渲染后截图，再关闭进程。

.DESCRIPTION
  用于在没有人工介入的情况下证明「窗口能开、界面渲染出来了（不是白屏）」。
  实现方式：P/Invoke user32!PrintWindow(PW_RENDERFULLCONTENT) 抓取窗口位图。
  截图默认输出到 build/screenshot-desktop.png（build/ 属于桌面壳的写入边界）。

.PARAMETER Dist
  先跑一次 vite build（默认不跑；dist 不存在时自动跑）。

.PARAMETER OutputPath
  截图输出路径。

.PARAMETER TimeoutSeconds
  等待窗口出现的上限秒数。

.EXAMPLE
  pwsh -File scripts/verify-desktop.ps1 -Dist
#>
[CmdletBinding()]
param(
  [switch]$Dist,
  [string]$OutputPath,
  [int]$TimeoutSeconds = 30,
  [int]$KeepAliveSeconds = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not $OutputPath) { $OutputPath = Join-Path $root 'build\screenshot-desktop.png' }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null

$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) {
  throw "找不到 Electron 可执行文件：$electronExe（请先运行 node node_modules/electron/install.js）"
}

if ($Dist -or -not (Test-Path (Join-Path $root 'dist\index.html'))) {
  Write-Host '[verify] 构建 dist/ …' -ForegroundColor Cyan
  & npx vite build
  if ($LASTEXITCODE -ne 0) { throw "vite build 失败（exit $LASTEXITCODE）" }
}

$logDir = Join-Path $env:TEMP 'inkbox-verify'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdoutLog = Join-Path $logDir 'electron.out.log'
$stderrLog = Join-Path $logDir 'electron.err.log'
Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- 互操作
Add-Type -AssemblyName System.Drawing

if (-not ('InkboxWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class InkboxWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

    public static string TitleOf(IntPtr hWnd)
    {
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return string.Empty;
        var sb = new System.Text.StringBuilder(len + 2);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
'@ | Out-Null
}

[InkboxWin32]::SetProcessDPIAware() | Out-Null

function Save-WindowShot {
  param([IntPtr]$Handle, [string]$Path)

  $rect = New-Object InkboxWin32+RECT
  if (-not [InkboxWin32]::GetWindowRect($Handle, [ref]$rect)) { throw 'GetWindowRect 失败' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw "窗口尺寸无效：${width}x${height}" }

  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $hdc = $graphics.GetHdc()
      try {
        # 2 = PW_RENDERFULLCONTENT，Chromium/Electron 需要它才能离屏渲染
        $ok = [InkboxWin32]::PrintWindow($Handle, $hdc, 2)
      } finally {
        $graphics.ReleaseHdc($hdc)
      }
    } finally {
      $graphics.Dispose()
    }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
  return [pscustomobject]@{ Width = $width; Height = $height; Printed = $ok }
}

# ---------------------------------------------------------------- 启动
Write-Host '[verify] 启动 Electron …' -ForegroundColor Cyan
$env:ELECTRON_ENABLE_LOGGING = '1'
# 宿主机（如 DSH / VS Code 扩展）可能预设 ELECTRON_RUN_AS_NODE=1，
# 那会让 electron.exe 以纯 Node 模式运行、require('electron') 拿不到 app，必须清掉。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory $root -PassThru `
  -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

Write-Host "[verify] PID=$($proc.Id)"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$handle = [IntPtr]::Zero
$title = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  if ($proc.HasExited) { break }
  $proc.Refresh()
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero -and [InkboxWin32]::IsWindowVisible($proc.MainWindowHandle)) {
    $handle = $proc.MainWindowHandle
    $title = [InkboxWin32]::TitleOf($handle)
    break
  }
}

if ($proc.HasExited) {
  Write-Host "[verify] Electron 已退出（exit=$($proc.ExitCode)）" -ForegroundColor Red
} elseif ($handle -eq [IntPtr]::Zero) {
  Write-Host '[verify] 超时：没有检测到可见窗口' -ForegroundColor Red
} else {
  Write-Host "[verify] 窗口就绪：$title (hwnd=$handle)" -ForegroundColor Green
  # 给 Vue 首帧与字体渲染留出时间，避免截到过渡态
  Start-Sleep -Seconds 3
  try {
    $shot = Save-WindowShot -Handle $handle -Path $OutputPath
    Write-Host "[verify] 截图已保存：$OutputPath ($($shot.Width)x$($shot.Height), PrintWindow=$($shot.Printed))" -ForegroundColor Green
  } catch {
    Write-Host "[verify] 截图失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($KeepAliveSeconds -gt 0 -and -not $proc.HasExited) {
  Start-Sleep -Seconds $KeepAliveSeconds
}

# ---------------------------------------------------------------- 收尾
if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host '[verify] 已关闭 Electron'
}

Write-Host "`n[verify] ---- 主进程 stdout ----" -ForegroundColor Cyan
if (Test-Path $stdoutLog) { Get-Content $stdoutLog -Raw }
Write-Host "[verify] ---- 主进程 stderr ----" -ForegroundColor Cyan
if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw }

$stderrText = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { '' }
if ($stderrText -match 'Unable to load preload|preload-error|did-fail-load|页面加载失败') {
  Write-Host '[verify] 检测到加载/预加载错误，请检查上面的日志' -ForegroundColor Red
  exit 1
}
