import { z } from 'zod';

export const SIZE = 9;
export const GOAL_ROW = 0;
export const RULESET = 'linebreak-same-side-v1';
export const playerSchema = z.enum(['A', 'B']);
export type Player = z.infer<typeof playerSchema>;
export const positionSchema = z.strictObject({ row: z.number().int().min(0).max(8), col: z.number().int().min(0).max(8) });
export type Position = z.infer<typeof positionSchema>;
export const wallSchema = z.strictObject({ orientation: z.enum(['horizontal', 'vertical']), row: z.number().int().min(0).max(7), col: z.number().int().min(0).max(7) });
export type Wall = z.infer<typeof wallSchema>;
export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('MOVE'), to: positionSchema }),
  z.strictObject({ type: z.literal('PLACE_WALL'), wall: wallSchema }),
  z.strictObject({ type: z.literal('RESIGN') }),
]);
export type GameAction = z.infer<typeof actionSchema>;
export const gameSchema = z.strictObject({
  schemaVersion: z.literal(1), ruleset: z.literal(RULESET),
  pawns: z.strictObject({ A: positionSchema, B: positionSchema }),
  walls: z.array(wallSchema).max(72), turn: playerSchema,
  winner: playerSchema.nullable(),
  endReason: z.enum(['goal', 'resignation', 'disconnect']).nullable(),
  ply: z.number().int().nonnegative(),
});
export type GameState = z.infer<typeof gameSchema>;
export type Validation = { ok: true } | { ok: false; code: string; reason: string };
export class RuleError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function other(player: Player): Player { return player === 'A' ? 'B' : 'A'; }
export function same(a: Position, b: Position) { return a.row === b.row && a.col === b.col; }
export function inBounds(p: Position) { return Number.isInteger(p.row) && Number.isInteger(p.col) && p.row >= 0 && p.row < SIZE && p.col >= 0 && p.col < SIZE; }
export function initializeGame(): GameState {
  return { schemaVersion: 1, ruleset: RULESET, pawns: { A: { row: 8, col: 2 }, B: { row: 8, col: 6 } }, walls: [], turn: 'A', winner: null, endReason: null, ply: 0 };
}
export function edgeKey(a: Position, b: Position): string {
  const x = a.row * SIZE + a.col, y = b.row * SIZE + b.col;
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}
export function wallEdges(input: Wall): [string, string] {
  const { row: r, col: c, orientation } = wallSchema.parse(input);
  return orientation === 'horizontal'
    ? [edgeKey({ row: r, col: c }, { row: r + 1, col: c }), edgeKey({ row: r, col: c + 1 }, { row: r + 1, col: c + 1 })]
    : [edgeKey({ row: r, col: c }, { row: r, col: c + 1 }), edgeKey({ row: r + 1, col: c }, { row: r + 1, col: c + 1 })];
}
export function blockedEdges(walls: readonly Wall[]): Set<string> { return new Set(walls.flatMap(wallEdges)); }
const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
function step(p: Position, dr: number, dc: number): Position { return { row: p.row + dr, col: p.col + dc }; }
function open(a: Position, b: Position, blocked: Set<string>) { return inBounds(b) && !blocked.has(edgeKey(a, b)); }

