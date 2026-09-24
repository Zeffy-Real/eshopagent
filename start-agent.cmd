@echo off
rem 一键启动（双击本文件即可）：调用 scripts\start-agent.ps1
rem -NoProfile 跳过个人配置文件，-ExecutionPolicy Bypass 避免「脚本被禁止运行」而无法启动
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-agent.ps1"