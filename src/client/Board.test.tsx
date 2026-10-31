// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initializeGame } from '@linebreak/rules';
import { Board, wallLine } from './Board';
import { loadLocal, saveLocal } from './storage';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
describe('board interaction', () => {
  it('highlights and submits a legal move with keyboard-accessible cells', () => {
    const onMove = vi.fn();
    render(<Board state={initializeGame()} onMove={onMove} />);
    const target = screen.getByRole('gridcell', { name: 'Row 8, column 3, legal move' });
    fireEvent.click(target);
    expect(onMove).toHaveBeenCalledWith({ row: 7, col: 2 });
    fireEvent.click(screen.getByRole('gridcell', { name: 'Row 9, column 7, Player B' }));
    expect(onMove).toHaveBeenCalledTimes(1);
  });
  it('prevents actions while waiting for the server or another player', () => {
    const onMove = vi.fn();
    render(<Board state={initializeGame()} onMove={onMove} disabled />);
    expect(screen.queryByRole('gridcell', { name: /legal move/ })).toBeNull();
    fireEvent.click(screen.getByRole('gridcell', { name: 'Row 8, column 3' }));
    expect(onMove).not.toHaveBeenCalled();
  });
  it('touch selects a preview without immediately consuming the turn', () => {
    const onPreview = vi.fn(),
      onWall = vi.fn();
    render(<Board state={initializeGame()} mode="wall" onPreview={onPreview} onWall={onWall} />);
    const board = screen.getByRole('group');
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 450,
      bottom: 450,
      width: 450,
      height: 450,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(board, { clientX: 200, clientY: 150, pointerType: 'touch' });
    expect(onPreview).toHaveBeenCalledWith({ orientation: 'horizontal', row: 2, col: 3 });
    expect(onWall).not.toHaveBeenCalled();
  });
  it('offers keyboard rotation and anchor adjustment without variable-length geometry', () => {
    const onPreview = vi.fn(),
      onRotate = vi.fn(),
      onWall = vi.fn(),
      preview = { orientation: 'horizontal' as const, row: 4, col: 4 };
    render(
      <Board
        state={initializeGame()}
        mode="wall"
        preview={preview}
        onPreview={onPreview}
        onRotate={onRotate}
        onWall={onWall}
      />,
    );
    const board = screen.getByRole('group');
    fireEvent.keyDown(board, { key: 'r' });
    expect(onRotate).toHaveBeenCalledOnce();
    fireEvent.keyDown(board, { key: 'ArrowLeft' });
    expect(onPreview).toHaveBeenCalledWith({ ...preview, col: 3 });
    fireEvent.keyDown(board, { key: 'Enter' });
    expect(onWall).toHaveBeenCalledWith(preview);
    expect(wallLine(preview)).toEqual({ x1: 40.6, y1: 50, x2: 59.4, y2: 50 });
    expect(wallLine({ ...preview, orientation: 'vertical' })).toEqual({
      x1: 50,
      y1: 40.6,
      x2: 50,
      y2: 59.4,
    });
  });
  it('saves valid local games and recovers from malformed or old-rules saves', () => {
    const state = initializeGame();
    saveLocal(state);
    expect(loadLocal()).toEqual(state);
    localStorage.setItem('linebreak.local', 'bad json');
    expect(loadLocal()).toEqual(state);
    localStorage.setItem('linebreak.local', JSON.stringify({ ...state, ruleset: 'opposite-side' }));
    expect(loadLocal()).toEqual(state);
  });
});
