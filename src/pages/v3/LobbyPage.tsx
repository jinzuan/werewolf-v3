import { ArrowRight, Bot, DoorOpen, Plus, Radio, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Modal } from '../../ui/Modal';
import type { RoomStatus } from '../../../shared/roomContract';

const roomState: Record<RoomStatus, { label: string; tone: 'gold' | 'purple' | 'neutral' | 'warning' }> = {
  waiting: { label: '等待中', tone: 'gold' as const },
  ready_check: { label: '等待准备', tone: 'warning' as const },
  starting: { label: '正在开局', tone: 'purple' as const },
  playing: { label: '进行中', tone: 'purple' as const },
  ended: { label: '已结束', tone: 'neutral' as const },
};

export function LobbyPage() {
  const navigate = useNavigate();
  const connected = useV3Store((state) => state.connected);
  const loading = useV3Store((state) => state.loading);
  const error = useV3Store((state) => state.error);
  const rooms = useV3Store((state) => state.rooms);
  const refreshRooms = useV3Store((state) => state.refreshRooms);
  const createRoom = useV3Store((state) => state.createRoom);
  const joinRoom = useV3Store((state) => state.joinRoom);
  const spectateRoom = useV3Store((state) => state.spectateRoom);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('玩家');
  const [roomName, setRoomName] = useState('V3 竞技房');
  const [roomCode, setRoomCode] = useState('');
  const [joinToken, setJoinToken] = useState('');

  const enterRoom = async (spectator: boolean) => {
    const ok = spectator
      ? await spectateRoom(name, roomCode, joinToken)
      : await joinRoom(name, roomCode, joinToken);
    if (ok) {
      const code = useV3Store.getState().session?.roomCode;
      if (code) navigate(`/room/${code}`);
    }
  };

  const create = async (auto: boolean) => {
    const ok = await createRoom(name, roomName, auto);
    const code = useV3Store.getState().session?.roomCode;
    if (ok && code) navigate(`/room/${code}`);
  };

  return (
    <AppShell title="竞技大厅" eyebrow="狼人杀 V3" connected={connected}>
      <div className="v3-page-heading">
        <div>
          <span>房间与快速入口</span>
          <h1>竞技大厅</h1>
        </div>
        <Badge tone={connected ? 'success' : 'warning'}>
          <Radio size={13} />{connected ? '服务在线' : '正在连接'}
        </Badge>
      </div>

      {error ? <div className="v3-alert v3-alert--error">{error}</div> : null}

      <div className="v3-lobby-layout">
        <section className="v3-section">
          <header className="v3-section__header">
            <div>
              <h2>房间列表</h2>
              <p>列表来自 V3 服务端的脱敏房间摘要。</p>
            </div>
            <Button variant="quiet" onClick={() => void refreshRooms()}>刷新</Button>
          </header>
          <div className="v3-room-list">
            {rooms.length === 0 ? (
              <Card className="v3-empty-state">
                <Users size={22} />
                <strong>当前没有可见房间</strong>
                <span>创建普通房或快速 AI 房开始一局。</span>
              </Card>
            ) : rooms.map((room) => {
              const state = roomState[room.status];
              return (
                <Card key={room.roomCode} className="v3-room-row">
                  <div className="v3-room-row__mark"><Users size={20} /></div>
                  <div className="v3-room-row__body">
                    <strong>{room.roomName}</strong>
                    <span>{room.roomCode} · {room.spectatorCount} 人观战</span>
                  </div>
                  <span className="v3-numeric">{room.playerCount} / {room.maxPlayers}</span>
                  <Badge tone={state.tone}>{state.label}</Badge>
                  <Button
                    variant="icon"
                    aria-label={`填写${room.roomName}房间码`}
                    title="填写房间码"
                    onClick={() => setRoomCode(room.roomCode)}
                  >
                    <ArrowRight size={18} />
                  </Button>
                </Card>
              );
            })}
          </div>
        </section>

        <aside className="v3-lobby-actions">
          <Card>
            <div className="v3-card-heading">
              <DoorOpen size={20} />
              <div>
                <h2>加入房间</h2>
                <p>房间码与进入令牌均由服务端校验。</p>
              </div>
            </div>
            <label className="v3-field">
              <span>显示名称</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="v3-field">
              <span>房间码</span>
              <Input value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="6 位房间码" />
            </label>
            <label className="v3-field">
              <span>进入令牌</span>
              <Input value={joinToken} onChange={(event) => setJoinToken(event.target.value)} placeholder="由房主提供" />
            </label>
            <div className="v3-action-stack">
              <Button disabled={loading || !roomCode || !joinToken} onClick={() => void enterRoom(false)}>
                加入对局<ArrowRight size={17} />
              </Button>
              <Button variant="secondary" disabled={loading || !roomCode || !joinToken} onClick={() => void enterRoom(true)}>
                公开观战
              </Button>
            </div>
          </Card>

          <Card>
            <div className="v3-card-heading">
              <Plus size={20} />
              <div>
                <h2>创建房间</h2>
                <p>普通房等待房主开局，AI 房创建后自动运行。</p>
              </div>
            </div>
            <div className="v3-action-stack">
              <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                <Users size={17} />创建普通房
              </Button>
              <Button disabled={loading} onClick={() => void create(true)}>
                <Bot size={17} />创建快速 AI 房
              </Button>
            </div>
          </Card>
        </aside>
      </div>

      <Modal
        open={createOpen}
        title="创建普通房"
        context="创建结果与房间令牌来自 V3 服务端。"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button disabled={loading || !name.trim() || !roomName.trim()} onClick={() => void create(false)}>
              创建并进入
            </Button>
          </>
        }
      >
        <label className="v3-field">
          <span>显示名称</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="v3-field">
          <span>房间名称</span>
          <Input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
        </label>
      </Modal>
    </AppShell>
  );
}
