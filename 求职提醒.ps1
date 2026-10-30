# 求职智能体 · 桌面提醒脚本
# 由计划任务定时运行：读取 state.json，发现重要消息时弹出系统通知。
# 相同消息不重复提醒（指纹记录在 data/last_notify.json）。
$ErrorActionPreference = 'SilentlyContinue'
$statePath = 'D:\notInDesk\报名\工作\求职智能体\data\长期记忆\state.json'
$lastPath  = 'D:\notInDesk\报名\工作\求职智能体\data\last_notify.json'
if (-not (Test-Path $statePath)) { exit 0 }

try { $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { exit 0 }
$today = Get-Date -Format 'yyyy-MM-dd'
$messages = New-Object System.Collections.ArrayList
$inv = [System.Globalization.CultureInfo]::InvariantCulture

# 1) 未完成笔试/测评，截止在 2 天内（含今天/已到期）
foreach ($t in @($state.tests)) {
  if ($t.status -ne '未完成' -or -not $t.deadline) { continue }
  $dstr = ([string]$t.deadline -replace 'T.*', '').Trim()
  $dl = $null
  try { $dl = [datetime]::ParseExact($dstr, 'yyyy-MM-dd', $inv) } catch { continue }
  $days = (($dl.Date) - ((Get-Date).Date)).Days
  if ($days -ge -1 -and $days -le 2) {
    $who = [string]$t.subject
    if ($t.company) { $who = "$($t.company) · $($t.subject)" }
    if ($days -le 0) { [void]$messages.Add("笔试截止：$who 截止 $($dl.ToString('M月d日'))（今天/已到期）") }
    else { [void]$messages.Add("笔试截止：$who 截止 $($dl.ToString('M月d日'))，还剩 $days 天") }
  }
}

# 2) 已投递超过 7 天无反馈
foreach ($j in @($state.jobs)) {
  if ($j.status -ne '已投递') { continue }
  $base = $null
  if ($j.updated) { $base = $j.updated } elseif ($j.submitted) { $base = $j.submitted }
  if (-not $base) { continue }
  $dstr = ([string]$base -replace 'T.*', '').Trim()
  $bd = $null
  try { $bd = [datetime]::ParseExact($dstr, 'yyyy-MM-dd', $inv) } catch { continue }
  $days = (((Get-Date).Date) - $bd.Date).Days
  if ($days -gt 7) { [void]$messages.Add("跟进提醒：$($j.company) 已投递 $days 天无反馈，主动询问进度") }
}

# 3) 收件箱待确认
$pending = @($state.inbox | Where-Object { $_.status -eq '待确认' }).Count
if ($pending -gt 0) { [void]$messages.Add("截图待确认：收件箱有 $pending 条记录待确认识别") }

# 4) 今天或已过期的跟进日期
foreach ($j in @($state.jobs)) {
  if ($j.followup -and ([string]$j.followup -le $today)) { [void]$messages.Add("今天该跟进：$($j.company) · $($j.role)") }
}

if ($messages.Count -eq 0) { exit 0 }
$fingerprint = (($messages | Sort-Object) -join '|')
$last = ''
if (Test-Path $lastPath) {
  try { $last = [string](Get-Content $lastPath -Raw -Encoding UTF8 | ConvertFrom-Json).fingerprint } catch { }
}
if ($fingerprint -eq $last) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = '求职智能体 · 重要提醒'
$notify.BalloonTipText = (($messages | Select-Object -First 3) -join "`n")
$notify.Visible = $true
$notify.ShowBalloonTip(15000)
Start-Sleep -Seconds 16
$notify.Dispose()

@{ fingerprint = $fingerprint; time = (Get-Date -Format 'yyyy-MM-dd HH:mm') } | ConvertTo-Json | Set-Content $lastPath -Encoding UTF8