@echo off
chcp 65001 > nul
title بناء النسخة المحمولة - نظام سجل الموظفين
echo جاري بناء الحزمة المحمولة لنظام سجل الموظفين...
cd /d "%~dp0"
pyinstaller --noconsole --onedir --add-data "frontend;frontend" --name "StaffSijilSystem" main.py
echo تم الانتهاء من التجميع! تجد المجلد المحمول داخل مجلد dist/StaffSijilSystem
pause
