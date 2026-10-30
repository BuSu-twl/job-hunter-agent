$node = 'D:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$listening = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory 'D:\notInDesk\报名\工作\求职智能体' -WindowStyle Hidden
}
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','D:\notInDesk\报名\工作\求职智能体\求职提醒.ps1' -WindowStyle Hidden