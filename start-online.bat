@echo off
chcp 65001 >nul
echo ==============================================
echo   AI狼人杀 - 联机模式启动脚本（B批）
echo ==============================================
echo.
echo 启动后：
echo   - 本机浏览器打开 http://localhost:3001 即可玩
echo   - 手机/同局域网设备打开 http://<本机IP>:3001 加入同一房间
echo   - 房主在"联机对战"大厅创建房间，把房间码发给朋友
echo   - AI 由服务端托管（中转地址读 test-ai-config.json）
echo.
echo 首次会先构建前端（npm run build），请耐心等待...
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo 检测到首次运行，正在安装依赖...
    npm install
    if %errorlevel% neq 0 (
        echo 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
)

echo 正在构建前端并启动联机服务...
echo.
npm run server:prod

pause
