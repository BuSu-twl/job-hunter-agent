$ErrorActionPreference = "SilentlyContinue"
$node = 'D:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$listening = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory 'D:\notInDesk\报名\工作\求职智能体' -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
Start-Process 'http://localhost:4173/'
# 桌宠（无边框透明悬浮，已运行则跳过）
$pyw = 'E:\anaconda\pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = 'pythonw' }
$petRun = Get-Process pythonw -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*求职桌宠*' }
if (-not $petRun) {
  Start-Process $pyw -ArgumentList 'D:\notInDesk\报名\工作\求职智能体\scripts\pet.py'
}