/** Ordinary graph reachability deliberately ignores the other pawn. */
export function shortestPath(start: Position, walls: readonly Wall[]): Position[] | null {
  if (!inBounds(start)) return null;
  const blocked = blockedEdges(walls), queue = [start];
  const key = (p: Position) => p.row * SIZE + p.col;
  const parents = new Map<number, Position | null>([[key(start), null]]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (p.row === GOAL_ROW) {
      const path: Position[] = [];
      for (let current: Position | null = p; current; current = parents.get(key(current)) ?? null) path.push(current);
      return path.reverse();
    }
    for (const [dr, dc] of directions) {
      const next = step(p, dr, dc);
      if (open(p, next, blocked) && !parents.has(key(next))) { parents.set(key(next), p); queue.push(next); }
    }
  }
  return null;
}
export function hasPath(start: Position, walls: readonly Wall[]) { return shortestPath(start, walls) !== null; }
export function legalMoves(state: GameState, player: Player = state.turn): Position[] {
  if (state.winner) return [];
  const from = state.pawns[player], opponent = state.pawns[other(player)], blocked = blockedEdges(state.walls);
  const result: Position[] = [];
  const add = (p: Position) => { if (!result.some(q => same(p, q))) result.push(p); };
  for (const [dr, dc] of directions) {
    const next = step(from, dr, dc);
    if (!open(from, next, blocked)) continue;
    if (!same(next, opponent)) { add(next); continue; }
    const behind = step(opponent, dr, dc);
    if (open(opponent, behind, blocked)) { add(behind); continue; }
    for (const sign of [-1, 1]) {
      const side = step(opponent, dc * sign, dr * sign);
      if (open(opponent, side, blocked)) add(side);
    }
  }
  return result;
}
export function validateWall(state: GameState, input: unknown): Validation {
  const parsed = wallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'WALL_GEOMETRY', reason: 'Use one straight two-edge wall at an internal intersection.' };
  if (state.winner) return { ok: false, code: 'GAME_OVER', reason: 'This round has finished.' };
  const occupied = blockedEdges(state.walls);
  if (wallEdges(parsed.data).some(edge => occupied.has(edge))) return { ok: false, code: 'WALL_OVERLAP', reason: 'That wall overlaps an existing wall edge.' };
  const walls = [...state.walls, parsed.data];
  for (const player of ['A', 'B'] as const) {
    if (!hasPath(state.pawns[player], walls)) return { ok: false, code: 'NO_PATH', reason: `Player ${player} must keep a route to the top edge.` };
  }
  return { ok: true };
}
export function detectWinner(state: Pick<GameState, 'pawns'>): Player | null {
  return state.pawns.A.row === GOAL_ROW ? 'A' : state.pawns.B.row === GOAL_ROW ? 'B' : null;
}
export function applyAction(state: GameState, player: Player, input: unknown): GameState {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) throw new RuleError('BAD_ACTION', 'That action is not valid.');
  if (state.winner) throw new RuleError('GAME_OVER', 'This round has finished.');
  const action = parsed.data;
  // Either player can resign, even while the other player has the turn.
  if (action.type === 'RESIGN') return { ...state, winner: other(player), endReason: 'resignation' };
  if (state.turn !== player) throw new RuleError('NOT_YOUR_TURN', 'Wait for your turn.');
  let next: GameState;
  if (action.type === 'MOVE') {
    if (!legalMoves(state, player).some(p => same(p, action.to))) throw new RuleError('ILLEGAL_MOVE', 'Choose a highlighted destination.');
    next = { ...state, pawns: { ...state.pawns, [player]: action.to } };
  } else {
    const validation = validateWall(state, action.wall);
    if (!validation.ok) throw new RuleError(validation.code, validation.reason);
    next = { ...state, walls: [...state.walls, action.wall] };
  }
  const winner = detectWinner(next);
  return { ...next, turn: other(player), ply: state.ply + 1, winner, endReason: winner ? 'goal' : null };
}
export function restoreGame(input: unknown): GameState {
  const state = gameSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
  if (same(state.pawns.A, state.pawns.B)) throw new RuleError('INVALID_STATE', 'Pawns cannot share a cell.');
  const edges = state.walls.flatMap(wallEdges);
  if (new Set(edges).size !== edges.length) throw new RuleError('INVALID_STATE', 'Walls overlap.');
  if (!hasPath(state.pawns.A, state.walls) || !hasPath(state.pawns.B, state.walls)) throw new RuleError('INVALID_STATE', 'Both players need a route to row 0.');
  const goalWinner = detectWinner(state);
  if ((state.winner === null) !== (state.endReason === null)
    || (goalWinner && (state.endReason !== 'goal' || state.winner !== goalWinner))
    || (state.endReason === 'goal' && state.winner !== goalWinner)) throw new RuleError('INVALID_STATE', 'Invalid victory state.');
  return state;
}
export function serializeGame(state: GameState): string { return JSON.stringify(restoreGame(state)); }
