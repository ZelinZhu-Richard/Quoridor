import { describe, expect, it } from 'vitest';
import { applyAction, blockedEdges, detectWinner, hasPath, initializeGame, legalMoves, restoreGame, serializeGame, shortestPath, validateWall, wallEdges, type Wall } from './index';
const h = (row: number, col: number): Wall => ({ orientation: 'horizontal', row, col });
const v = (row: number, col: number): Wall => ({ orientation: 'vertical', row, col });

describe('same-side race', () => {
  it('starts at (8,2)/(8,6), both targeting row zero', () => {
    const s = initializeGame();
    expect(s.pawns).toEqual({ A: { row: 8, col: 2 }, B: { row: 8, col: 6 } });
    expect(detectWinner(s)).toBe(null);
    expect(s.turn).toBe('A');
    expect(legalMoves(s)).toEqual([{ row: 7, col: 2 }, { row: 8, col: 1 }, { row: 8, col: 3 }]);
  });
  it('alternates turns without mutating the original', () => {
    const s = initializeGame(), n = applyAction(s, 'A', { type: 'MOVE', to: { row: 7, col: 2 } });
    expect(n.turn).toBe('B'); expect(n.ply).toBe(1); expect(s.pawns.A.row).toBe(8);
    expect(() => applyAction(n, 'A', { type: 'MOVE', to: { row: 6, col: 2 } })).toThrow('turn');
  });
  it.each(['A', 'B'] as const)('%s wins only at the top', player => {
    const s = initializeGame(); s.turn = player; s.pawns[player] = { row: 1, col: 2 };
    const n = applyAction(s, player, { type: 'MOVE', to: { row: 0, col: 2 } });
    expect(n.winner).toBe(player); expect(n.endReason).toBe('goal'); expect(legalMoves(n)).toEqual([]);
  });
  it('permits either player to resign and forbids further actions', () => {
    const n = applyAction(initializeGame(), 'B', { type: 'RESIGN' });
    expect(n.winner).toBe('A'); expect(() => applyAction(n, 'A', { type: 'RESIGN' })).toThrow('finished');
  });
});
describe('movement', () => {
  it('rejects out of bounds, diagonal movement, and blocked edges', () => {
    const s = initializeGame(); s.walls = [h(7, 1)];
    for (const to of [{ row: 9, col: 2 }, { row: 7, col: 3 }, { row: 7, col: 2 }]) expect(() => applyAction(s, 'A', { type: 'MOVE', to })).toThrow();
  });
  it('jumps over adjacent pawns, never onto them or diagonally when the jump is open', () => {
    const s = initializeGame(); s.pawns.A = { row: 4, col: 4 }; s.pawns.B = { row: 3, col: 4 };
    expect(legalMoves(s)).toContainEqual({ row: 2, col: 4 });
    expect(legalMoves(s)).not.toContainEqual(s.pawns.B);
    expect(legalMoves(s)).not.toContainEqual({ row: 3, col: 3 });
    s.walls = [h(3, 3)]; expect(legalMoves(s)).not.toContainEqual({ row: 2, col: 4 });
  });
  it('sidesteps around a wall behind the opponent, respecting side walls', () => {
    const s = initializeGame(); s.pawns.A = { row: 4, col: 4 }; s.pawns.B = { row: 3, col: 4 }; s.walls = [h(2, 3), v(2, 4)];
    expect(legalMoves(s)).toContainEqual({ row: 3, col: 3 });
    expect(legalMoves(s)).not.toContainEqual({ row: 3, col: 5 });
    expect(legalMoves(s)).not.toContainEqual({ row: 2, col: 4 });
  });
  it('sidesteps around the board boundary in either axis', () => {
    const s = initializeGame(); s.pawns.A = { row: 7, col: 4 }; s.pawns.B = { row: 8, col: 4 };
    expect(legalMoves(s)).toContainEqual({ row: 8, col: 3 }); expect(legalMoves(s)).toContainEqual({ row: 8, col: 5 });
    s.pawns.A = { row: 4, col: 1 }; s.pawns.B = { row: 4, col: 0 };
    expect(legalMoves(s)).toContainEqual({ row: 3, col: 0 }); expect(legalMoves(s)).toContainEqual({ row: 5, col: 0 });
  });
});
describe('rigid two-edge walls', () => {
  it('maps every one of 128 anchors to exactly the correct two edges', () => {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const a = r * 9 + c;
      expect(wallEdges(h(r,c))).toEqual([`${a}:${a+9}`, `${a+1}:${a+10}`]);
      expect(wallEdges(v(r,c))).toEqual([`${a}:${a+1}`, `${a+9}:${a+10}`]);
      expect(validateWall(initializeGame(), h(r,c)).ok).toBe(true);
      expect(validateWall(initializeGame(), v(r,c)).ok).toBe(true);
    }
  });
  it.each([
    { ...h(1,1), length: 1 }, { ...h(1,1), length: 3 },
    { segments: [[1,1,1,2]] }, { segments: [[1,1,1,2],[1,2,1,3],[1,3,1,4]] },
    { segments: [[1,1,1,2],[1,2,2,2]] }, { orientation: 'diagonal', row: 1, col: 1 },
    h(-1,0), h(8,0), v(0,8), h(0.5,1), { ...h(1,1), end: [1,4] },
  ])('rejects noncanonical geometry %j', wall => { expect(validateWall(initializeGame(), wall).ok).toBe(false); });
  it('rejects full and partial overlap but permits crossings and touching', () => {
    const s = initializeGame(); s.walls = [h(3,3)];
    for (const wall of [h(3,3), h(3,2), h(3,4)]) expect(validateWall(s, wall).ok).toBe(false);
    for (const wall of [v(3,3), v(2,2), h(3,5)]) expect(validateWall(s, wall).ok).toBe(true);
    expect(blockedEdges([h(3,3), v(3,3)]).size).toBe(4);
  });
  it.each(['A','B'] as const)('rejects eliminating %s’s final route', player => {
    const s = initializeGame(); const c = s.pawns[player].col;
    s.walls = [v(7,c-1), v(7,c)];
    expect(hasPath(s.pawns[player], s.walls)).toBe(true);
    expect(validateWall(s, h(7,c-1))).toMatchObject({ ok: false, code: 'NO_PATH' });
  });
  it('allows 32 alternating placements and long detours with no wall inventory', () => {
    let s = initializeGame();
    for (let r = 0; r < 8; r++) for (let c = r % 2; c < 8; c += 2) s = applyAction(s, s.turn, { type: 'PLACE_WALL', wall: h(r,c) });
    expect(s.walls).toHaveLength(32); expect(s.ply).toBe(32); expect(s.turn).toBe('A');
    expect(shortestPath(s.pawns.A, s.walls)!.length).toBeGreaterThan(60);
    expect(shortestPath(s.pawns.B, s.walls)!.length).toBeGreaterThan(60);
    expect(restoreGame(serializeGame(s))).toEqual(s);
  });
  it('treats the other pawn as temporary during path validation', () => {
    const s = initializeGame(); s.pawns.A = { row: 8, col: 0 }; s.pawns.B = { row: 7, col: 0 }; s.walls = [v(7,0)];
    expect(hasPath(s.pawns.A, s.walls)).toBe(true);
    expect(validateWall(s, h(4,4)).ok).toBe(true);
  });
  it('rejects corrupted, overlapping, colliding, and old-rules saved states', () => {
    const s = initializeGame();
    expect(() => restoreGame({ ...s, ruleset: 'opposite-sides' })).toThrow();
    expect(() => restoreGame({ ...s, walls: [h(1,1),h(1,2)] })).toThrow();
    expect(() => restoreGame({ ...s, pawns: { A: s.pawns.A, B: s.pawns.A } })).toThrow();
    expect(() => restoreGame({ ...s, winner: 'B' })).toThrow();
  });
});
