import { Settings, Home, User, Sparkles, LogOut, History, Wifi } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';

interface HeaderProps {
  onNavigate: (path: string) => void;
  showBack?: boolean;
  connected?: boolean;
}

export const Header = ({ onNavigate, showBack = false, connected = false }: HeaderProps) => {
  const { currentUser, setShowSettings, setCurrentUser } = useGameStore();

  const handleLogout = () => {
    setCurrentUser(null);
    onNavigate('/');
  };

  return (
    <header className="sticky top-0 z-50">
      <div 
        className="absolute inset-0 backdrop-blur-2xl"
        style={{
          background: 'linear-gradient(180deg, rgba(15, 10, 30, 0.95) 0%, rgba(15, 10, 30, 0.85) 50%, rgba(15, 10, 30, 0.7) 100%)',
        }}
      />
      <div className="relative border-b border-wolf-purple/12">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {showBack && (
              <button
                onClick={() => onNavigate('/')}
                className="p-2.5 rounded-xl hover:bg-white/8 transition-all duration-300 group relative overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-wolf-purple/15 to-wolf-purple-light/8 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <Home className="w-5 h-5 text-wolf-text group-hover:text-wolf-purple-light group-hover:scale-110 transition-all duration-300 relative z-10" />
              </button>
            )}
            <div 
              className="flex items-center gap-3 cursor-pointer group"
              onClick={() => onNavigate('/')}
            >
              <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-br from-wolf-purple to-wolf-purple-light rounded-xl blur-xl opacity-30 group-hover:opacity-50 transition-opacity duration-500" />
                <div className="relative w-11 h-11 bg-gradient-to-br from-wolf-purple to-wolf-purple-light rounded-xl flex items-center justify-center border border-wolf-purple-light/30 group-hover:scale-110 transition-transform duration-300 shadow-lg shadow-wolf-purple/20">
                  <span className="text-xl">🐺</span>
                </div>
                <div className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-yellow-400 rounded-full animate-pulse shadow-lg shadow-yellow-400/50" />
              </div>
              <div className="group-hover:translate-x-0.5 transition-transform duration-300">
                <h1 className="text-xl font-bold bg-gradient-to-r from-white via-wolf-purple-light to-white bg-clip-text text-transparent animate-text-shimmer">
                  狼人杀游戏厅
                </h1>
                <p className="text-xs text-wolf-text/50 flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-wolf-purple-light" />
                  AI-powered Werewolf
                </p>
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-2" aria-label="主导航">
            <span className={`connection-pill ${connected ? 'is-online' : ''}`}><Wifi size={15} aria-hidden="true" /> {connected ? '服务在线' : '等待连接'}</span>
            <button className="header-action" onClick={() => onNavigate('/reviews')}><History size={17} aria-hidden="true" /> <span>复盘</span></button>
            <button className="header-action" onClick={() => setShowSettings(true)}><Settings size={17} aria-hidden="true" /> <span>设置</span></button>
            {currentUser ? (
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-full bg-gradient-to-r from-wolf-purple/12 to-wolf-purple-light/6 backdrop-blur-xl border border-wolf-purple/20 hover:border-wolf-purple/35 transition-all duration-300 group">
                <div className="relative">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-wolf-purple/40 to-wolf-purple-light/30 flex items-center justify-center border border-wolf-purple/30 group-hover:scale-110 transition-transform duration-300">
                    <User className="w-4 h-4 text-wolf-text" />
                  </div>
                  <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full border-2 border-[#1a132e] shadow-lg shadow-green-400/50" />
                </div>
                <span className="text-sm font-medium text-wolf-text header-user-name">{currentUser.name}</span>
                <button
                  onClick={handleLogout}
                  className="p-1.5 rounded-lg hover:bg-white/10 transition-colors group/btn"
                  title="退出登录"
                >
                  <LogOut className="w-4 h-4 text-wolf-text/60 group-hover/btn:text-wolf-text transition-colors" />
                </button>
              </div>
            ) : (
              <div className="text-sm text-wolf-text/40 px-4 py-2.5 rounded-full bg-white/4">未登录</div>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
};
