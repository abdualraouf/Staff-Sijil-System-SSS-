@echo off
chcp 65001 > nul
title نظام سجل الموظفين المحمول (SSS)

:: محاولة التشغيل بدون نافذة طرفية سوداء عبر pythonw
start "" pythonw "%~dp0employee_system\main.py"
if %errorlevel% neq 0 (
    start "" python "%~dp0employee_system\main.py"
)
