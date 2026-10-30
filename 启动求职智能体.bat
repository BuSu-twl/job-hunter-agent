@echo off
chcp 936 >nul
netstat -ano | findstr ":4173 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo 求职智能体服务已在运行
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'D:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'D:\notInDesk\报名\工作\求职智能体' -WindowStyle Hidden"
  echo 求职智能体服务已启动
)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\notInDesk\报名\工作\求职智能体\求职提醒.ps1"