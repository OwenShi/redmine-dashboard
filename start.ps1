# Redmine 个人看板 —— Windows 启动脚本（由 start.bat 调用，也可直接 powershell -File start.ps1）
# 从 %USERPROFILE%\.redmine-cli.yaml 自动读取 server 和 api_key
$ErrorActionPreference = 'Stop'
$cfg = Join-Path $env:USERPROFILE '.redmine-cli.yaml'

if (-not (Test-Path $cfg)) {
  Write-Host "未找到 $cfg"
  Write-Host '请先运行一次 redmine auth login 配置好 redmine CLI'
  Read-Host '按回车退出…'
  exit 1
}

function Read-CfgValue([string]$key) {
  $m = Select-String -Path $cfg -Pattern ("^\s*" + $key + ":\s*(.+)$") | Select-Object -First 1
  if ($null -eq $m) { return '' }
  return $m.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
}

$env:REDMINE_URL = Read-CfgValue 'server'
$env:REDMINE_API_KEY = Read-CfgValue 'api_key'

if ([string]::IsNullOrEmpty($env:REDMINE_API_KEY)) {
  Write-Host "未能从 $cfg 读取 api_key"
  Read-Host '按回车退出…'
  exit 1
}

if (-not $env:PORT) { $env:PORT = '7788' }

Write-Host "启动看板… (Ctrl+C 停止)  http://localhost:$env:PORT"
$node = Start-Process -FilePath 'node' -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.js') + '"') -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow
Start-Sleep -Seconds 2
if (-not $node.HasExited) { Start-Process "http://localhost:$env:PORT" }
try { Wait-Process -Id $node.Id } catch { }
