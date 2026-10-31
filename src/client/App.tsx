import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Flag,
  Globe2,
  HelpCircle,
  Link2,
  LoaderCircle,
  MousePointer2,
  RotateCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import {
  applyAction,
  initializeGame,
  other,
  validateWall,
  type GameState,
  type Wall,
} from '@linebreak/rules';
import { Board } from './Board';
import { api, useMatchmaking, useRoom } from './network';
import { loadLocal, readText, saveLocal, writeText } from './storage';
import { allowOfflineUpdates, useOfflineStatus } from './offline';
import { roomCodeSchema, type OnlineAction } from '../shared/protocol';

function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function Confirm({
  title,
  children,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      onCancel={onCancel}
      aria-labelledby="confirm-title"
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{children}</p>
      <div className="dialog-actions">
        <button className="secondary" onClick={onCancel} autoFocus>
          Keep playing
        </button>
        <button className="danger" onClick={onConfirm}>
          Resign game
        </button>
      </div>
    </dialog>
  );
}
const demo: GameState = {
  ...initializeGame(),
  walls: [
    { orientation: 'horizontal', row: 2, col: 2 },
    { orientation: 'vertical', row: 3, col: 5 },
    { orientation: 'horizontal', row: 5, col: 5 },
  ],
};
export function App() {
  const offline = useOfflineStatus();
  const [path, setPath] = useState(location.pathname),
    [name, setName] = useState(() => readText('linebreak.name'));
  const [local, setLocal] = useState(loadLocal),
    [roomInput, setRoomInput] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const [mode, setMode] = useState<'move' | 'wall'>('move'),
    [orientation, setOrientation] = useState<Wall['orientation']>('horizontal'),
    [preview, setPreview] = useState<Wall | null>(null);
  const [copied, setCopied] = useState(false),
    [resigning, setResigning] = useState(false),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const onPop = () => {
      setPath(location.pathname);
      setError('');
      setPreview(null);
      setMode('move');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const localMode = path === '/local',
    matching = path === '/match',
    code = path.startsWith('/room/') ? (path.split('/')[2]?.toUpperCase() ?? '') : null;
  const online = useRoom(code, name);
  const onMatch = useCallback((id: string) => navigate(`/room/${id}`), []),
    onCancel = useCallback(() => navigate('/'), []);
  const queue = useMatchmaking(matching, name, onMatch, onCancel);
  const state = localMode ? local : (online.snapshot?.game ?? initializeGame()),
    snap = online.snapshot;
  useEffect(() => {
    setPreview(null);
    setError('');
  }, [state.ply, state.turn, snap?.roundId]);
  useEffect(() => {
    if (
      snap?.status === 'cancelled' &&
      snap.kind === 'random' &&
      snap.cancellationReason === 'Opponent did not connect in time.'
    ) {
      setError('Your opponent did not arrive. Finding another player.');
      navigate('/match');
    }
  }, [snap?.status, snap?.kind, snap?.cancellationReason]);
  useEffect(() => {
    allowOfflineUpdates(path === '/' || !!state.winner);
  }, [path, state.winner]);
  const canPlay = localMode
    ? !state.winner
    : !!snap &&
      snap.status === 'active' &&
      online.connected &&
      snap.players.A.connected &&
      !!snap.players.B?.connected &&
      snap.you === state.turn &&
      !online.pending &&
      !online.replaced;
  const submit = (action: OnlineAction) => {
    setError('');
    if (localMode) {
      try {
        const next =
          action.type === 'REQUEST_REMATCH'
            ? initializeGame()
            : action.type === 'CLAIM_DISCONNECT_WIN'
              ? local
              : applyAction(local, local.turn, action);
        setLocal(next);
        saveLocal(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That action is not legal.');
      }
    } else online.send(action);
    setPreview(null);
  };
  const place = (wall: Wall) => {
    if (!canPlay) return;
    const result = validateWall(state, wall);
    if (!result.ok) {
      setError(result.reason);
      setPreview(wall);
      return;
    }
    submit({ type: 'PLACE_WALL', wall });
  };
  const rotate = () => {
    const next = orientation === 'horizontal' ? 'vertical' : 'horizontal';
    setOrientation(next);
    setPreview((p) => (p ? { ...p, orientation: next } : null));
  };
  const enter = async (kind: 'create' | 'join') => {
    setBusy(kind);
    setError('');
    try {
      await api('/session', { name });
      if (kind === 'create') {
        const room = await api<{ code: string }>('/rooms');
        navigate(`/room/${room.code}`);
      } else {
        const normalized = roomInput.trim().toUpperCase().replace(/[\s-]/g, '');
        if (!roomCodeSchema.safeParse(normalized).success)
          throw new Error('Enter the eight-character room code.');
        await api(`/rooms/${normalized}/join`);
        navigate(`/room/${normalized}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setBusy('');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy the room link from your address bar.');
    }
  };
  const players = localMode
    ? { A: { name: 'Player A', connected: true }, B: { name: 'Player B', connected: true } }
    : snap?.players;
  const playerName = (p: 'A' | 'B') => players?.[p]?.name ?? `Player ${p}`;
  const opponent = snap ? other(snap.you) : null,
    disconnectedAt = opponent ? snap?.players[opponent]?.disconnectedAt : null;
  const claimIn = disconnectedAt
    ? Math.max(0, Math.ceil((disconnectedAt + 90000 - clock) / 1000))
    : null;
  const validation = preview ? validateWall(state, preview) : null;
  const isGame = localMode || !!code;
  let status = '';
  if (state.winner) status = `${playerName(state.winner)} wins`;
  else if (!localMode && !snap) status = online.error ? 'Room unavailable' : 'Opening the room…';
  else if (snap?.status === 'waiting')
    status = snap.players.B ? 'Waiting for both players to connect' : 'Waiting for your opponent';
  else if (snap?.status === 'cancelled') status = 'This room has closed';
  else if (
    !localMode &&
    (!online.connected || !snap?.players.A.connected || !snap?.players.B?.connected)
  )
    status = 'Game paused · reconnecting';
  else
    status = localMode
      ? `${playerName(state.turn)}’s turn`
      : snap?.you === state.turn
        ? 'Your move'
        : `${playerName(state.turn)} is thinking`;
  return (
    <div className="app-shell">
      <header className="site-header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          aria-label="Linebreak home"
        >
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7 5v22h20M18 5v12" />
            <circle cx="26" cy="7" r="3" />
          </svg>
          linebreak<span className="brand-period">.</span>
        </a>
        <div className="header-right">
          {isGame ? (
            <button className="text-button" onClick={() => navigate('/')}>
              <ArrowLeft size={16} /> Home
            </button>
          ) : (
            <span className="header-caption">A game of paths & possibilities</span>
          )}
          <a className="text-button" href="#how-to-play">
            <HelpCircle size={17} />
            <span>How to play</span>
          </a>
        </div>
      </header>
      {!isGame && !matching && (
        <main className="home">
          <section className="home-intro">
            <h1>
              Two pawns.
              <br />
              One finish line.
            </h1>
            <p className="lead">
              Find your path. Complicate theirs.
              <br />A quiet board. A beautiful little rivalry.
            </p>
            <div className="name-field">
              <label htmlFor="guest-name">
                Your name <span>optional</span>
              </label>
              <input
                id="guest-name"
                maxLength={24}
                placeholder="Player"
                value={name}
                autoComplete="nickname"
                onChange={(e) => {
                  setName(e.target.value);
                  writeText('linebreak.name', e.target.value);
                }}
              />
            </div>
            <div className="play-options">
              <button className="primary play-main" onClick={() => navigate('/match')}>
                <Globe2 size={20} />
                <span>
                  Find an online match<small>Play someone, somewhere.</small>
                </span>
                <ArrowRight size={20} />
              </button>
              <button
                className="mode-row"
                onClick={() => {
                  setPreview(null);
                  navigate('/local');
                }}
              >
                <Users size={19} />
                <span>
                  {local.ply > 0 && !local.winner ? 'Continue local game' : 'Play on this device'}
                  <small>Two players. One screen. No connection needed.</small>
                </span>
                <ArrowRight size={18} />
              </button>
              <button className="mode-row" disabled={!!busy} onClick={() => void enter('create')}>
                <Link2 size={19} />
                <span>
                  {busy === 'create' ? 'Creating your room…' : 'Invite a friend'}
                  <small>A private room, just for the two of you.</small>
                </span>
                {busy === 'create' ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <ArrowRight size={18} />
                )}
              </button>
            </div>
            <form
              className="join-form"
              onSubmit={(e) => {
                e.preventDefault();
                void enter('join');
              }}
            >
              <label htmlFor="room-code">Have a room code?</label>
              <div>
                <input
                  id="room-code"
                  value={roomInput}
                  maxLength={12}
                  placeholder="XXXXXXXX"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                />
                <button className="secondary" disabled={!!busy || !roomInput.trim()}>
                  {busy === 'join' ? 'Joining…' : 'Join room'}
                  <ArrowRight size={15} />
                </button>
              </div>
            </form>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
          </section>
          <section className="home-board" aria-label="Meet the board">
            <Board state={demo} disabled decorative />
            <p className="home-note">
              <ShieldCheck size={16} /> Real opponents. No accounts. Yours to play.
            </p>
          </section>
        </main>
      )}
      {matching && (
        <main className="match-screen">
          <button className="text-button" onClick={queue.cancel}>
            <ArrowLeft size={16} /> Cancel search
          </button>
          <div className="match-content">
            <div className="matching-pawns" aria-hidden="true">
              <span className="match-pawn a">A</span>
              <span className="match-path" />
              <span className="match-pawn empty">
                <LoaderCircle className="spin" size={24} />
              </span>
            </div>
            <h1>{queue.status}</h1>
            <p>
              You’re in line for a real player.
              <br />
              Your game begins when you’re both connected.
            </p>
            <p className="match-tip">Make a path. Leave them a detour.</p>
            {queue.error && (
              <p role="alert" className="error-message">
                {queue.error}
              </p>
            )}
            <button className="secondary" onClick={queue.cancel}>
              Cancel matchmaking
            </button>
          </div>
        </main>
      )}
      {isGame && (
        <main className="game-page">
          <div className="game-heading">
            <div className="game-context">
              <span>
                {localMode
                  ? 'LOCAL · TWO PLAYERS'
                  : snap?.kind === 'random'
                    ? 'ONLINE · MATCHMADE'
                    : 'ONLINE · PRIVATE ROOM'}
              </span>
              {code && (
                <button
                  className="room-copy"
                  onClick={() => void copy()}
                  aria-label="Copy invitation link"
                >
                  {code}
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              )}
            </div>
            <span className="move-number">
              {state.winner ? 'Round complete' : `Turn ${state.ply + 1}`}
            </span>
          </div>
          <div className={`turn-strip ${state.winner ? 'finished' : ''}`} aria-live="polite">
            <span className={`turn-token ${state.winner ?? state.turn}`}>
              {state.winner ?? state.turn}
            </span>
            <div>
              <h1>{status}</h1>
              <p>
                {state.winner
                  ? state.endReason === 'goal'
                    ? 'The top edge is yours. Well played.'
                    : state.endReason === 'disconnect'
                      ? 'The opponent did not return.'
                      : 'The opponent resigned.'
                  : snap?.status === 'waiting'
                    ? 'Share the link. Meet on the board.'
                    : snap?.status === 'cancelled'
                      ? snap.cancellationReason
                      : online.pending && !localMode
                        ? 'Confirming your action…'
                        : canPlay
                          ? 'Move your pawn or place one two-edge wall.'
                          : 'Both players are racing to the top edge.'}
              </p>
            </div>
            {state.winner && <span className="victory-label">GOOD GAME</span>}
          </div>
          {(error || (!localMode && online.error)) && (
            <div className="error-message game-error" role="alert">
              {error || online.error}
              <button
                className="icon-button"
                aria-label="Dismiss message"
                onClick={() => {
                  setError('');
                  online.setError('');
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="game-layout">
            <Board
              state={state}
              mode={mode}
              orientation={orientation}
              preview={preview}
              onPreview={setPreview}
              onMove={(to) => submit({ type: 'MOVE', to })}
              onWall={place}
              onRotate={rotate}
              disabled={!canPlay}
            />
            <aside className="game-sidebar" aria-label="Game controls">
              <div className="players">
                {(['A', 'B'] as const).map((p) => (
                  <div
                    key={p}
                    className={`player-row ${state.turn === p && !state.winner ? 'current' : ''}`}
                  >
                    <span className={`player-token ${p}`}>{p}</span>
                    <div>
                      <strong>
                        {playerName(p)}
                        {!localMode && snap?.you === p && <small>you</small>}
                      </strong>
                      <span>
                        {localMode
                          ? 'Same screen'
                          : players?.[p]?.connected
                            ? 'Connected'
                            : players?.[p]
                              ? 'Disconnected'
                              : 'Seat open'}
                      </span>
                    </div>
                    <span
                      className={`connection-dot ${players?.[p]?.connected ? 'online' : ''}`}
                      aria-hidden="true"
                    />
                  </div>
                ))}
              </div>
              {state.winner ? (
                <div className="result-actions">
                  <h2>Another way through?</h2>
                  <p>A new board. A new possibility.</p>
                  <button
                    className="primary"
                    disabled={
                      !localMode &&
                      (!online.connected || online.pending || !!snap?.rematch[snap.you])
                    }
                    onClick={() => submit({ type: 'REQUEST_REMATCH' })}
                  >
                    <RotateCw size={17} />
                    {!localMode && snap?.rematch[snap.you] ? 'Rematch requested' : 'Play again'}
                  </button>
                  {!localMode && (
                    <p className="control-hint">
                      {snap?.rematch[other(snap.you)]
                        ? 'Your opponent wants a rematch.'
                        : 'A new round starts when you both agree.'}
                    </p>
                  )}
                  <button className="secondary" onClick={() => navigate('/')}>
                    Back to home
                  </button>
                </div>
              ) : snap?.status === 'waiting' ? (
                <div className="invite-box">
                  <h2>Make it a friendly rivalry.</h2>
                  <p>
                    {snap.kind === 'private'
                      ? 'Send your friend the room link. They can join from any device.'
                      : 'Your opponent is on the way. Keep this page open.'}
                  </p>
                  {snap.kind === 'private' && (
                    <button className="primary" onClick={() => void copy()}>
                      {copied ? <Check size={17} /> : <Copy size={17} />}{' '}
                      {copied ? 'Link copied' : 'Copy invitation'}
                    </button>
                  )}
                  <span className="control-hint">No account needed.</span>
                </div>
              ) : (
                <div className="action-controls">
                  <h2>Your turn, your choice.</h2>
                  <div className="mode-switch" aria-label="Choose an action">
                    <button
                      className={mode === 'move' ? 'selected' : ''}
                      aria-pressed={mode === 'move'}
                      disabled={!canPlay}
                      onClick={() => {
                        setMode('move');
                        setPreview(null);
                        setError('');
                      }}
                    >
                      <MousePointer2 size={17} />
                      Move
                    </button>
                    <button
                      className={mode === 'wall' ? 'selected' : ''}
                      aria-pressed={mode === 'wall'}
                      disabled={!canPlay}
                      onClick={() => {
                        setMode('wall');
                        setPreview({ orientation, row: 6, col: 3 });
                        setError('');
                      }}
                    >
                      <span className="wall-icon" />
                      Wall
                    </button>
                  </div>
                  {mode === 'wall' ? (
                    <div className="wall-controls">
                      <button className="secondary" onClick={rotate} disabled={!canPlay}>
                        <RotateCw size={16} />
                        {orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}
                        <kbd>R</kbd>
                      </button>
                      <p
                        className={`control-hint preview-feedback ${validation && !validation.ok ? 'invalid-text' : ''}`}
                        aria-live="polite"
                      >
                        {validation && !validation.ok
                          ? validation.reason
                          : preview
                            ? 'Two edges. One turn. Ready to place.'
                            : 'Point or tap near a grid intersection.'}
                      </p>
                      <button
                        className="primary"
                        disabled={!canPlay || !preview || !validation?.ok}
                        onClick={() => preview && place(preview)}
                      >
                        Place wall
                        <Check size={17} />
                      </button>
                      <span className="control-hint">
                        Tap to preview, then confirm. Use arrows to adjust with a keyboard.
                      </span>
                    </div>
                  ) : (
                    <p className="control-hint">
                      Choose a highlighted cell. Jump past an adjacent pawn when the way is clear.
                    </p>
                  )}
                  <div className="wall-rule">
                    <span>∞</span>
                    <p>
                      Unlimited walls.
                      <br />
                      <strong>Always leave a way through.</strong>
                    </p>
                  </div>
                </div>
              )}
              {!localMode && snap?.status === 'active' && claimIn !== null && online.connected && (
                <div className="disconnect-panel">
                  <p>Your opponent disconnected.</p>
                  <button
                    className="secondary"
                    disabled={claimIn > 0 || online.pending}
                    onClick={() => submit({ type: 'CLAIM_DISCONNECT_WIN' })}
                  >
                    {claimIn > 0 ? `Claim win in ${claimIn}s` : 'Claim disconnect win'}
                  </button>
                  <small>They can return until you claim.</small>
                </div>
              )}
              {!state.winner && (localMode || snap?.status === 'active') && (
                <button
                  className="text-button resign-button"
                  disabled={!localMode && (!online.connected || online.pending)}
                  onClick={() => setResigning(true)}
                >
                  <Flag size={15} />
                  Resign game
                </button>
              )}
            </aside>
          </div>
        </main>
      )}
      <footer className="site-footer">
        <details id="how-to-play">
          <summary>
            <HelpCircle size={17} /> The rules, in a minute
          </summary>
          <div className="rules-grid">
            <div>
              <h2>Race to the top.</h2>
              <p>
                Both pawns start on the bottom row. A starts at column 3, B at column 7. Be the
                first to reach any square on the top row.
              </p>
            </div>
            <div>
              <h2>Move or make a detour.</h2>
              <p>
                Each turn, move one cell up, down, left or right — or place a wall exactly two edges
                long. You have unlimited walls.
              </p>
            </div>
            <div>
              <h2>Leave a way through.</h2>
              <p>
                Walls may cross or touch, but never overlap an edge or remove either player’s last
                route. Jump over adjacent pawns; sidestep if a wall or board edge blocks the jump.
              </p>
            </div>
          </div>
        </details>
        <div className="footer-line">
          <span>linebreak.</span>
          <span>
            {offline === 'ready'
              ? 'Ready for offline local play.'
              : offline === 'preparing'
                ? 'Preparing offline local play…'
                : offline === 'unavailable'
                  ? 'Offline saving unavailable in this browser.'
                  : 'Small board. Open possibilities.'}
          </span>
        </div>
      </footer>
      {resigning && (
        <Confirm
          title="Leave this round?"
          onCancel={() => setResigning(false)}
          onConfirm={() => {
            submit({ type: 'RESIGN' });
            setResigning(false);
          }}
        >
          The other player wins this round. You can always ask for a rematch.
        </Confirm>
      )}
    </div>
  );
}
