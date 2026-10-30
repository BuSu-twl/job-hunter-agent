' 隐藏启动求职智能体主服务（避免登录时闪现控制台窗口）
Set ws = CreateObject("WScript.Shell")
ws.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\notInDesk\报名\工作\求职智能体\启动求职智能体.ps1""", 0, False
