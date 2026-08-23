const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Render the small human-facing landing page for the socket server root. */
export const renderServerLandingPage = (
  protocol: 'http' | 'https',
  host: string,
): string => {
  const gameUrl = `${protocol}://${host}:5317/`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>狼人杀服务端</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#eef2ff;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #334155;border-radius:20px;background:#1e293b;box-shadow:0 20px 60px #02061780}h1{margin:0 0 8px;font-size:28px}p{color:#cbd5e1}.ok{display:inline-flex;gap:8px;align-items:center;color:#86efac}.dot{width:10px;height:10px;border-radius:50%;background:#22c55e}.links{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}.links a{padding:10px 16px;border-radius:10px;background:#4f46e5;color:white;text-decoration:none}.links a.secondary{background:#334155}.meta{margin-top:20px;font-size:13px;color:#94a3b8}</style></head><body><main class="card"><div class="ok"><span class="dot"></span>服务端运行正常</div><h1>AI 狼人杀服务端</h1><p>Socket.IO 游戏服务已经启动，可以返回游戏页面继续测试。</p><div class="links"><a href="${escapeHtml(gameUrl)}">进入游戏</a><a class="secondary" href="/health">查看健康状态</a></div><div class="meta">服务：werewolf-v3 · 传输：Socket.IO</div></main></body></html>`;
};
