import { ArrowRight, DoorOpen, Radio } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { sceneForRoom } from '../../features/room-shell/scene';
import { roomPath } from '../../app/routes/roomRouting';
import { useV3Store } from '../../stores/v3Store';
import { readPlayerNickname, writePlayerNickname } from '../../runtime/playerProfile';
import { phaseAssetMap } from '../../ui/assetRegistry';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import type { RoomStatus, RoomSummaryV31 as RoomSummary } from '../../../shared/roomContract';
import { roomModeLabel } from '../../v3/presentation';
import villageScene from '../../assets/v31/village-scene.svg';

const roomState: Record<RoomStatus, { label: string; tone: 'gold' | 'neutral' | 'warning' | 'success' | 'info' }> = {
  waiting: { label: '等待入座', tone: 'gold' },
  ready_check: { label: '等待准备', tone: 'warning' },
  starting: { label: '正在开局', tone: 'info' },
  playing: { label: '对局中', tone: 'info' },
  ended: { label: '对局结束', tone: 'neutral' },
};

const roomStateDetail = (status: RoomStatus, readyCount: number, playerCount: number): string => {
  if (status === 'ready_check') return `${readyCount} / ${playerCount} 人已准备`;
  if (status === 'starting') return '正在同步开局状态';
  if (status === 'playing') return '可以进入观战';
  if (status === 'ended') return '本局已结束';
  return '等待玩家入座';
};

export function LobbyPage() {
  const navigate = useNavigate();
  const connected = useV3Store((state) => state.connected);
  const error = useV3Store((state) => state.error);
  const rooms = useV3Store((state) => state.rooms);
  const refreshRooms = useV3Store((state) => state.refreshRooms);
  const loadMoreRooms = useV3Store((state) => state.loadMoreRooms);
  const roomsNextCursor = useV3Store((state) => state.roomsNextCursor);
  const roomsLoading = useV3Store((state) => state.roomsLoading);
  const loading = useV3Store((state) => state.loading);
  const joinRoom = useV3Store((state) => state.joinRoom);
  const spectateRoom = useV3Store((state) => state.spectateRoom);
  const [joiningCode, setJoiningCode] = useState<string | null>(null);

  const enterPublicRoom = async (room: RoomSummary) => {
    if (joiningCode || loading) return;
    setJoiningCode(room.roomCode);
    const name = writePlayerNickname(readPlayerNickname());
    const accepted = room.status === 'playing'
      ? await spectateRoom(name, room.roomCode, '')
      : await joinRoom(name, room.roomCode, '');
    setJoiningCode(null);
    if (accepted) navigate(roomPath(room.roomCode), { replace: true });
  };

  return (
    <AppShell title="大厅" eyebrow="狼人杀·月光森林" connected={connected}>
      <section className="v3-lobby-hero" aria-labelledby="lobby-hero-title">
        <div className="v3-lobby-hero__copy">
          <span className="v3-lobby-hero__eyebrow">月影村 · 今夜开席</span>
          <h1 id="lobby-hero-title">邀请朋友，点亮一局狼人杀</h1>
          <p>先选人数和角色，再把房间码发给同伴。房间会在开局前同步最新设置。</p>
          <div className="v3-lobby-hero__actions">
            <Button size="action" onClick={() => navigate('/rooms/new/settings')}>
              创建房间<ArrowRight size={17} />
            </Button>
            <Button variant="secondary" onClick={() => navigate('/rooms/join')}>
              <DoorOpen size={17} />加入房间
            </Button>
          </div>
        </div>
        <img className="v3-lobby-hero__moon" src={phaseAssetMap.lobby.src} alt="月光森林的月相" />
      </section>

      {error ? <div className="v3-alert v3-alert--error" role="alert">{error}</div> : null}

      <section className="v3-section" aria-labelledby="room-list-title">
        <header className="v3-section__header">
          <div>
            <span>村口灯火</span>
            <h2 id="room-list-title">房间列表</h2>
          </div>
          <div className="v3-lobby-list-status">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Radio size={13} />{connected ? '连接正常' : '正在连接'}
            </Badge>
            <Button variant="quiet" disabled={roomsLoading} onClick={() => void refreshRooms()}>刷新列表</Button>
          </div>
        </header>

        <div className="v3-room-list">
          {rooms.length === 0 ? (
            <Card className="v3-empty-state">
              <img className="v3-empty-state__art" src={villageScene} alt="" aria-hidden="true" />
              <strong>村口还没有亮灯的房间</strong>
              <span>创建一间朋友房，邀请同伴入座。</span>
              <div className="v3-empty-state__actions">
                <Button onClick={() => navigate('/rooms/new/settings')}>创建第一个房间</Button>
                <Button variant="quiet" onClick={() => navigate('/rooms/join')}>输入房间码</Button>
              </div>
            </Card>
          ) : rooms.map((room) => {
            const state = roomState[room.status];
            const scene = sceneForRoom(room.status);
            const isPlaying = room.status === 'playing';
            return (
              <Card key={room.roomCode} className="v3-room-row">
                <div className="v3-room-row__mark">
                  <img src={phaseAssetMap[scene].src} alt="" aria-hidden="true" />
                </div>
                <div className="v3-room-row__body">
                  <strong>{room.roomName}</strong>
                  <span>{roomModeLabel(room.mode)} · {room.roomCode} · {room.onlineCount} 人在线 · {roomStateDetail(room.status, room.readyCount, room.playerCount)}</span>
                </div>
                <span className="v3-numeric">{room.playerCount} / {room.maxPlayers} 人</span>
                <Badge tone={state.tone}>{state.label}</Badge>
                {room.status !== 'ended' ? (
                  <Button
                    variant="secondary"
                    aria-label={`${isPlaying ? '进入' : '加入'}${room.roomName}`}
                    disabled={joiningCode !== null || loading}
                    onClick={() => void enterPublicRoom(room)}
                  >
                    {joiningCode === room.roomCode ? '正在进入…' : isPlaying ? '进入观战' : '直接加入'}<ArrowRight size={17} />
                  </Button>
                ) : null}
              </Card>
            );
          })}
        </div>
        {roomsNextCursor ? (
          <div className="v3-section__footer">
            <Button variant="secondary" disabled={roomsLoading} onClick={() => void loadMoreRooms()}>
              {roomsLoading ? '正在载入……' : '载入下一页'}<ArrowRight size={17} />
            </Button>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
