import { Bot, KeyRound, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { createOnlineRoom, getServerUrl, joinOnlineRoom, setServerUrl } from '../net/socket';
import { saveOnlineMeta } from '../net/roomMeta';

interface LobbyHomeProps { onNavigate: (path: string) => void; onSettings: () => void; }
interface RecentRoom { code: string; name: string; token: string; role: string; }
type JoinResult = { ok: boolean; message?: string; roomCode?: string; playerId?: string; spectatorId?: string; token?: string };

export function LobbyHome({ onNavigate }: LobbyHomeProps) {
  const [name, setName] = useState(() => localStorage.getItem('wolf-online-name') || '');
  const [roomName, setRoomName] = useState('月影审判厅');
  const [roomCode, setRoomCode] = useState('');
  const [token, setToken] = useState('');
  const [spectator, setSpectator] = useState(false);
  const [server, setServer] = useState(getServerUrl());
  const [players, setPlayers] = useState(8);
  const [aiCount, setAiCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => { try { return JSON.parse(localStorage.getItem('wolf-recent-rooms') || '[]') as RecentRoom[]; } catch { return []; } });

  const nickname = name.trim() || '无名侦探';
  const run = async (action: () => Promise<JoinResult>) => {
    setBusy(true); setError(''); setServerUrl(server.trim());
    try {
      const result = await action();
      if (!result.ok || !result.roomCode) { setError(result.message || '操作未完成，请检查服务连接'); return; }
      const id = result.playerId || result.spectatorId || '';
      saveOnlineMeta(result.roomCode, { playerId: id, name: nickname, spectator: Boolean(result.spectatorId), token: result.token || token });
      const nextRoom: RecentRoom = { code: result.roomCode, name: roomName, token: result.token || token, role: result.spectatorId ? '观战' : '玩家' };
      const nextRooms = [nextRoom, ...recentRooms.filter(room => room.code !== result.roomCode)].slice(0, 4);
      setRecentRooms(nextRooms); localStorage.setItem('wolf-recent-rooms', JSON.stringify(nextRooms));
      localStorage.setItem('wolf-online-name', nickname);
      onNavigate(`/online-room/${result.roomCode}`);
    } catch { setError('无法连接大厅，请确认服务端已启动'); } finally { setBusy(false); }
  };

  return <div className="lobby-content">
    <section className="lobby-hero">
      <p className="eyebrow"><Sparkles size={14} /> 一场推理，从入座开始</p>
      <h1>今晚，谁在<br /><em>编织谎言？</em></h1>
      <p className="hero-copy">创建一间属于你的审判厅，或输入房间码加入正在进行的推理。</p>
      <div className="hero-rule"><span>大厅 · STAGE 01</span><i /></div>
    </section>

    <section className="lobby-grid" aria-label="房间操作">
      <Card className="lobby-card--create">
        <div className="card-heading"><span className="icon-badge"><Plus size={21} /></span><div><p className="eyebrow">主持一局</p><h2>创建房间</h2></div></div>
        <label>你的昵称<Input value={name} onChange={e => setName(e.target.value)} placeholder="例如：夜行者" maxLength={20} /></label>
        <label>房间名称<Input value={roomName} onChange={e => setRoomName(e.target.value)} maxLength={24} /></label>
        <div className="field-row"><label>总人数<strong>{players} 人</strong><input type="range" min="4" max="12" value={players} onChange={e => { const value = Number(e.target.value); setPlayers(value); setAiCount(Math.min(aiCount, value - 1)); }} /></label><label>AI 玩家<strong>{aiCount} 人</strong><input type="range" min="0" max={players - 1} value={aiCount} onChange={e => setAiCount(Number(e.target.value))} /></label></div>
        <div className="room-options"><label className="option-toggle"><input type="checkbox" checked={reviewEnabled} onChange={e => setReviewEnabled(e.target.checked)} /><span>局后复盘</span><small>保留本局推理记录</small></label><label className="option-toggle"><input type="checkbox" checked={debugMode} onChange={e => setDebugMode(e.target.checked)} /><span>调试模式</span><small>仅房主可见上帝视角</small></label></div>
        <Button className="button-wide" disabled={busy} onClick={() => run(() => createOnlineRoom({ roomName, maxPlayers: players, aiCount, name: nickname, reviewEnabled, debugMode }))}>创建审判厅 <span>→</span></Button>
      </Card>

      <Card className="lobby-card--join">
        <div className="card-heading"><span className="icon-badge icon-badge--blue"><KeyRound size={21} /></span><div><p className="eyebrow">已有邀请</p><h2>加入房间</h2></div></div>
        <label>房间码<Input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="例如：A7K2P" maxLength={5} className="code-input" /></label>
        <label>进入令牌<Input value={token} onChange={e => setToken(e.target.value)} placeholder="向房主索要令牌" /></label>
        <div className="join-modes" role="group" aria-label="加入身份"><button className={!spectator ? 'is-selected' : ''} onClick={() => setSpectator(false)} type="button">玩家入座</button><button className={spectator ? 'is-selected' : ''} onClick={() => setSpectator(true)} type="button">观战席</button></div>
        <div className="join-note"><span /> 进行中的房间会自动以观战身份进入</div>
        <Button variant="secondary" className="button-wide" disabled={busy || !roomCode.trim() || !token.trim()} onClick={() => run(() => joinOnlineRoom(roomCode, nickname, spectator, token))}>加入这场推理 <span>→</span></Button>
      </Card>
    </section>

    <div className="lobby-tools"><button onClick={() => run(() => createOnlineRoom({ roomName: 'AI 观战厅', maxPlayers: 12, aiCount: 12, name: nickname, auto: true, reviewEnabled: false }) )}><Bot size={17} /> 快速观战一局 AI 自跑</button><label>服务端地址 <input value={server} onChange={e => setServer(e.target.value)} onBlur={() => setServerUrl(server.trim())} /></label></div>
    {recentRooms.length > 0 && <section className="recent-rooms"><div className="recent-heading"><div><p className="eyebrow">你的足迹</p><h2>最近房间</h2></div><button onClick={() => { setRecentRooms([]); localStorage.removeItem('wolf-recent-rooms'); }}>清除记录</button></div><div className="recent-list">{recentRooms.map(room => <button key={room.code} className="recent-room" onClick={() => { setRoomCode(room.code); setToken(room.token); }}><span className="recent-room-mark">{room.role === '观战' ? '◌' : '#'}</span><span><strong>{room.name}</strong><small>{room.code} · {room.role}</small></span><span className="recent-arrow">→</span></button>)}</div></section>}
    {error && <p className="lobby-error" role="alert">{error}</p>}
  </div>;
}
