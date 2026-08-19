import { ArrowLeft, ArrowRight, DoorOpen, Eye, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { roomPath } from '../../app/routes/roomRouting';
import { AppShell } from '../../components/shell/AppShell';
import { useV3Store } from '../../stores/v3Store';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Modal } from '../../ui/Modal';
import { readPlayerNickname, writePlayerNickname } from '../../runtime/playerProfile';
import { joinActionLabel, joinIntentFromQuery, normalizeJoinCode, type JoinIntent } from './model';

export function JoinRoomPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const connected = useV3Store((state) => state.connected);
  const loading = useV3Store((state) => state.loading);
  const error = useV3Store((state) => state.error);
  const joinRoom = useV3Store((state) => state.joinRoom);
  const spectateRoom = useV3Store((state) => state.spectateRoom);
  const clearError = useV3Store((state) => state.clearError);
  const [intent, setIntent] = useState<JoinIntent>(() => joinIntentFromQuery(searchParams.get('intent')));
  const [name, setName] = useState(() => readPlayerNickname());
  const [roomCode, setRoomCode] = useState(() => normalizeJoinCode(searchParams.get('code')));
  const [joinPassword, setJoinPassword] = useState('');

  useEffect(() => {
    const code = normalizeJoinCode(searchParams.get('code'));
    const rawIntent = searchParams.get('intent');
    const nextIntent = joinIntentFromQuery(rawIntent);
    setRoomCode(code);
    setIntent(nextIntent);

    // A join URL may prefill only public routing hints. Replace the current
    // history entry so credentials accidentally pasted into a link cannot
    // remain in the address bar, hash, or browser history.
    const safeParams = new URLSearchParams();
    if (code) safeParams.set('code', code);
    if (rawIntent === 'play' || rawIntent === 'watch') safeParams.set('intent', rawIntent);
    const safeSearch = safeParams.toString();
    if (location.search !== (safeSearch ? `?${safeSearch}` : '') || location.hash) {
      navigate(
        { pathname: location.pathname, search: safeSearch ? `?${safeSearch}` : '', hash: '' },
        { replace: true },
      );
    }
  }, [location.hash, location.pathname, location.search, navigate, searchParams]);

  const enter = async (nextIntent: JoinIntent) => {
    const code = normalizeJoinCode(roomCode);
    const playerName = writePlayerNickname(name);
    setName(playerName);
    setIntent(nextIntent);
    clearError();
    const accepted = nextIntent === 'watch'
      ? await spectateRoom(playerName, code, joinPassword)
      : await joinRoom(playerName, code, joinPassword);
    if (accepted) navigate(roomPath(code), { replace: true });
  };

  const watchIntent = intent === 'watch';
  const playerSeatFull = Boolean(error?.includes('玩家席已满'));
  return (
    <AppShell title={watchIntent ? '进入观战' : '加入房间'} eyebrow="村口入口" connected={connected}>
      <div className="v3-join-page">
        <Card className="v3-join-card" aria-labelledby="join-room-title">
          <div className="v3-card-heading">
            {watchIntent ? <Eye size={22} aria-hidden="true" /> : <DoorOpen size={22} aria-hidden="true" />}
            <div>
              <span className="v3-join-card__eyebrow">{watchIntent ? '公开信息' : '邀请入座'}</span>
              <h1 id="join-room-title">{watchIntent ? '进入一间正在进行的房间' : '用房间码找到同伴'}</h1>
              <p>{watchIntent ? '观战只会显示所有玩家都能得知的公开信息。' : '填写房间码和邀请口令，服务端会为你安排一个席位。'}</p>
            </div>
          </div>

          {/* Keep this node mounted. A changing store error must not replace the
              form sibling and make mobile browsers blur the active input. */}
          <div className="v3-alert v3-alert--error" role="alert" hidden={!error}>
            {error}
          </div>

          <form className="v3-join-form" onSubmit={(event) => { event.preventDefault(); void enter(intent); }}>
            <label className="v3-field">
              <span>显示名称</span>
              <Input value={name} maxLength={16} autoComplete="nickname" onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="v3-field">
              <span>房间码</span>
              <Input value={roomCode} inputMode="text" autoComplete="off" placeholder="例如 ABC123" onChange={(event) => setRoomCode(normalizeJoinCode(event.target.value))} />
            </label>
            <label className="v3-field">
              <span>邀请口令{watchIntent ? '（公开观战按房间设置决定是否需要）' : '（公开房间可留空）'}</span>
              <Input type="password" value={joinPassword} autoComplete="off" placeholder="可选；仅凭邀请房需要" onChange={(event) => setJoinPassword(event.target.value)} />
            </label>

            <div className="v3-join-form__actions">
              <Button type="submit" size="action" disabled={loading || !name.trim() || !roomCode}>
                {loading ? '正在进入……' : joinActionLabel(intent)}<ArrowRight size={17} />
              </Button>
              {intent === 'play' ? (
                <Button type="button" variant="secondary" disabled={loading || !name.trim() || !roomCode} onClick={() => void enter('watch')}>
                  <Eye size={17} />改为观战
                </Button>
              ) : (
                <Button type="button" variant="secondary" disabled={loading || !name.trim() || !roomCode} onClick={() => void enter('play')}>
                  <KeyRound size={17} />改为加入
                </Button>
              )}
            </div>
          </form>
        </Card>
        <Button variant="quiet" aria-label="退出加入房间" onClick={() => navigate('/lobby')}><ArrowLeft size={17} />退出</Button>
        <Modal
          open={playerSeatFull}
          title="玩家已满"
          context="这间房间暂时没有可用的玩家位置。观战不占用玩家席，房主也可以从席位菜单移出玩家。"
          onClose={clearError}
        >
          <div className="v3-action-stack">
            <Button variant="secondary" onClick={() => { clearError(); setIntent('watch'); void enter('watch'); }}>
              <Eye size={17} />尝试进入观战
            </Button>
            <Button variant="quiet" onClick={() => { clearError(); navigate('/lobby'); }}>退出</Button>
          </div>
        </Modal>
      </div>
    </AppShell>
  );
}
