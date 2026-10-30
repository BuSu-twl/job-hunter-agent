' 隐藏启动求职提醒脚本（避免任务计划运行时闪现控制台窗口）
Set ws = CreateObject("WScript.Shell")
ws.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\notInDesk\报名\工作\求职智能体\求职提醒.ps1""", 0, False
