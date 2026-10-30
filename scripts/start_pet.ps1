$ErrorActionPreference = "SilentlyContinue"
$pyw = @("E:\anaconda\pythonw.exe", "C:\Users\busu\AppData\Local\Doubao\User Data\sandbox_runtime\bases\c98c5042338ed152c6f10ecd8591889f\python\pythonw.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pyw) { $pyw = "pythonw" }
$procs = @(Get-Process pythonw -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*求职桌宠*" })
if ($procs.Count -eq 0) {
  Start-Process $pyw -ArgumentList "D:\notInDesk\报名\工作\求职智能体\scripts\pet.py"
}