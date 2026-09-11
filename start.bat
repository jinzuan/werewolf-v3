@echo off
chcp 65001 >nul
echo ==============================================
echo          AI狼人杀游戏厅 - 启动脚本
echo ==============================================
echo.
echo 正在启动开发服务器...
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo 检测到首次运行，正在安装依赖...
    echo.
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo.
    echo 依赖安装成功！
    echo.
)

echo 启动开发服务器...
echo 服务器地址: http://localhost:5173
echo.
echo 按 Ctrl+C 停止服务器
echo.

npm run dev

pause