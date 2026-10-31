import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  legalMoves,
  same,
  validateWall,
  type GameState,
  type Position,
  type Wall,
} from '@linebreak/rules';

type Props = {
  state: GameState;
  mode?: 'move' | 'wall';
  orientation?: Wall['orientation'];
  preview?: Wall | null;
  onPreview?: (wall: Wall | null) => void;
  onMove?: (p: Position) => void;
  onWall?: (w: Wall) => void;
  onRotate?: () => void;
  disabled?: boolean;
  decorative?: boolean;
};
/** The SVG uses grid lines at integer multiples of 10; every wall spans exactly two cells. */
export function wallLine(w: Wall) {
  return w.orientation === 'horizontal'
    ? {
        x1: w.col * 10 + 0.6,
        y1: (w.row + 1) * 10,
        x2: (w.col + 2) * 10 - 0.6,
        y2: (w.row + 1) * 10,
      }
    : {
        x1: (w.col + 1) * 10,
        y1: w.row * 10 + 0.6,
        x2: (w.col + 1) * 10,
        y2: (w.row + 2) * 10 - 0.6,
      };
}
export function Board({
  state,
  mode = 'move',
  orientation = 'horizontal',
  preview,
  onPreview,
  onMove,
  onWall,
  onRotate,
  disabled,
  decorative,
}: Props) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [focusCell, setFocusCell] = useState(state.pawns[state.turn]);
  const moves = disabled || mode === 'wall' ? [] : legalMoves(state);
  const validation = preview ? validateWall(state, preview) : null;
  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = boardRef.current!.getBoundingClientRect();
    const col = Math.max(
      0,
      Math.min(7, Math.round(((event.clientX - rect.left) / rect.width) * 9) - 1),
    );
    const row = Math.max(
      0,
      Math.min(7, Math.round(((event.clientY - rect.top) / rect.height) * 9) - 1),
    );
    return { orientation, row, col };
  };
  const keyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || decorative) return;
    if (e.key.toLowerCase() === 'r') {
      onRotate?.();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      onPreview?.(null);
      return;
    }
    if (mode === 'wall') {
      const anchor = preview ?? { orientation, row: 6, col: 3 };
      const delta: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      if (delta[e.key]) {
        e.preventDefault();
        const [dr, dc] = delta[e.key];
        onPreview?.({
          ...anchor,
          orientation,
          row: Math.max(0, Math.min(7, anchor.row + dr)),
          col: Math.max(0, Math.min(7, anchor.col + dc)),
        });
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (preview) onWall?.(preview);
        else onPreview?.(anchor);
      }
    }
  };
  return (
    <div className={`board-wrap ${decorative ? 'board-decorative' : ''}`}>
      <div className="goal-edge">
        <span>THE FINISH LINE</span>
        <span>Both players race here</span>
      </div>
      <div
        ref={boardRef}
        className={`board ${mode === 'wall' && !disabled ? 'wall-mode' : ''}`}
        role={decorative ? 'img' : 'group'}
        aria-label={
          decorative
            ? 'A nine by nine board. Both pawns start along the bottom edge.'
            : 'Game board. Both players race to the top row.'
        }
        tabIndex={!decorative && mode === 'wall' ? 0 : undefined}
        onKeyDown={keyboard}
        onPointerMove={(e) => {
          if (mode === 'wall' && !disabled && e.pointerType === 'mouse')
            onPreview?.(selectFromPointer(e));
        }}
        onPointerDown={(e) => {
          if (mode !== 'wall' || disabled || decorative) return;
          const w = selectFromPointer(e);
          onPreview?.(w);
          if (e.pointerType === 'mouse') onWall?.(w);
        }}
      >
        <div
          className="cells"
          role={decorative ? undefined : 'grid'}
          aria-label={decorative ? undefined : 'Board cells'}
        >
          {Array.from({ length: 9 }, (_, row) => (
            <div role={decorative ? undefined : 'row'} className="cell-row" key={row}>
              {Array.from({ length: 9 }, (_, col) => {
                const p = { row, col },
                  pawn = same(p, state.pawns.A) ? 'A' : same(p, state.pawns.B) ? 'B' : null;
                const legal = moves.some((m) => same(m, p));
                return (
                  <button
                    key={col}
                    role={decorative ? undefined : 'gridcell'}
                    className={`cell ${legal ? 'legal' : ''} ${pawn ? `occupied ${pawn.toLowerCase()}` : ''}`}
                    tabIndex={decorative || mode === 'wall' ? -1 : same(focusCell, p) ? 0 : -1}
                    aria-label={`Row ${row + 1}, column ${col + 1}${pawn ? `, Player ${pawn}` : legal ? ', legal move' : ''}`}
                    aria-disabled={disabled || !legal}
                    onFocus={() => setFocusCell(p)}
                    onClick={() => {
                      if (legal && !disabled) onMove?.(p);
                    }}
                    onKeyDown={(e) => {
                      const d: Record<string, [number, number]> = {
                        ArrowUp: [-1, 0],
                        ArrowDown: [1, 0],
                        ArrowLeft: [0, -1],
                        ArrowRight: [0, 1],
                      };
                      if (mode !== 'move' || !d[e.key]) return;
                      e.preventDefault();
                      const [dr, dc] = d[e.key],
                        r = Math.max(0, Math.min(8, row + dr)),
                        c = Math.max(0, Math.min(8, col + dc));
                      const buttons =
                        boardRef.current!.querySelectorAll<HTMLButtonElement>('.cell');
                      buttons[r * 9 + c].focus();
                    }}
                  >
                    <span className="move-dot" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <svg className="board-drawing" viewBox="0 0 90 90" aria-hidden="true">
          {state.walls.map((wall, i) => (
            <line key={i} {...wallLine(wall)} className="placed-wall" />
          ))}
          {preview && !disabled && mode === 'wall' && (
            <line
              {...wallLine(preview)}
              className={`preview-wall ${validation?.ok ? 'valid' : 'invalid'}`}
            />
          )}
          {(['A', 'B'] as const).map((player) => (
            <g
              key={player}
              className={`pawn pawn-${player.toLowerCase()}`}
              style={{
                transform: `translate(${state.pawns[player].col * 10 + 5}px, ${state.pawns[player].row * 10 + 5}px)`,
              }}
            >
              {player === 'A' ? (
                <circle r="3.35" />
              ) : (
                <rect x="-3.1" y="-3.1" width="6.2" height="6.2" rx="1.15" />
              )}
              <text y="0.15" dominantBaseline="middle" textAnchor="middle">
                {player}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="board-caption">
        <span>9 × 9</span>
        <span>Move a pawn. Place a wall. Find a way.</span>
        <span>∞ walls</span>
      </div>
    </div>
  );
}
