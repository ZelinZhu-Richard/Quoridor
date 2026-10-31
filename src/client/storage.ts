import { initializeGame, restoreGame, serializeGame, type GameState } from '@linebreak/rules';
export function readText(key: string, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeText(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private browsing/storage exhaustion: current game remains playable. */
  }
}
export function loadLocal(): GameState {
  try {
    const raw = readText('linebreak.local');
    return raw ? restoreGame(raw) : initializeGame();
  } catch {
    return initializeGame();
  }
}
export function saveLocal(state: GameState) {
  writeText('linebreak.local', serializeGame(state));
}
